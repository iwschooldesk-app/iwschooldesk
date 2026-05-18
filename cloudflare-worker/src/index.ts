/**
 * SchoolDesk 급식 프록시 Worker.
 *
 * 목적: 같은 학교 사용자들이 한 번 받은 급식 데이터를 KV 에 캐싱해 NEIS API 부담을 줄이고,
 *       앱 사용자가 NEIS 인증키를 직접 발급받지 않아도 되게 한다.
 *
 * 캐시 정책:
 *   - 학교 검색: 7일 (학교 정보는 거의 안 바뀜)
 *   - 급식 정보: 25시간 (오늘 데이터 그대로, 자정 넘기면 새로 fetch)
 *
 * 보안:
 *   - 입력 검증: 길이/형식 정규식 (DoS, KV key 폭증 방어)
 *   - Rate limit: IP 분당 30회 (in-memory, isolate별 분산)
 *   - 에러 메시지 sanitize (내부 정보 노출 방지)
 */
export interface Env {
  CACHE: KVNamespace
  NEIS_API_KEY?: string  // 운영 인증키 (Worker secret 으로만 저장)
  AIR_KOREA_KEY?: string // 한국환경공단(에어코리아) data.go.kr 인증키 (Worker secret)
}

const NEIS_BASE = 'https://open.neis.go.kr/hub'

interface NeisRow { [k: string]: string }
interface NeisSection { head?: unknown; row?: NeisRow[] }

// ─── 입력 검증 ──────────────────────────────────────
const SCHOOL_NAME_MAX = 50
// 한글·영문·숫자·공백·일부 기호 (학교명에 자주 등장: 괄호, 점, 가운뎃점, 하이픈)
const SCHOOL_NAME_RE = /^[가-힣a-zA-Z0-9\s\-_().·]+$/
const SC_CODE_RE = /^[A-Z]\d{2}$/        // 예: B10
const SCHOOL_CODE_RE = /^\d{7,8}$/        // 예: 7081418
const DATE_RE = /^\d{4}-?\d{2}-?\d{2}$/   // YYYY-MM-DD 또는 YYYYMMDD

function validateName(s: string | null | undefined): string | null {
  if (!s) return 'name required'
  const v = s.trim()
  if (v.length === 0) return 'name required'
  if (v.length > SCHOOL_NAME_MAX) return 'name too long'
  if (!SCHOOL_NAME_RE.test(v)) return 'invalid characters in name'
  return null
}
function validateScCode(s: string | null | undefined): string | null {
  if (!s) return 'scCode required'
  if (!SC_CODE_RE.test(s.trim())) return 'invalid scCode'
  return null
}
function validateSchoolCode(s: string | null | undefined): string | null {
  if (!s) return 'schoolCode required'
  if (!SCHOOL_CODE_RE.test(s.trim())) return 'invalid schoolCode'
  return null
}
function validateDate(s: string | null | undefined): string | null {
  if (!s) return 'date required'
  if (!DATE_RE.test(s.trim())) return 'invalid date format'
  return null
}

// ─── Rate limit (in-memory, isolate별) ──────────────
const RATE_WINDOW_MS = 60_000
const RATE_MAX_PER_IP = 10  // 정상 사용은 30분에 1회. 10회/분이면 사용자 직접 새로고침 여유 + 봇 차단.
const rateMap = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string | null): boolean {
  if (!ip) return true  // IP 못 알면 통과 (Cloudflare DDoS 보호 의존)
  const now = Date.now()
  const cur = rateMap.get(ip)
  if (!cur || cur.resetAt < now) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    // 메모리 누수 방어 — Map 크기가 너무 커지면 오래된 항목 GC
    if (rateMap.size > 10000) {
      for (const [k, v] of rateMap) if (v.resetAt < now) rateMap.delete(k)
    }
    return true
  }
  if (cur.count >= RATE_MAX_PER_IP) return false
  cur.count++
  return true
}

// ─── 응답 ──────────────────────────────────────────
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
  })
}

// ─── NEIS 호출 ─────────────────────────────────────
async function fetchSchoolInfo(name: string, env: Env): Promise<unknown[]> {
  const params = new URLSearchParams({
    Type: 'json', pIndex: '1', pSize: '20', SCHUL_NM: name,
  })
  if (env.NEIS_API_KEY) params.set('KEY', env.NEIS_API_KEY)
  const r = await fetch(`${NEIS_BASE}/schoolInfo?${params}`, {
    cf: { cacheTtl: 60, cacheEverything: true },
  })
  const data = await r.json() as Record<string, unknown>
  const arr = data.schoolInfo as NeisSection[] | undefined
  if (!Array.isArray(arr)) return []
  const rows = arr.find((s) => s.row)?.row ?? []
  return rows.map((r) => ({
    scCode: r.ATPT_OFCDC_SC_CODE,
    schoolCode: r.SD_SCHUL_CODE,
    name: r.SCHUL_NM,
    type: r.SCHUL_KND_SC_NM,
    address: r.ORG_RDNMA,
  }))
}

// ─── 에어코리아(한국환경공단) 호출 ────────────────────
const AIRKOREA_BASE = 'http://apis.data.go.kr/B552584/ArpltnInforInqireSvc'

/** 한국 76개 도시 → 시도명 + 측정소 매칭 키워드 우선순위.
 *  에어코리아 stationName 은 동/면/읍 단위라(예: 김제시 = "요촌동/계화면/광활면") 시군구명만으론 매칭 X.
 *  stationKeywords 는 우선순위 — 앞에서부터 시도별 응답에서 stationName.includes() 매칭. */
interface CityMap { name: string; sido: string; stationKeywords: string[] }
const CITY_TO_SIDO: ReadonlyArray<CityMap> = [
  // 광역시 — 시청/구청 소재지 동
  { name: '서울', sido: '서울', stationKeywords: ['중구', '종로구', '용산구'] },
  { name: '부산', sido: '부산', stationKeywords: ['광복동', '연제구', '중구'] },
  { name: '인천', sido: '인천', stationKeywords: ['신흥동', '구월동', '중구'] },
  { name: '대구', sido: '대구', stationKeywords: ['수창동', '중구', '동구'] },
  { name: '대전', sido: '대전', stationKeywords: ['문창동', '둔산동', '중구'] },
  { name: '광주', sido: '광주', stationKeywords: ['농성동', '서석동', '광산구'] },
  { name: '울산', sido: '울산', stationKeywords: ['신정동', '여천동', '남구'] },
  { name: '세종', sido: '세종', stationKeywords: ['아름동', '한솔동', '전의면'] },
  // 경기 — 도시별 도심 동 (대표 측정소 우선)
  { name: '수원', sido: '경기', stationKeywords: ['신풍동(수원)', '인계동', '영통구', '수원'] },
  { name: '성남', sido: '경기', stationKeywords: ['수정구', '복정동', '분당구', '성남'] },
  { name: '용인', sido: '경기', stationKeywords: ['김량장동', '신갈동', '기흥구', '용인'] },
  { name: '고양', sido: '경기', stationKeywords: ['주엽동', '백석동', '일산서구', '고양'] },
  { name: '안양', sido: '경기', stationKeywords: ['만안구', '비산동', '안양'] },
  { name: '안산', sido: '경기', stationKeywords: ['고잔동', '원곡동', '단원구', '안산'] },
  { name: '부천', sido: '경기', stationKeywords: ['오정동', '중동', '부천'] },
  { name: '의정부', sido: '경기', stationKeywords: ['의정부1동', '의정부'] },
  { name: '평택', sido: '경기', stationKeywords: ['평택항', '비전동', '평택'] },
  { name: '시흥', sido: '경기', stationKeywords: ['정왕본동', '대야동', '시흥'] },
  { name: '파주', sido: '경기', stationKeywords: ['금촌동', '운정동', '파주'] },
  { name: '김포', sido: '경기', stationKeywords: ['사우동', '풍무동', '김포'] },
  { name: '광명', sido: '경기', stationKeywords: ['소하동', '철산동', '광명'] },
  { name: '하남', sido: '경기', stationKeywords: ['신장동', '미사동', '하남'] },
  { name: '구리', sido: '경기', stationKeywords: ['교문동', '구리'] },
  { name: '남양주', sido: '경기', stationKeywords: ['호평동', '평내동', '남양주'] },
  { name: '오산', sido: '경기', stationKeywords: ['오산동', '대원동', '오산'] },
  { name: '이천', sido: '경기', stationKeywords: ['중리동', '이천'] },
  { name: '양주', sido: '경기', stationKeywords: ['덕정동', '양주'] },
  { name: '동두천', sido: '경기', stationKeywords: ['생연동', '동두천'] },
  { name: '가평', sido: '경기', stationKeywords: ['가평읍', '가평'] },
  { name: '여주', sido: '경기', stationKeywords: ['여흥동', '여주'] },
  // 강원
  { name: '춘천', sido: '강원', stationKeywords: ['석사동', '근화동', '춘천'] },
  { name: '원주', sido: '강원', stationKeywords: ['명륜동', '단계동', '원주'] },
  { name: '강릉', sido: '강원', stationKeywords: ['옥천동', '주문진', '강릉'] },
  { name: '동해', sido: '강원', stationKeywords: ['천곡동', '동해'] },
  { name: '속초', sido: '강원', stationKeywords: ['청호동', '속초'] },
  { name: '삼척', sido: '강원', stationKeywords: ['교동', '삼척'] },
  { name: '태백', sido: '강원', stationKeywords: ['황지동', '태백'] },
  // 충북
  { name: '청주', sido: '충북', stationKeywords: ['용암동', '복대동', '오송읍', '청주'] },
  { name: '충주', sido: '충북', stationKeywords: ['칠금동', '충주'] },
  { name: '제천', sido: '충북', stationKeywords: ['장락동', '제천'] },
  // 충남
  { name: '천안', sido: '충남', stationKeywords: ['성정동', '쌍용동', '두정동', '천안'] },
  { name: '아산', sido: '충남', stationKeywords: ['모종동', '온양동', '아산'] },
  { name: '공주', sido: '충남', stationKeywords: ['금흥동', '공주'] },
  { name: '보령', sido: '충남', stationKeywords: ['대천동', '보령'] },
  { name: '서산', sido: '충남', stationKeywords: ['동문동', '대산읍', '서산'] },
  { name: '논산', sido: '충남', stationKeywords: ['취암동', '논산'] },
  { name: '당진', sido: '충남', stationKeywords: ['읍내동', '당진'] },
  // 전북 — 김제 정밀 매핑 (확인된 실제 측정소: 요촌동/계화면/광활면)
  { name: '전주', sido: '전북', stationKeywords: ['효자동', '서신동', '송천동', '팔복동', '여의동', '혁신동', '전주'] },
  { name: '익산', sido: '전북', stationKeywords: ['모현동', '송학동', '익산'] },
  { name: '군산', sido: '전북', stationKeywords: ['신풍동(군산)', '소룡동', '구암동', '군산'] },
  { name: '정읍', sido: '전북', stationKeywords: ['연지동', '정읍'] },
  { name: '남원', sido: '전북', stationKeywords: ['도통동', '남원'] },
  { name: '김제', sido: '전북', stationKeywords: ['요촌동', '계화면', '광활면', '김제'] },
  // 전남
  { name: '여수', sido: '전남', stationKeywords: ['삼일동', '여천동', '여수'] },
  { name: '순천', sido: '전남', stationKeywords: ['장천동', '연향동', '순천'] },
  { name: '목포', sido: '전남', stationKeywords: ['용해동', '석현동', '목포'] },
  { name: '광양', sido: '전남', stationKeywords: ['중동', '광양읍', '광양'] },
  { name: '나주', sido: '전남', stationKeywords: ['빛가람동', '송월동', '나주'] },
  // 경북
  { name: '포항', sido: '경북', stationKeywords: ['장량동', '대송면', '청림동', '포항'] },
  { name: '경주', sido: '경북', stationKeywords: ['용강동', '성건동', '경주'] },
  { name: '안동', sido: '경북', stationKeywords: ['옥동', '강남동', '안동'] },
  { name: '구미', sido: '경북', stationKeywords: ['공단동', '상모사곡동', '구미'] },
  { name: '김천', sido: '경북', stationKeywords: ['평화동', '김천'] },
  { name: '문경', sido: '경북', stationKeywords: ['모전동', '점촌', '문경'] },
  { name: '상주', sido: '경북', stationKeywords: ['남성동', '상주'] },
  { name: '영주', sido: '경북', stationKeywords: ['휴천동', '영주'] },
  { name: '영천', sido: '경북', stationKeywords: ['완산동', '영천'] },
  { name: '경산', sido: '경북', stationKeywords: ['중방동', '경산'] },
  // 경남
  { name: '창원', sido: '경남', stationKeywords: ['반송동', '명서동', '의창구', '창원'] },
  { name: '진주', sido: '경남', stationKeywords: ['상대동', '평거동', '진주'] },
  { name: '통영', sido: '경남', stationKeywords: ['무전동', '통영'] },
  { name: '사천', sido: '경남', stationKeywords: ['벌용동', '사천'] },
  { name: '김해', sido: '경남', stationKeywords: ['장유3동', '내외동', '김해'] },
  { name: '밀양', sido: '경남', stationKeywords: ['내일동', '밀양'] },
  { name: '거제', sido: '경남', stationKeywords: ['옥포동', '고현동', '거제'] },
  { name: '양산', sido: '경남', stationKeywords: ['중앙동', '물금읍', '양산'] },
  // 제주
  { name: '제주', sido: '제주', stationKeywords: ['이도동', '연동', '노형동', '제주'] },
  { name: '서귀포', sido: '제주', stationKeywords: ['동홍동', '대정읍', '서귀포'] },
]

/** 주소 / 도시명으로 KOREAN_CITIES_WORKER 매칭. 못 찾으면 null. */
function findCityByName(cityName: string): CityMap | null {
  // 길이 내림차순 정렬 — '서귀포'가 '제주'보다 먼저
  const sorted = [...CITY_TO_SIDO].sort((a, b) => b.name.length - a.name.length)
  for (const c of sorted) {
    if (cityName.includes(c.name)) return c
  }
  return null
}

interface AirRow { stationName?: string; pm10Value?: string; pm25Value?: string; dataTime?: string }
interface AirResult { pm10: number | null; pm25: number | null; station: string | null; dataTime: string | null; source: 'airkorea' | 'fallback' }

async function fetchAirQualityFromAirKorea(cityName: string, env: Env): Promise<AirResult | null> {
  if (!env.AIR_KOREA_KEY) return null
  const city = findCityByName(cityName)
  if (!city) return null

  const params = new URLSearchParams({
    serviceKey: env.AIR_KOREA_KEY,
    returnType: 'json',
    numOfRows: '200',
    pageNo: '1',
    sidoName: city.sido,
    ver: '1.0',
  })
  try {
    const r = await fetch(`${AIRKOREA_BASE}/getCtprvnRltmMesureDnsty?${params}`, {
      cf: { cacheTtl: 60, cacheEverything: true },
    })
    if (!r.ok) return null
    const data = await r.json() as { response?: { body?: { items?: AirRow[] } } }
    const items = data.response?.body?.items
    if (!Array.isArray(items) || items.length === 0) return null

    const parseNum = (v: string | undefined): number | null => {
      if (!v || v === '-' || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }

    // 1) stationKeywords 우선순위 매칭 — 앞에서부터 시도. 첫 매칭이 통신장애('-')이면 다음 키워드.
    //    pm10/pm25 둘 다 null 인 측정소는 skip 하고 다음 후보로.
    for (const kw of city.stationKeywords) {
      const candidates = items.filter((x) => x.stationName?.includes(kw))
      for (const m of candidates) {
        const pm10 = parseNum(m.pm10Value)
        const pm25 = parseNum(m.pm25Value)
        if (pm10 !== null || pm25 !== null) {
          return {
            pm10, pm25,
            station: m.stationName ?? null,
            dataTime: m.dataTime ?? null,
            source: 'airkorea',
          }
        }
      }
    }
    // 2) 매칭 측정소 없으면 시도 전체 평균
    const valid = items
      .map((x) => ({ pm10: parseNum(x.pm10Value), pm25: parseNum(x.pm25Value) }))
      .filter((x) => x.pm10 !== null || x.pm25 !== null)
    if (valid.length === 0) return null
    const avg = (arr: (number | null)[]): number | null => {
      const nums = arr.filter((n): n is number => n !== null)
      if (nums.length === 0) return null
      return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length)
    }
    return {
      pm10: avg(valid.map((x) => x.pm10)),
      pm25: avg(valid.map((x) => x.pm25)),
      station: `${city.sido} 평균(${valid.length}개소)`,
      dataTime: items[0]?.dataTime ?? null,
      source: 'airkorea',
    }
  } catch {
    return null
  }
}

async function fetchMealInfo(scCode: string, schoolCode: string, ymd: string, env: Env): Promise<unknown[]> {
  const ymdClean = ymd.replace(/-/g, '')
  const params = new URLSearchParams({
    Type: 'json', pIndex: '1', pSize: '20',
    ATPT_OFCDC_SC_CODE: scCode, SD_SCHUL_CODE: schoolCode, MLSV_YMD: ymdClean,
  })
  if (env.NEIS_API_KEY) params.set('KEY', env.NEIS_API_KEY)
  const r = await fetch(`${NEIS_BASE}/mealServiceDietInfo?${params}`, {
    cf: { cacheTtl: 60, cacheEverything: true },
  })
  const data = await r.json() as Record<string, unknown>
  const arr = data.mealServiceDietInfo as NeisSection[] | undefined
  if (!Array.isArray(arr)) return []
  const rows = arr.find((s) => s.row)?.row ?? []
  const dateStr = ymdClean.length === 8
    ? `${ymdClean.slice(0, 4)}-${ymdClean.slice(4, 6)}-${ymdClean.slice(6, 8)}`
    : ymdClean
  return rows.map((r) => {
    const rawText = r.DDISH_NM ?? ''
    const dishes = rawText
      .split(/<br\s*\/?>/i)
      .map((s) => s.replace(/\s*\([0-9.\s]+\)\s*$/, '').trim())
      .filter(Boolean)
    return {
      date: dateStr,
      mealType: r.MMEAL_SC_NM ?? '중식',
      dishes,
      // rawText 는 응답에서 제거 — 클라이언트가 dangerouslySetInnerHTML 로 잘못 쓸 가능성 차단.
      calInfo: r.CAL_INFO,
    }
  })
}

// ─── 라우터 ────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405)

    // Rate limit
    const ip = req.headers.get('CF-Connecting-IP')
    if (!checkRateLimit(ip)) return json({ error: 'rate limit exceeded' }, 429)

    const url = new URL(req.url)

    try {
      // 학교 검색 ─ /school?name=한가람초
      if (url.pathname === '/school') {
        const name = url.searchParams.get('name')
        const err = validateName(name)
        if (err) return json({ error: err }, 400)
        const trimmed = name!.trim()
        // v2: rawText 제거 + 입력검증 추가된 응답 스키마.
        const cacheKey = `school:v2:${trimmed.toLowerCase()}`
        const cached = await env.CACHE.get(cacheKey, 'json')
        if (cached) return json(cached)
        const result = await fetchSchoolInfo(trimmed, env)
        await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 7 * 24 * 3600 })
        return json(result)
      }

      // 급식 ─ /meal?scCode=B10&schoolCode=7010001&date=2026-04-27
      if (url.pathname === '/meal') {
        const scCode = url.searchParams.get('scCode')
        const schoolCode = url.searchParams.get('schoolCode')
        const date = url.searchParams.get('date')
        const errs = [validateScCode(scCode), validateSchoolCode(schoolCode), validateDate(date)].filter(Boolean)
        if (errs.length) return json({ error: errs[0] }, 400)
        const sc = scCode!.trim()
        const sch = schoolCode!.trim()
        const dt = date!.trim()
        const ymdClean = dt.replace(/-/g, '')
        // v2: rawText 제거된 응답 스키마.
        const cacheKey = `meal:v2:${sc}:${sch}:${ymdClean}`
        const cached = await env.CACHE.get(cacheKey, 'json')
        if (cached) return json(cached)
        const result = await fetchMealInfo(sc, sch, dt, env)
        await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 25 * 3600 })
        return json(result)
      }

      // 미세먼지 ─ /airquality?city=김제
      // 좌표 대신 도시명을 받음(클라이언트가 76개 도시 목록 중 선택한 결과). 10분 TTL 캐시.
      if (url.pathname === '/airquality') {
        const cityName = url.searchParams.get('city')
        if (!cityName) return json({ error: 'city required' }, 400)
        const trimmed = cityName.trim()
        if (trimmed.length === 0 || trimmed.length > 20) return json({ error: 'invalid city' }, 400)
        if (!/^[가-힣]+$/.test(trimmed)) return json({ error: 'invalid city characters' }, 400)
        const cacheKey = `air:v2:${trimmed}`
        const cached = await env.CACHE.get(cacheKey, 'json')
        if (cached) return json(cached)
        const result = await fetchAirQualityFromAirKorea(trimmed, env)
        if (result) {
          // 60분 캐시 — 에어코리아 자체가 1시간 갱신 + 사용자 클라이언트가 30분마다 fetch 라
          // 60분 캐시면 사용자 평균 2회 중 1회만 에어코리아 호출.
          await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 })
          return json(result)
        }
        // 에어코리아 호출 실패 또는 키 없음 — 클라이언트가 Open-Meteo fallback 하도록 404.
        return json({ error: 'airkorea unavailable', source: 'fallback' }, 404)
      }

      // 헬스체크
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ ok: true, service: 'schooldesk-meal', endpoints: ['/school', '/meal', '/airquality'] })
      }

      return json({ error: 'not found' }, 404)
    } catch (e) {
      // 내부 에러는 서버 로그에만 — 클라이언트엔 일반 메시지.
      console.error('worker error:', e)
      return json({ error: 'internal error' }, 500)
    }
  },
} satisfies ExportedHandler<Env>

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Sun, Cloud, CloudSun, CloudFog, CloudDrizzle, CloudRain, CloudSnow,
  CloudRainWind, CloudLightning, MapPin, RefreshCw, X, Search, Wind, School,
} from 'lucide-react'
import { useIAmWallpaper } from '../../hooks/useIAmWallpaper'

/** 급식 위젯이 NEIS 에서 받아 저장해둔 학교 정보. address(도로명) 에서 시군구를 뽑아
 *  KOREAN_CITIES 와 매칭 → 학교 위치 자동 적용. */
const MEAL_CONFIG_KEY = 'meal:config:v1'
interface SchoolHint { name?: string; address?: string }
function readSchoolHint(): SchoolHint | null {
  try {
    const raw = localStorage.getItem(MEAL_CONFIG_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as { school?: { name?: string; address?: string } }
    return cfg?.school ? { name: cfg.school.name, address: cfg.school.address } : null
  } catch { return null }
}

/**
 * 날씨 위젯 — 현재 기온 / 최저·최고 / 오전·오후 예보 / 비·눈 / 미세먼지.
 *
 * API: Open-Meteo (무료, 키 불필요, 사용량 무제한 — 2만명 써도 비용 0원).
 *  - 날씨:   https://api.open-meteo.com/v1/forecast
 *  - 미세먼지: https://air-quality-api.open-meteo.com/v1/air-quality
 *
 * 위치는 localStorage 에 저장 — 기본 서울. 사용자가 한국 주요 도시 검색해 변경 가능.
 */

interface City { name: string; lat: number; lon: number }

// 한국 주요 도시 — 클라이언트 사이드 검색용. 추가 API 호출 없이 즉시 변경 가능.
const KOREAN_CITIES: ReadonlyArray<City> = [
  { name: '서울', lat: 37.5665, lon: 126.9780 },
  { name: '부산', lat: 35.1796, lon: 129.0756 },
  { name: '인천', lat: 37.4563, lon: 126.7052 },
  { name: '대구', lat: 35.8714, lon: 128.6014 },
  { name: '대전', lat: 36.3504, lon: 127.3845 },
  { name: '광주', lat: 35.1595, lon: 126.8526 },
  { name: '울산', lat: 35.5384, lon: 129.3114 },
  { name: '세종', lat: 36.4801, lon: 127.2890 },
  { name: '수원', lat: 37.2636, lon: 127.0286 },
  { name: '성남', lat: 37.4201, lon: 127.1262 },
  { name: '용인', lat: 37.2411, lon: 127.1776 },
  { name: '고양', lat: 37.6584, lon: 126.8320 },
  { name: '안양', lat: 37.3943, lon: 126.9568 },
  { name: '안산', lat: 37.3219, lon: 126.8309 },
  { name: '부천', lat: 37.5035, lon: 126.7660 },
  { name: '의정부', lat: 37.7381, lon: 127.0337 },
  { name: '평택', lat: 36.9920, lon: 127.0888 },
  { name: '시흥', lat: 37.3803, lon: 126.8027 },
  { name: '파주', lat: 37.7600, lon: 126.7800 },
  { name: '김포', lat: 37.6152, lon: 126.7158 },
  { name: '광명', lat: 37.4791, lon: 126.8645 },
  { name: '하남', lat: 37.5395, lon: 127.2147 },
  { name: '구리', lat: 37.5944, lon: 127.1296 },
  { name: '남양주', lat: 37.6360, lon: 127.2165 },
  { name: '오산', lat: 37.1499, lon: 127.0773 },
  { name: '이천', lat: 37.2722, lon: 127.4348 },
  { name: '양주', lat: 37.7853, lon: 127.0457 },
  { name: '동두천', lat: 37.9035, lon: 127.0606 },
  { name: '가평', lat: 37.8313, lon: 127.5097 },
  { name: '여주', lat: 37.2982, lon: 127.6371 },
  { name: '춘천', lat: 37.8813, lon: 127.7298 },
  { name: '원주', lat: 37.3422, lon: 127.9202 },
  { name: '강릉', lat: 37.7519, lon: 128.8761 },
  { name: '동해', lat: 37.5247, lon: 129.1142 },
  { name: '속초', lat: 38.2070, lon: 128.5918 },
  { name: '삼척', lat: 37.4500, lon: 129.1654 },
  { name: '태백', lat: 37.1639, lon: 128.9858 },
  { name: '청주', lat: 36.6424, lon: 127.4890 },
  { name: '충주', lat: 36.9910, lon: 127.9259 },
  { name: '제천', lat: 37.1326, lon: 128.1909 },
  { name: '천안', lat: 36.8151, lon: 127.1139 },
  { name: '아산', lat: 36.7898, lon: 127.0019 },
  { name: '공주', lat: 36.4467, lon: 127.1190 },
  { name: '보령', lat: 36.3334, lon: 126.6128 },
  { name: '서산', lat: 36.7846, lon: 126.4503 },
  { name: '논산', lat: 36.1872, lon: 127.0982 },
  { name: '당진', lat: 36.8930, lon: 126.6286 },
  { name: '전주', lat: 35.8242, lon: 127.1480 },
  { name: '익산', lat: 35.9483, lon: 126.9577 },
  { name: '군산', lat: 35.9676, lon: 126.7368 },
  { name: '정읍', lat: 35.5697, lon: 126.8559 },
  { name: '남원', lat: 35.4164, lon: 127.3905 },
  { name: '김제', lat: 35.8038, lon: 126.8807 },
  { name: '여수', lat: 34.7604, lon: 127.6622 },
  { name: '순천', lat: 34.9507, lon: 127.4872 },
  { name: '목포', lat: 34.8118, lon: 126.3922 },
  { name: '광양', lat: 34.9407, lon: 127.6961 },
  { name: '나주', lat: 35.0160, lon: 126.7108 },
  { name: '포항', lat: 36.0190, lon: 129.3435 },
  { name: '경주', lat: 35.8562, lon: 129.2247 },
  { name: '안동', lat: 36.5683, lon: 128.7294 },
  { name: '구미', lat: 36.1196, lon: 128.3445 },
  { name: '김천', lat: 36.1396, lon: 128.1136 },
  { name: '문경', lat: 36.5868, lon: 128.1869 },
  { name: '상주', lat: 36.4109, lon: 128.1590 },
  { name: '영주', lat: 36.8055, lon: 128.6240 },
  { name: '영천', lat: 35.9733, lon: 128.9387 },
  { name: '경산', lat: 35.8252, lon: 128.7411 },
  { name: '창원', lat: 35.2280, lon: 128.6811 },
  { name: '진주', lat: 35.1800, lon: 128.1076 },
  { name: '통영', lat: 34.8544, lon: 128.4331 },
  { name: '사천', lat: 35.0033, lon: 128.0640 },
  { name: '김해', lat: 35.2342, lon: 128.8896 },
  { name: '밀양', lat: 35.5036, lon: 128.7466 },
  { name: '거제', lat: 34.8807, lon: 128.6212 },
  { name: '양산', lat: 35.3350, lon: 129.0376 },
  { name: '제주', lat: 33.4996, lon: 126.5312 },
  { name: '서귀포', lat: 33.2541, lon: 126.5601 },
]

const DEFAULT_CITY: City = KOREAN_CITIES[0]
const STORAGE_KEY = 'weather:city:v1'
/** 사용자가 직접 한 번이라도 도시를 선택했는지 표시 — 자동 매칭 덮어쓰기 방지. */
const USER_PICKED_KEY = 'weather:city:userPicked'

/** 학교 도로명주소에서 한국 76개 도시 중 매칭되는 도시를 찾는다.
 *  - 시도 + 시군구 → "서울특별시 강남구 ..." 에서 "서울"이 KOREAN_CITIES 에 있음.
 *  - "경기도 성남시 분당구 ..." → "성남" 매칭.
 *  - "서귀포"가 "제주"보다 먼저 매칭되도록 이름 길이 내림차순 정렬. */
function matchCityFromAddress(address: string | undefined): City | null {
  if (!address) return null
  const sorted = [...KOREAN_CITIES].sort((a, b) => b.name.length - a.name.length)
  for (const c of sorted) {
    if (address.includes(c.name)) return c
  }
  return null
}

interface WeatherData {
  current: { temperature: number; humidity: number; weatherCode: number }
  daily: { tempMin: number; tempMax: number; weatherCode: number; precip: number }
  hourly: { morning: { temp: number; code: number }; afternoon: { temp: number; code: number } }
  fetchedAt: number
}

interface AirQuality { pm10: number | null; pm25: number | null }

/** WMO weather code → 한국어 라벨 + Lucide 아이콘 + 색. */
function weatherInfo(code: number): { label: string; Icon: typeof Sun; color: string } {
  if (code === 0) return { label: '맑음', Icon: Sun, color: '#F59E0B' }
  if (code === 1) return { label: '대체로 맑음', Icon: Sun, color: '#F59E0B' }
  if (code === 2) return { label: '부분 흐림', Icon: CloudSun, color: '#94A3B8' }
  if (code === 3) return { label: '흐림', Icon: Cloud, color: '#94A3B8' }
  if (code === 45 || code === 48) return { label: '안개', Icon: CloudFog, color: '#9CA3AF' }
  if (code >= 51 && code <= 57) return { label: '이슬비', Icon: CloudDrizzle, color: '#60A5FA' }
  if (code >= 61 && code <= 67) return { label: '비', Icon: CloudRain, color: '#3B82F6' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: '눈', Icon: CloudSnow, color: '#A5B4FC' }
  if (code >= 80 && code <= 82) return { label: '소나기', Icon: CloudRainWind, color: '#2563EB' }
  if (code >= 95 && code <= 99) return { label: '천둥번개', Icon: CloudLightning, color: '#7C3AED' }
  return { label: '?', Icon: Cloud, color: '#94A3B8' }
}

/** PM2.5 농도 → 등급. (μg/m³) */
function pm25Grade(v: number | null): { label: string; color: string } {
  if (v === null) return { label: '—', color: '#94A3B8' }
  if (v <= 15) return { label: '좋음', color: '#10B981' }
  if (v <= 35) return { label: '보통', color: '#F59E0B' }
  if (v <= 75) return { label: '나쁨', color: '#EF4444' }
  return { label: '매우나쁨', color: '#7C3AED' }
}

function pm10Grade(v: number | null): { label: string; color: string } {
  if (v === null) return { label: '—', color: '#94A3B8' }
  if (v <= 30) return { label: '좋음', color: '#10B981' }
  if (v <= 80) return { label: '보통', color: '#F59E0B' }
  if (v <= 150) return { label: '나쁨', color: '#EF4444' }
  return { label: '매우나쁨', color: '#7C3AED' }
}

export function WeatherWidget() {
  const [city, setCity] = useState<City>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as City
        if (parsed?.name && typeof parsed.lat === 'number' && typeof parsed.lon === 'number') return parsed
      }
    } catch { /* ignore */ }
    // 사용자가 한 번도 도시 선택을 안 했고 학교 정보가 있으면 자동 매칭.
    try {
      const picked = localStorage.getItem(USER_PICKED_KEY)
      if (!picked) {
        const hint = readSchoolHint()
        const matched = matchCityFromAddress(hint?.address)
        if (matched) return matched
      }
    } catch { /* ignore */ }
    return DEFAULT_CITY
  })
  // 학교 정보 힌트(이름) — 검색 화면의 "학교 위치로 설정" 버튼 표시용.
  const [schoolHint, setSchoolHint] = useState<SchoolHint | null>(() => readSchoolHint())
  // 다른 위젯 창에서 학교가 새로 설정되면 sync (storage event).
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === MEAL_CONFIG_KEY) setSchoolHint(readSchoolHint())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [air, setAir] = useState<AirQuality>({ pm10: null, pm25: null })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const iAmWallpaper = useIAmWallpaper('weather')
  const abortRef = useRef<AbortController | null>(null)

  const fetchAll = useCallback(async (target: City): Promise<void> => {
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${target.lat}&longitude=${target.lon}`
        + `&current=temperature_2m,relative_humidity_2m,weather_code`
        + `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum`
        + `&hourly=temperature_2m,weather_code`
        + `&timezone=Asia%2FSeoul&forecast_days=1`
      const aUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${target.lat}&longitude=${target.lon}`
        + `&current=pm10,pm2_5&timezone=Asia%2FSeoul`
      const [wRes, aRes] = await Promise.all([
        fetch(wUrl, { signal: ctrl.signal }),
        fetch(aUrl, { signal: ctrl.signal }).catch(() => null),
      ])
      if (!wRes.ok) throw new Error(`날씨 ${wRes.status}`)
      const w = await wRes.json() as {
        current: { temperature_2m: number; relative_humidity_2m: number; weather_code: number }
        daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[]; precipitation_sum: number[] }
        hourly: { time: string[]; temperature_2m: number[]; weather_code: number[] }
      }
      // 오전 9시 / 오후 3시 시점 hourly 추출 (없으면 가장 가까운 시각).
      const findHour = (h: number): number => {
        const idx = w.hourly.time.findIndex((t) => new Date(t).getHours() === h)
        return idx >= 0 ? idx : 0
      }
      const mIdx = findHour(9)
      const aIdx = findHour(15)
      const next: WeatherData = {
        current: {
          temperature: Math.round(w.current.temperature_2m),
          humidity: Math.round(w.current.relative_humidity_2m),
          weatherCode: w.current.weather_code,
        },
        daily: {
          tempMin: Math.round(w.daily.temperature_2m_min[0]),
          tempMax: Math.round(w.daily.temperature_2m_max[0]),
          weatherCode: w.daily.weather_code[0],
          precip: Math.round((w.daily.precipitation_sum[0] ?? 0) * 10) / 10,
        },
        hourly: {
          morning: { temp: Math.round(w.hourly.temperature_2m[mIdx]), code: w.hourly.weather_code[mIdx] },
          afternoon: { temp: Math.round(w.hourly.temperature_2m[aIdx]), code: w.hourly.weather_code[aIdx] },
        },
        fetchedAt: Date.now(),
      }
      setWeather(next)
      if (aRes?.ok) {
        try {
          const a = await aRes.json() as { current: { pm10: number; pm2_5: number } }
          setAir({ pm10: Math.round(a.current.pm10), pm25: Math.round(a.current.pm2_5) })
        } catch { /* ignore */ }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError((e as Error).message || '날씨 정보를 불러올 수 없어요')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll(city)
    // 10분마다 자동 새로고침
    const t = setInterval(() => fetchAll(city), 10 * 60 * 1000)
    return () => clearInterval(t)
  }, [city, fetchAll])

  const applyCity = (c: City, opts?: { autoFromSchool?: boolean }): void => {
    setCity(c)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
      // 사용자가 검색 후 선택한 경우만 USER_PICKED 마크. 학교 자동 매칭은 향후
      // 학교 변경 시 다시 sync 되도록 마크 안 함.
      if (!opts?.autoFromSchool) localStorage.setItem(USER_PICKED_KEY, '1')
    } catch { /* ignore */ }
    setSearchOpen(false); setSearchQuery('')
  }

  /** 도시 검색 화면의 "학교 위치로 설정" — 학교 주소에서 도시 추출 + 적용. */
  const applySchoolLocation = (): void => {
    const matched = matchCityFromAddress(schoolHint?.address)
    if (matched) applyCity(matched, { autoFromSchool: true })
  }

  const filteredCities = useMemo(() => {
    const q = searchQuery.trim()
    if (!q) return KOREAN_CITIES.slice(0, 30)
    return KOREAN_CITIES.filter((c) => c.name.includes(q))
  }, [searchQuery])

  const cur = weather && weatherInfo(weather.current.weatherCode)
  const morning = weather && weatherInfo(weather.hourly.morning.code)
  const afternoon = weather && weatherInfo(weather.hourly.afternoon.code)
  const pm25 = pm25Grade(air.pm25)
  const pm10v = pm10Grade(air.pm10)

  return (
    <div
      className="flex flex-col h-full relative overflow-hidden"
      style={{
        // 배경화면 모드(헤더 숨김)에선 위아래 여백 최소화 — 콘텐츠가 위젯 전체를 꽉 채우게.
        padding: iAmWallpaper ? '10px 16px 12px 16px' : '14px 18px 18px 18px',
        background: 'radial-gradient(ellipse at 30% 0%, rgba(56,189,248,0.10) 0%, transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(99,102,241,0.07) 0%, transparent 50%)',
      }}
    >
      {/* Header — 위치 + 새로고침 */}
      {!iAmWallpaper && (
        <div className="flex items-center gap-2 shrink-0 mb-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            title="도시 변경"
          >
            <MapPin size={12} strokeWidth={2.4} />
            <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '-0.02em' }}>{city.name}</span>
          </button>
          <div className="flex-1" />
          <button
            onClick={() => fetchAll(city)}
            disabled={loading}
            className="flex items-center justify-center transition-colors text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]"
            style={{ width: 24, height: 24, borderRadius: 7, border: '1px solid var(--border-widget)' }}
            title="새로고침"
          >
            <RefreshCw size={11} strokeWidth={2.4} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      )}

      {error && (
        <div
          className="shrink-0 mb-2"
          style={{
            fontSize: 11.5, fontWeight: 700,
            padding: '6px 10px', borderRadius: 8,
            backgroundColor: 'rgba(239,68,68,0.12)', color: '#B91C1C',
          }}
        >
          {error}
        </div>
      )}

      {/* 현재 기온 + 날씨 아이콘 — 큰 영역 */}
      {weather && cur && (
        <div className="flex items-center justify-center gap-3 shrink-0" style={{ marginBottom: 'clamp(10px, 1.6vw, 18px)' }}>
          <cur.Icon
            strokeWidth={1.8}
            color={cur.color}
            style={{ filter: `drop-shadow(0 4px 12px ${cur.color}66)`, width: 'clamp(56px, 13vw, 96px)', height: 'clamp(56px, 13vw, 96px)' }}
          />
          <div className="flex flex-col items-start">
            <div
              className="tabular-nums"
              style={{
                fontSize: 'clamp(46px, 12vw, 92px)',
                fontWeight: 900, lineHeight: 0.95, letterSpacing: '-0.05em',
                color: cur.color,
              }}
            >
              {weather.current.temperature}°
            </div>
            <div
              style={{
                fontSize: 'clamp(13px, 1.8vw, 19px)',
                fontWeight: 800, letterSpacing: '-0.02em',
                color: 'var(--text-secondary)', marginTop: 3,
              }}
            >
              {cur.label}
              {weather.daily.precip > 0 && (
                <span style={{ marginLeft: 6, color: '#3B82F6' }}>
                  · 강수 {weather.daily.precip}mm
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 최저 / 최고 pill */}
      {weather && (
        <div className="flex items-center justify-center gap-2 shrink-0" style={{ marginBottom: 'clamp(8px, 1.2vw, 14px)' }}>
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            style={{
              fontSize: 12, fontWeight: 800, padding: '4px 10px', borderRadius: 999,
              background: 'rgba(59,130,246,0.14)', color: '#1D4ED8',
              border: '1px solid rgba(59,130,246,0.3)',
            }}
          >
            최저 {weather.daily.tempMin}°
          </span>
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            style={{
              fontSize: 12, fontWeight: 800, padding: '4px 10px', borderRadius: 999,
              background: 'rgba(239,68,68,0.14)', color: '#B91C1C',
              border: '1px solid rgba(239,68,68,0.3)',
            }}
          >
            최고 {weather.daily.tempMax}°
          </span>
        </div>
      )}

      {/* 오전 / 오후 예보 */}
      {weather && morning && afternoon && (
        <div className="grid grid-cols-2 gap-2 shrink-0" style={{ marginBottom: 'clamp(8px, 1.2vw, 14px)' }}>
          {[
            { label: '9시', m: weather.hourly.morning, info: morning },
            { label: '15시', m: weather.hourly.afternoon, info: afternoon },
          ].map(({ label, m, info }) => (
            <div
              key={label}
              className="flex items-center gap-2.5"
              style={{
                padding: '8px 12px', borderRadius: 12,
                background: `linear-gradient(135deg, ${info.color}14 0%, ${info.color}22 100%)`,
                border: `1px solid ${info.color}33`,
              }}
            >
              <info.Icon size={22} strokeWidth={2} color={info.color} />
              <div className="flex flex-col">
                <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '-0.2px' }}>{label}</span>
                <span className="tabular-nums" style={{ fontSize: 14, fontWeight: 900, color: info.color, lineHeight: 1.1 }}>
                  {m.temp}°
                </span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '-0.2px' }}>
                  {info.label}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 미세먼지 — PM10 / PM2.5 */}
      <div className="grid grid-cols-2 gap-2 shrink-0">
        {[
          { label: 'PM2.5', val: air.pm25, grade: pm25 },
          { label: 'PM10', val: air.pm10, grade: pm10v },
        ].map(({ label, val, grade }) => (
          <div
            key={label}
            className="flex items-center gap-2"
            style={{
              padding: '7px 10px', borderRadius: 10,
              background: `linear-gradient(135deg, ${grade.color}12 0%, ${grade.color}1F 100%)`,
              border: `1px solid ${grade.color}33`,
            }}
          >
            <Wind size={14} strokeWidth={2.2} color={grade.color} />
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '-0.2px', lineHeight: 1.1 }}>
                {label}
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="tabular-nums" style={{ fontSize: 13, fontWeight: 900, color: grade.color }}>
                  {val ?? '—'}
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: grade.color }}>
                  {grade.label}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 도시 검색 오버레이 */}
      {searchOpen && (
        <div
          className="absolute inset-0 z-40 flex flex-col"
          style={{ background: 'var(--bg-widget)' }}
        >
          <div className="flex items-center gap-2 shrink-0" style={{ padding: 12 }}>
            <Search size={14} strokeWidth={2.4} className="text-[var(--text-muted)]" />
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="도시 이름…"
              className="flex-1 outline-none bg-transparent"
              style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}
            />
            <button
              onClick={() => { setSearchOpen(false); setSearchQuery('') }}
              className="flex items-center justify-center transition-colors text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]"
              style={{ width: 24, height: 24, borderRadius: 7 }}
              title="닫기"
            >
              <X size={13} strokeWidth={2.4} />
            </button>
          </div>
          {/* 학교 위치 자동 설정 — 급식 위젯에서 받은 NEIS 주소로 도시 매칭. */}
          {schoolHint?.address && matchCityFromAddress(schoolHint.address) && (
            <button
              onClick={applySchoolLocation}
              className="flex items-center gap-2 transition-all hover:scale-[1.01]"
              style={{
                margin: '0 12px 8px',
                padding: '10px 12px',
                borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(14,165,233,0.14) 0%, rgba(37,99,235,0.18) 100%)',
                border: '1px solid rgba(37,99,235,0.32)',
                color: '#1D4ED8',
                textAlign: 'left',
              }}
              title="급식 위젯의 학교 주소에서 자동 매칭"
            >
              <School size={16} strokeWidth={2.4} />
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '-0.2px', lineHeight: 1.2 }}>
                  학교 위치로 자동 설정
                </div>
                <div className="truncate" style={{ fontSize: 10.5, fontWeight: 600, opacity: 0.85, marginTop: 2 }}>
                  {schoolHint.name ?? ''} · {matchCityFromAddress(schoolHint.address)?.name}
                </div>
              </div>
            </button>
          )}
          <div className="flex-1 overflow-y-auto" style={{ padding: '0 8px 12px' }}>
            {filteredCities.length === 0 ? (
              <div className="text-center" style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 20, fontWeight: 700 }}>
                매칭되는 도시가 없어요
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {filteredCities.map((c) => {
                  const active = c.name === city.name
                  return (
                    <button
                      key={c.name}
                      onClick={() => applyCity(c)}
                      className="flex items-center justify-center transition-all hover:scale-105"
                      style={{
                        padding: '8px 6px', borderRadius: 9,
                        fontSize: 12, fontWeight: 800, letterSpacing: '-0.2px',
                        background: active ? 'linear-gradient(135deg, #38BDF8 0%, #2563EB 100%)' : 'var(--bg-secondary)',
                        color: active ? '#fff' : 'var(--text-primary)',
                        border: active ? 'none' : '1px solid var(--border-widget)',
                        boxShadow: active ? '0 3px 9px rgba(59,130,246,0.32)' : undefined,
                      }}
                    >
                      {c.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { X, Pin, PinOff, Eye, Type, Image as WallpaperIcon, MonitorOff } from 'lucide-react'
import { WALLPAPER_ELIGIBLE_TYPES, type WidgetType } from '../../types/widget.types'
import { useDisplayBg } from '../../lib/display-bg'

/** 자체 우상단 디스플레이 컨트롤(팔레트/모드 토글)을 직접 렌더하는 위젯 타입.
 *  이 위젯들은 shell 의 플로팅 컨트롤을 생략해 버튼 중복을 피한다. */
const WIDGETS_WITH_OWN_DISPLAY_CONTROLS = new Set<string>([
  'clock', 'goal', 'meal', 'studentcheck', 'studenttimetable',
])

/** 디스플레이 모드에서 shell 의 플로팅 컨트롤(해제 버튼)을 표시하지 않는 위젯.
 *  본문이 풀스크린 콘텐츠라 컨트롤이 시각적으로 거슬리는 경우. 해제는 단축키 Ctrl+Alt+Shift+D
 *  또는 다른 위젯의 끄기 버튼으로. */
const WIDGETS_WITHOUT_FLOATING_DISPLAY_CONTROL = new Set<string>([
  'calendar',
])

/** 디스플레이 모드에서 shell floating 컨트롤을 **우하단**에 배치할 위젯.
 *  나머지(메모·할일·루틴·체크리스트 등)는 헤더 자리(우상단). 사용자 요청 — 본문이
 *  큰 정보 위주(학생기록·D-Day·오늘·타이머)인 위젯은 콘텐츠 가운데 시야 방해 없이 우하단. */
const WIDGETS_FLOATING_AT_BOTTOM = new Set<string>([
  'studentrecord', 'dday', 'today', 'timer',
])

interface WidgetShellProps {
  title: string
  icon?: ReactNode
  iconColor?: string
  children: ReactNode
  /** 이 위젯의 타입 — 배경화면 모드 전체 토글 버튼 노출 여부 결정 */
  widgetType?: string
}

export function WidgetShell({ title, icon, iconColor, children, widgetType }: WidgetShellProps) {
  // 슬라이더 기본 표시값 — main 의 기본 위젯 opacity(0.95)와 일치. 사용자가
  // 슬라이더 열면 현재 적용된 값과 일치되게 보이도록.
  const [opacity, setOpacityState] = useState(0.95)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [opacityOpen, setOpacityOpen] = useState(false)
  const [fontOpen, setFontOpen] = useState(false)
  const [fontScale, setFontScale] = useState(1)
  // 배경화면 모드가 "한 개라도 켜져 있으면" true — 전체 on/off 마스터 상태.
  const [anyWallpaperOn, setAnyWallpaperOn] = useState(false)
  // 내 창이 배경화면 모드면 헤더 숨기고 콘텐츠만 풀로 보여주자.
  const [iAmWallpaper, setIAmWallpaper] = useState(false)
  // 자식 위젯(GoalWidget / StudentCheckWidget 등)이 보낸 "디스플레이 모드" 상태.
  // 배경화면 모드가 아니어도 디스플레이 모드면 헤더를 숨겨 콘텐츠만 풀로 보여준다.
  const [childDisplayMode, setChildDisplayMode] = useState(false)
  // 쉘 자체 디스플레이 모드 — 헤더 버튼으로 토글. 배경화면 모드가 없는 위젯이나 "그냥 헤더만 숨기고 싶을 때" 사용.
  const [shellDisplayMode, setShellDisplayMode] = useState(false)
  // 쉘 레벨 디스플레이 배경 프리셋 — 디스플레이 모드 켠 위젯의 body 배경 색.
  // 위젯별로 따로 저장 (e.g. 메모/시계 각자 다른 색 선택 가능).
  const bgScopeKey = useMemo(() => `shell:${widgetType ?? 'default'}`, [widgetType])
  const { preset: shellBg } = useDisplayBg(bgScopeKey)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const fontPopoverRef = useRef<HTMLDivElement | null>(null)

  // 배경화면 모드 마스터 토글은 편집용 위젯(= 배경화면 불가능) 헤더에서만 노출.
  const isMasterToggleHost = !!widgetType && !WALLPAPER_ELIGIBLE_TYPES.has(widgetType as WidgetType)

  // 내 widget id — URL hash에서 유도. 형태: `widget-<type>[-<instanceId>]`.
  // main.ts 의 widget id 명명 규칙과 동일해야 한다.
  const myWidgetId = useRef<string | null>(null)
  if (myWidgetId.current === null && widgetType) {
    const m = /instance=([^&]+)/.exec(window.location.hash)
    const inst = m ? decodeURIComponent(m[1]) : null
    myWidgetId.current = inst ? `widget-${widgetType}-${inst}` : `widget-${widgetType}`
  }

  const refreshWallpaperState = useCallback(async () => {
    try {
      const map = await window.api.widget.getWallpaperModeMap()
      setAnyWallpaperOn((map?.length ?? 0) > 0)
    } catch { setAnyWallpaperOn(false) }
  }, [])

  useEffect(() => {
    window.api.widget.getAlwaysOnTop?.().then(setAlwaysOnTop).catch(() => {})
    window.api.widget.getFontScale?.().then((v) => setFontScale(v || 1)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!isMasterToggleHost) return
    refreshWallpaperState()
    // main이 모드 변경 이벤트를 쏘면 즉시 동기화
    const off = window.api.widget.onWallpaperModeChanged?.(() => {
      refreshWallpaperState()
    })
    return () => { if (off) off() }
  }, [isMasterToggleHost, refreshWallpaperState])

  // 내 창의 배경화면 상태를 실시간 추적. 켜지면 헤더 전체를 숨긴다.
  useEffect(() => {
    if (!myWidgetId.current) return
    let cancelled = false
    const syncMine = async (): Promise<void> => {
      try {
        const map = await window.api.widget.getWallpaperModeMap()
        if (cancelled) return
        setIAmWallpaper(Array.isArray(map) && map.includes(myWidgetId.current!))
      } catch { /* ignore */ }
    }
    syncMine()
    // 자식 위젯이 자신의 "디스플레이 모드" 상태를 dispatch 하면 헤더를 숨긴다.
    // 배경화면 모드 아닌 상태에서도 "화면 가득 보여주기"가 가능해짐.
    const onDisplayMode = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ on?: boolean }>).detail
      setChildDisplayMode(!!detail?.on)
    }
    window.addEventListener('widget:displayMode', onDisplayMode as EventListener)
    const off = window.api.widget.onWallpaperModeChanged?.((p) => {
      if (p.widgetId !== myWidgetId.current) return
      setIAmWallpaper(p.on)
      // 배경화면 모드 진입 시 현재 창에 남아있는 DOM focus 를 즉시 해제.
      // (input·button·contentEditable 에 포커스가 있으면 Windows 가 창을
      //  다시 앞으로 가져와 "맨 뒤 고정"을 방해한다.)
      if (p.on) {
        try {
          const active = document.activeElement as HTMLElement | null
          if (active && typeof active.blur === 'function') active.blur()
        } catch { /* noop */ }
        try { window.getSelection()?.removeAllRanges?.() } catch { /* noop */ }
        try { window.blur() } catch { /* noop */ }
      }
    })
    return () => {
      cancelled = true
      if (off) off()
      window.removeEventListener('widget:displayMode', onDisplayMode as EventListener)
    }
  }, [])

  // 마스터 디스플레이 모드 브로드캐스트 구독 — 다른 위젯에서 "전체 디스플레이 모드" 를 켜면 내 shellDisplayMode 도 동기화.
  useEffect(() => {
    const off = window.api.widget.onAllDisplayModeChanged?.((p) => {
      setShellDisplayMode(!!p.on)
    })
    return () => { if (off) off() }
  }, [])

  // 디스플레이 모드 해제(플로팅 버튼)는 항상 마스터 브로드캐스트 — 모든 위젯이 함께 해제.
  const exitAllDisplayMode = (): void => {
    setShellDisplayMode(false)
    try { window.api.widget.setAllDisplayMode?.(false) } catch { /* ignore */ }
  }

  const toggleAllWallpaper = async (): Promise<void> => {
    if (anyWallpaperOn) {
      await window.api.widget.exitAllWallpaperMode()
      setAnyWallpaperOn(false)
      return
    }
    // 열린 위젯 중 eligible 타입만 선별해서 한 번에 켠다.
    const openIds = await window.api.widget.listOpen()
    const targets = openIds
      .map((id) => {
        // id는 "type" 또는 "type-<instanceId>" 형태(widget- 접두는 listOpen에서 제거됨)
        const prefix = id.split('-')[0] as WidgetType
        return { prefix, fullId: `widget-${id}` }
      })
      .filter((t) => WALLPAPER_ELIGIBLE_TYPES.has(t.prefix))
    for (const t of targets) {
      try { await window.api.widget.setWallpaperMode(t.fullId, true) } catch { /* ignore */ }
    }
    setAnyWallpaperOn(targets.length > 0)
  }

  const changeFontScale = (next: number) => {
    const clamped = Math.max(0.7, Math.min(1.6, Math.round(next * 20) / 20))
    setFontScale(clamped)
    window.api.widget.setFontScale?.(clamped)
  }

  const applyOpacity = (v: number) => {
    setOpacityState(v)
    window.api.widget.setOpacity(v)
  }

  const toggleAlwaysOnTop = () => {
    const next = !alwaysOnTop
    setAlwaysOnTop(next)
    window.api.widget.setAlwaysOnTop(next)
  }

  useEffect(() => {
    if (!opacityOpen) return
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpacityOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [opacityOpen])

  useEffect(() => {
    if (!fontOpen) return
    const onDown = (e: MouseEvent) => {
      if (fontPopoverRef.current && !fontPopoverRef.current.contains(e.target as Node)) {
        setFontOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [fontOpen])

  const accent = iconColor ?? 'var(--accent)'
  const chipBg = iconColor ? `${iconColor}1F` : 'var(--accent-light)'

  return (
    <div
      className="shell-card flex flex-col h-screen w-screen"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Draggable header — 배경화면 모드, 자식 위젯 디스플레이 모드, 쉘 자체 디스플레이 모드면 완전히 숨김.
          Goal('우리반 목표') 위젯은 body 가 한 문장 큰 텍스트만 있어 헤더가 상대적으로 커 보이므로
          전용 컴팩트 헤더 사용 (사용자 요청). */}
      {!iAmWallpaper && !childDisplayMode && !shellDisplayMode && (
      <div
        className={`flex items-center justify-between relative ${widgetType === 'goal' ? 'shell-header-compact' : ''}`}
        style={{
          WebkitAppRegion: 'drag',
          padding: widgetType === 'goal' ? '1px 12px 1px 14px' : '5px 12px 5px 14px',
          background: 'var(--shell-header-bg)',
          borderBottom: '1px solid var(--shell-header-border)',
        } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {icon && (
            <span
              className="flex items-center justify-center shrink-0"
              style={{
                width: widgetType === 'goal' ? 18 : 22,
                height: widgetType === 'goal' ? 18 : 22,
                borderRadius: widgetType === 'goal' ? 6 : 7,
                background: chipBg,
                color: accent,
                boxShadow: `0 1px 0 rgba(255,255,255,0.4) inset, 0 0 0 1px ${iconColor ? `${iconColor}26` : 'rgba(37,99,235,0.18)'}`,
              }}
            >
              {icon}
            </span>
          )}
          <span
            className="truncate text-[var(--text-primary)]"
            style={{
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '-0.015em',
            }}
          >
            {title}
          </span>
        </div>

        <div
          className="flex items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 배경화면 모드 전체 on/off — 편집용 위젯에만 노출 (언제든 클릭 가능). */}
          {isMasterToggleHost && (
            <button
              onClick={toggleAllWallpaper}
              className={`shell-btn ${anyWallpaperOn ? 'shell-btn-active' : ''}`}
              title={
                anyWallpaperOn
                  ? '배경화면 모드 전체 해제 — 단축키: Ctrl+Alt+Shift+W (다시 누르면 진입)'
                  : '배경화면 모드 전체 진입 — 시간표·학급체크·달력·우리반목표·학생용시간표·D-Day·시계·타이머·오늘·급식 일괄 적용. 단축키: Ctrl+Alt+Shift+W (같은 단축키로 해제)'
              }
              style={anyWallpaperOn
                ? { color: '#fff', background: 'linear-gradient(135deg, #0EA5E9, #2563EB)', boxShadow: '0 4px 10px rgba(14,165,233,0.45)' }
                : undefined}
            >
              <WallpaperIcon size={13} strokeWidth={2.2} />
            </button>
          )}

          {/* 디스플레이 모드 토글은 위젯 내부의 Monitor 버튼(시계/학생시간표/학급체크/우리반목표) 과
              중복되어 제거. 내부 토글이 이미 마스터 브로드캐스트를 보내 모든 위젯에 일괄 적용됨. */}

          <div className="relative" ref={popoverRef}>
            <button
              onClick={() => setOpacityOpen((p) => !p)}
              className={`shell-btn ${opacityOpen ? 'shell-btn-active' : ''}`}
              title="투명도"
            >
              <Eye size={13.5} strokeWidth={2.1} />
            </button>
            {opacityOpen && (
              <div
                className="absolute right-0 top-full mt-1.5 z-10"
                style={{
                  padding: '12px 14px',
                  minWidth: 170,
                  borderRadius: 14,
                  background: 'var(--shell-popover-bg)',
                  border: '1px solid var(--shell-popover-border)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                  boxShadow: '0 12px 32px -8px rgba(15, 23, 42, 0.24), 0 4px 12px -2px rgba(15, 23, 42, 0.1)',
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)] tracking-tight">투명도</span>
                  <span
                    className="text-[11px] font-semibold tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {Math.round(opacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.3}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => applyOpacity(Number(e.target.value))}
                  className="shell-slider"
                />
              </div>
            )}
          </div>

          <div className="relative" ref={fontPopoverRef}>
            <button
              onClick={() => setFontOpen((p) => !p)}
              className={`shell-btn ${fontOpen ? 'shell-btn-active' : ''}`}
              title="글씨 크기"
            >
              <Type size={13} strokeWidth={2.2} />
            </button>
            {fontOpen && (
              <div
                className="absolute right-0 top-full mt-1.5 z-10"
                style={{
                  padding: '10px 12px',
                  minWidth: 170,
                  borderRadius: 14,
                  background: 'var(--shell-popover-bg)',
                  border: '1px solid var(--shell-popover-border)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                  boxShadow: '0 12px 32px -8px rgba(15, 23, 42, 0.24), 0 4px 12px -2px rgba(15, 23, 42, 0.1)',
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)] tracking-tight">글씨 크기</span>
                  <span
                    className="text-[11px] font-semibold tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {Math.round(fontScale * 100)}%
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => changeFontScale(fontScale - 0.1)}
                    className="flex-1 py-1 rounded-md text-xs font-bold"
                    style={{
                      backgroundColor: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--shell-popover-border)',
                    }}
                  >A−</button>
                  <button
                    onClick={() => changeFontScale(1)}
                    className="px-2 py-1 rounded-md text-[10px] font-medium"
                    style={{
                      backgroundColor: 'var(--bg-secondary)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--shell-popover-border)',
                    }}
                  >기본</button>
                  <button
                    onClick={() => changeFontScale(fontScale + 0.1)}
                    className="flex-1 py-1 rounded-md text-xs font-bold"
                    style={{
                      backgroundColor: 'var(--accent-light)',
                      color: 'var(--accent)',
                      border: '1px solid var(--shell-popover-border)',
                    }}
                  >A+</button>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={toggleAlwaysOnTop}
            className={`shell-btn ${alwaysOnTop ? 'shell-btn-active' : ''}`}
            title={
              alwaysOnTop
                ? '핀 해제 (다른 창 클릭 시 자동으로 뒤로 감)'
                : '맨 앞에 핀 고정'
            }
          >
            {alwaysOnTop ? <Pin size={13} strokeWidth={2.2} /> : <PinOff size={13} strokeWidth={2.2} />}
          </button>

          <button
            onClick={() => window.api.widget.closeSelf()}
            className="shell-btn shell-btn-danger"
            title="닫기 — 바탕화면 위젯 패널에서 다시 켤 수 있어요"
          >
            <X size={13.5} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      )}

      {/* Body — 헤더 유무와 무관하게 4 모서리 모두 round. 헤더가 있으면 위 2 모서리는 헤더 뒤에 가려서 안 보이고,
          헤더가 없으면(배경화면/디스플레이 모드) 그대로 예쁜 rounded top 이 노출됨.
          shellDisplayMode 일 때는 사용자가 고른 배경 프리셋을 body 에 깔아준다 — 모든 위젯에 일관된 배경. */}
      <div
        className="flex-1 overflow-hidden relative"
        style={{
          borderRadius: 'var(--shell-radius)',
          background: shellDisplayMode && shellBg.bg ? shellBg.bg : undefined,
          transition: 'background 320ms ease',
        }}
      >
        {/* 디스플레이 모드 글로우 오버레이 */}
        {shellDisplayMode && shellBg.glow && (
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{ background: shellBg.glow, zIndex: 0 }}
          />
        )}

        {/* 글씨 크기 배율 적용 — CSS zoom 은 cqmin/vw 까지 모두 스케일하므로
            webContents.setZoomFactor 가 스케일 못하던 콘텐츠 내부 글씨도 제대로 커진다.
            A-/A+ 버튼이 이 값을 바꾸면 body 만 커지고 헤더는 그대로. */}
        <div
          className="relative w-full h-full"
          style={{
            zIndex: 1,
            color: shellDisplayMode && shellBg.textMode === 'light' ? '#fff' : undefined,
            zoom: fontScale,
          } as React.CSSProperties}
        >
          {children}
        </div>

        {/* 디스플레이 모드 전용 플로팅 컨트롤 — 자체 컨트롤이 있는 위젯(clock/goal/meal/studentcheck/studenttimetable)
            은 자체 우상단 버튼이 처리하므로 shell 컨트롤은 생략 (좌하단 중복 제거 사용자 요청).
            다른 위젯은 우상단에 항상 보이게(이전엔 hover 시만) + 크게(가독성 ↑) 표시. */}
        {shellDisplayMode && !iAmWallpaper && !WIDGETS_WITH_OWN_DISPLAY_CONTROLS.has(widgetType ?? '') && !WIDGETS_WITHOUT_FLOATING_DISPLAY_CONTROL.has(widgetType ?? '') && (
          <div
            // 위젯 타입에 따라 우상단(헤더 자리) 또는 우하단으로 분기.
            // - 메모·할일·루틴·체크리스트 등: 헤더 자리(우상단). 헤더에 paddingRight 80 으로 자리 확보.
            // - 학생기록·D-Day·오늘·타이머: 우하단(콘텐츠 중심 위젯, 사용자 요청).
            className={`absolute flex items-center gap-1.5 right-2 ${WIDGETS_FLOATING_AT_BOTTOM.has(widgetType ?? '') ? 'bottom-2' : 'top-2'}`}
            style={{ zIndex: 30, WebkitAppRegion: 'no-drag', pointerEvents: 'auto' } as React.CSSProperties}
          >
            <button
              onClick={exitAllDisplayMode}
              className="rounded-lg transition-all flex items-center justify-center hover:scale-105"
              title="디스플레이 모드 해제 (모든 위젯 · Ctrl+Alt+Shift+D)"
              style={{
                width: 32,
                height: 32,
                color: shellBg.textMode === 'light' ? '#fff' : 'var(--accent)',
                background: shellBg.textMode === 'light'
                  ? 'rgba(255,255,255,0.18)'
                  : 'var(--accent-light)',
                border: shellBg.textMode === 'light'
                  ? '1.5px solid rgba(255,255,255,0.42)'
                  : '1.5px solid rgba(37,99,235,0.28)',
                boxShadow: shellBg.textMode === 'light'
                  ? '0 4px 12px rgba(0,0,0,0.25)'
                  : '0 4px 12px rgba(37,99,235,0.18)',
                backdropFilter: 'blur(10px)',
              }}
            >
              <MonitorOff size={16} strokeWidth={2.4} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

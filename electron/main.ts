import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, screen, shell, session } from 'electron'
import { join } from 'path'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, unlinkSync, appendFileSync } from 'fs'
import { homedir } from 'os'

// ─── Global crash 로그 ────────────────────────────────────
// main 프로세스의 uncaught 예외는 Electron 기본 동작상 앱을 즉시 종료시킨다
// ("아이콘이 떴다 사라지는" 증상의 가장 흔한 원인). 여기서 모두 잡아 파일로 남긴다.
function _crashLog(kind: string, err: unknown): void {
  try {
    const dir = process.env.APPDATA
      ? join(process.env.APPDATA, 'SchoolDesk')
      : join(homedir(), '.SchoolDesk')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    appendFileSync(join(dir, 'crash.log'), `[${new Date().toISOString()}] [${kind}] ${msg}\n`)
  } catch { /* 마지막 방어선 — 로그도 못 쓰면 그냥 조용히 */ }
}
process.on('uncaughtException', (err) => _crashLog('uncaughtException', err))
process.on('unhandledRejection', (err) => _crashLog('unhandledRejection', err))

// ───── Windows Z-order 제어 (네이티브 Win32 FFI) ─────
// blur 시 위젯을 "맨 뒤"로 밀어내기 + 배경화면 모드에선 `WS_EX_NOACTIVATE` 를 걸어
// 클릭을 받아도 foreground 로 올라오지 않게 한다(= "진짜 바탕화면처럼" 고정).
// 로드 실패 시 graceful degradation — 위젯은 일반 창처럼 동작.
// HWND 는 Buffer 가 아니라 Buffer 안의 첫 8바이트(BigInt) 로 추출해서 전달해야 한다.
//  - Buffer 를 'void*' 로 넘기면 Buffer 객체의 메모리 주소가 전달되어 ERROR_INVALID_WINDOW_HANDLE(1400) 발생.
//  - 'intptr' 로 정의하고 BigInt 값을 직접 전달해야 OS 가 진짜 HWND 로 인식한다. (디버그 로그로 확인됨.)
type SetWindowPosFn = (hwnd: bigint, insertAfter: bigint, x: number, y: number, cx: number, cy: number, flags: number) => boolean
type GetWindowLongPtrFn = (hwnd: bigint, nIndex: number) => bigint
type SetWindowLongPtrFn = (hwnd: bigint, nIndex: number, value: bigint) => bigint
type GetForegroundWindowFn = () => bigint
type GetLastErrorFn = () => number
type GetWindowFn = (hwnd: bigint, cmd: number) => bigint
let _setWindowPos: SetWindowPosFn | null = null
let _getWindowLongPtr: GetWindowLongPtrFn | null = null
let _setWindowLongPtr: SetWindowLongPtrFn | null = null
let _getForegroundWindow: GetForegroundWindowFn | null = null
let _getLastError: GetLastErrorFn | null = null
let _getWindow: GetWindowFn | null = null
const GW_HWNDPREV = 3 // hwnd 바로 위(z-order 이전) 창

// ─── Wallpaper 디버그 로그 ───
// "토글 시 위젯이 위로 튀어나옴" 진단용. 사용자가 보내주면 정확한 OS 동작 추적.
// 파일 위치: %APPDATA%\SchoolDesk\wallpaper-debug.log
let _wDebugStarted = false
function wDebug(msg: string): void {
  try {
    const dir = process.env.APPDATA
      ? join(process.env.APPDATA, 'SchoolDesk')
      : join(homedir(), '.SchoolDesk')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, 'wallpaper-debug.log')
    if (!_wDebugStarted) {
      appendFileSync(file, `\n========= SESSION START ${new Date().toISOString()} =========\n`)
      _wDebugStarted = true
    }
    const t = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
    appendFileSync(file, `[${t}] ${msg}\n`)
  } catch { /* 로그 실패는 무시 */ }
}

const HWND_BOTTOM = 1
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020
const SWP_NOOWNERZORDER = 0x0200

const GWL_EXSTYLE = -20
// "창이 포커스를 받지 못하도록" 하는 extended style. 클릭해도 foreground 로 안 올라감.
const WS_EX_NOACTIVATE = 0x08000000
// Alt+Tab 목록에서 제외. 배경화면처럼 동작하도록.
const WS_EX_TOOLWINDOW = 0x00000080
// 클릭 통과(click-through). setIgnoreMouseEvents(true) 가 세팅하는데, 해제 시 가끔 안 지워져 클릭을 죽이는 원흉.
const WS_EX_TRANSPARENT = 0x00000020

function initWin32Z(): void {
  if (process.platform !== 'win32') return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    // HWND 인자는 'intptr' (= int64 on x64) 로 받는다 — 'void*' 로 받으면 Buffer 주소가 전달되어 실패.
    _setWindowPos = user32.func('__stdcall', 'SetWindowPos',
      'bool', ['intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint']
    ) as unknown as SetWindowPosFn
    _getWindowLongPtr = user32.func('__stdcall', 'GetWindowLongPtrA',
      'intptr', ['intptr', 'int']
    ) as unknown as GetWindowLongPtrFn
    _setWindowLongPtr = user32.func('__stdcall', 'SetWindowLongPtrA',
      'intptr', ['intptr', 'int', 'intptr']
    ) as unknown as SetWindowLongPtrFn
    // 디버그용 — 토글 후 어떤 창이 위에 있는지 + SetWindowPos 실패 코드 확인.
    _getForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow',
      'intptr', []
    ) as unknown as GetForegroundWindowFn
    _getWindow = user32.func('__stdcall', 'GetWindow',
      'intptr', ['intptr', 'uint']
    ) as unknown as GetWindowFn
    const kernel32 = koffi.load('kernel32.dll')
    _getLastError = kernel32.func('__stdcall', 'GetLastError',
      'uint', []
    ) as unknown as GetLastErrorFn
  } catch (err) {
    // koffi 로드 실패 — 일반 Electron 동작으로 fallback
    console.warn('[z-order] koffi load failed:', err)
    wDebug(`koffi load FAILED: ${err}`)
  }
}

/** Buffer 형태의 native window handle 에서 HWND 값(BigInt) 추출. x64 = 8바이트 정수. */
function hwndOf(win: BrowserWindow): bigint {
  return win.getNativeWindowHandle().readBigUInt64LE(0)
}

/** hwnd 가 현재 wallpaper 모드인 다른 위젯의 hwnd 와 일치하는지. */
function isOtherWallpaperHwnd(hwnd: bigint, selfId: string): boolean {
  for (const id of wallpaperWidgets.keys()) {
    if (id === selfId) continue
    const w = widgetWindows.get(id)
    if (!w || w.isDestroyed()) continue
    try { if (hwndOf(w) === hwnd) return true } catch { /* noop */ }
  }
  return false
}

/**
 * Smart BOTTOM push — 위젯끼리 z-order 경쟁(=깜빡임) 회피.
 *  - 위에 다른 wallpaper widget 만 있으면 가만히 둔다 (그것도 BOTTOM 가려는 중이라 무의미).
 *  - 외부 앱이 위에 있을 때만 BOTTOM 강제.
 *  - hwnd 위가 없으면(=내가 가장 위) 무조건 BOTTOM.
 */
function pushWindowToBackSmart(win: BrowserWindow, widgetId: string): void {
  if (!_setWindowPos || win.isDestroyed()) return
  try {
    const hwnd = hwndOf(win)
    const above = _getWindow ? _getWindow(hwnd, GW_HWNDPREV) : 1n
    // above === 0n: 내가 z-order 최상위 — BOTTOM 으로 보내야 함
    // above 가 다른 wallpaper widget: 가만히 (z-order 경쟁 회피)
    // 그 외: 외부 앱이 위에 있음 — BOTTOM
    if (above !== 0n && isOtherWallpaperHwnd(above, widgetId)) return
    _setWindowPos(hwnd, BigInt(HWND_BOTTOM), 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
  } catch { /* 무시 */ }
}

function pushWindowToBack(win: BrowserWindow, ctx?: string): void {
  if (!_setWindowPos || win.isDestroyed()) return
  try {
    const hwnd = hwndOf(win)
    const result = _setWindowPos(hwnd, BigInt(HWND_BOTTOM), 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
    // ctx 가 명시된 호출만 로그(self-tick·글로벌 tick 은 너무 많아 제외).
    if (ctx) {
      const myHwnd = '0x' + hwnd.toString(16)
      const fg = _getForegroundWindow ? '0x' + _getForegroundWindow().toString(16) : '?'
      const err = !result && _getLastError ? _getLastError() : 0
      const isMe = fg === myHwnd
      wDebug(`[${ctx}] me=${myHwnd} SetWindowPos=${result} err=${err} fg=${fg} fgIsMe=${isMe}`)
    }
  } catch (e) { wDebug(`pushBack[${ctx ?? 'tick'}] EXCEPTION: ${e}`) }
}

/**
 * 배경화면 모드 해제 시 잔류 `WS_EX_TRANSPARENT` 강제 제거.
 *
 * setIgnoreMouseEvents(false) 가 정상 경로에선 이 플래그를 지우지만,
 * ON/OFF 를 빠르게 반복하면 가끔 안 지워져 **모든 클릭이 위젯을 통과**하는
 * 치명적 버그가 발생한다 (사용자 리포트). 방어로 Win32 로 직접 제거.
 */
function forceClearClickThrough(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  if (!_getWindowLongPtr || !_setWindowLongPtr || !_setWindowPos) return
  if (win.isDestroyed()) return
  try {
    const hwnd = hwndOf(win)
    const cur = _getWindowLongPtr(hwnd, GWL_EXSTYLE)
    const next = cur & ~BigInt(WS_EX_TRANSPARENT)
    if (next === cur) return
    _setWindowLongPtr(hwnd, GWL_EXSTYLE, next)
    _setWindowPos(hwnd, 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
  } catch { /* noop */ }
}

/**
 * 배경화면 모드에 필요한 Win32 extended style 적용/해제.
 * 진입 시: WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW 부여 — 클릭해도 foreground 로 안 올라옴.
 * 해제 시: 두 플래그 제거.
 * 스타일 변경 후 SWP_FRAMECHANGED 로 윈도우에 변경 사항 알림 필수.
 */
function setWindowNoActivate(win: BrowserWindow, enable: boolean): void {
  if (process.platform !== 'win32') return
  if (!_getWindowLongPtr || !_setWindowLongPtr || !_setWindowPos) return
  if (win.isDestroyed()) return
  try {
    const hwnd = hwndOf(win)
    const cur = _getWindowLongPtr(hwnd, GWL_EXSTYLE)
    const mask = BigInt(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
    const next = enable ? (cur | mask) : (cur & ~mask)
    if (next === cur) return
    _setWindowLongPtr(hwnd, GWL_EXSTYLE, next)
    // 프레임 변경 통보 — 이게 있어야 extended style 이 즉시 적용됨.
    _setWindowPos(hwnd, 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
  } catch { /* OS·권한 이슈 시 조용히 무시 */ }
}
import { getDatabase, closeDatabase } from './database/connection'
import { registerIpcHandlers } from './ipc/handlers'
import { startBackupScheduler, stopBackupScheduler } from './lib/backup-scheduler'
import { seedTemplates, deleteExpiredCheckedItems } from './database/repositories/checklist.repo'
import { getWidgetPositions, saveWidgetPosition, getSetting } from './database/repositories/settings.repo'

const AUTO_START_REG_NAME = 'SchoolDesk'
const AUTO_START_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const STARTUP_CMD_FILENAME = 'SchoolDesk-AutoStart.cmd'

function logAutoStart(msg: string): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'autostart.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch { /* noop */ }
}

function isPortableWin(): boolean {
  return process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE
}

function getStartupFolder(): string {
  // %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
  return join(
    app.getPath('appData'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  )
}

function getStartupCmdPath(): string {
  return join(getStartupFolder(), STARTUP_CMD_FILENAME)
}

// (writeStartupCmd는 레지스트리 Run 방식으로 통일하면서 제거됨.
//  removeStartupCmd는 legacy 배치파일 정리 목적으로 유지)

function removeStartupCmd(): void {
  try {
    const filePath = getStartupCmdPath()
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      logAutoStart(`startup cmd removed: ${filePath}`)
    }
  } catch (err) {
    logAutoStart(`removeStartupCmd error: ${String(err)}`)
  }
}

function regExePath(): string {
  // reg.exe 절대경로 우선, 실패 시 PATH 검색 fallback
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const abs = join(win, 'System32', 'reg.exe')
  return existsSync(abs) ? abs : 'reg'
}

function regAddAutoStart(exePath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      regExePath(),
      [
        'add', AUTO_START_REG_KEY,
        '/v', AUTO_START_REG_NAME,
        '/t', 'REG_SZ',
        '/d', `"${exePath}" --autostart`,
        '/f',
      ],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) logAutoStart(`reg add error: ${err.message} | stderr: ${stderr}`)
        else logAutoStart(`reg add ok: ${stdout.trim()}`)
        resolve()
      },
    )
  })
}

function regDeleteAutoStart(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      regExePath(),
      ['delete', AUTO_START_REG_KEY, '/v', AUTO_START_REG_NAME, '/f'],
      { windowsHide: true },
      () => resolve(),
    )
  })
}

function regQueryAutoStart(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      regExePath(),
      ['query', AUTO_START_REG_KEY, '/v', AUTO_START_REG_NAME],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const m = stdout.match(/REG_SZ\s+(.+)/)
        resolve(m ? m[1].trim() : null)
      },
    )
  })
}

async function applyAutoStart(enabled: boolean): Promise<void> {
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      args: ['--autostart'],
    })
    return
  }
  if (process.platform !== 'win32') return

  if (isPortableWin()) {
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE!
    logAutoStart(`applyAutoStart(portable) enabled=${enabled} exe=${exePath}`)
    // Legacy cleanup: 이전 버전에서 만든 Startup 폴더의 배치파일이 있으면 제거
    // (현재는 레지스트리 Run 키만 사용)
    removeStartupCmd()
    if (enabled) {
      await regAddAutoStart(exePath)
    } else {
      await regDeleteAutoStart()
    }
    return
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: ['--autostart'],
  })
}

async function isAutoStartEnabled(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().openAtLogin
  }
  if (process.platform !== 'win32') return false
  if (isPortableWin()) {
    return (await regQueryAutoStart()) !== null
  }
  return app.getLoginItemSettings({ args: ['--autostart'] }).openAtLogin
}

function isLaunchedAtStartup(): boolean {
  if (process.argv.includes('--autostart')) return true
  if (process.platform === 'win32') {
    return app.getLoginItemSettings({ args: ['--autostart'] }).wasOpenedAtLogin
  }
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().wasOpenedAtLogin
  }
  return false
}

type WidgetType =
  | 'calendar' | 'task' | 'memo' | 'timetable'
  | 'checklist' | 'timer' | 'dday' | 'clock' | 'routine' | 'goal' | 'studentcheck'
  | 'studenttimetable' | 'today' | 'studentrecord' | 'meal' | 'noticeboard'

const WIDGET_DEFAULTS: Record<WidgetType, { w: number; h: number }> = {
  calendar:  { w: 360, h: 420 },
  task:      { w: 340, h: 460 },
  memo:      { w: 320, h: 360 },
  timetable: { w: 280, h: 440 },
  checklist: { w: 320, h: 420 },
  timer:     { w: 300, h: 360 },
  dday:      { w: 320, h: 300 },
  clock:     { w: 300, h: 200 },
  routine:   { w: 340, h: 440 },
  goal:      { w: 340, h: 260 },
  studentcheck: { w: 380, h: 480 },
  studenttimetable: { w: 420, h: 280 },
  today:     { w: 440, h: 320 },
  studentrecord: { w: 380, h: 460 },
  meal:      { w: 380, h: 360 },
  noticeboard: { w: 420, h: 280 },
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
const widgetWindows = new Map<string, BrowserWindow>()
/** Pin ON 상태인 위젯 id 집합. blur 시 뒤로 안 보냄. */
const pinnedWidgets = new Set<string>()
/**
 * 배경화면 모드: 클릭 통과 + z-order 최하단 고정. 키 = widget_id.
 * 값 = periodic re-push interval id. 다른 창이 위로 올라와도 2초마다 HWND_BOTTOM 재적용.
 */
const wallpaperWidgets = new Map<string, NodeJS.Timeout>()
/**
 * 디스플레이 모드 전역 활성 여부. true 이면 모든 위젯(Pin/Wallpaper 제외) 에
 * NOACTIVATE + focusable=false 를 걸어 "배경화면 모드처럼 포커스 못가지고 맨 뒤로" 동작.
 */
let displayModeGlobalOn = false
/** 잠금 컴팩트 모드인 위젯 window id 집합 — 이 상태에서 발생한 resize 는 DB 저장 건너뜀. */
const lockedCompactWindows = new Set<number>()
/** 잠금 직전 "확장 상태" 창 높이 저장 — 잠금 해제 시 복구용. key = win.id */
const lockedCompactPrevHeight = new Map<number, number>()
/**
 * 시작 직후 N 초간 'move'/'resize' 이벤트로 인한 DB 저장을 차단하는 grace window.
 * Windows 가 부팅 직후 외부 모니터 미인식 상태에서 saved 좌표를 화면 밖으로 판단하면
 * BrowserWindow 를 메인 화면 좌상단(0,0) 근처로 강제 이동시키는데, 이때 'move' 이벤트가
 * 발사되어 그 잘못된 좌표가 DB 에 저장되면 다음 부팅 때마다 영구히 같은 자리로 모임.
 * 이 grace window 안에서는 reconcile 로직만 좌표를 갱신할 수 있다.
 */
const startupGraceWidgets = new Set<string>()
/** 인스턴스 spread 시 같은 widgetType 이 겹치지 않도록 사용하는 누적 카운터 */
let widgetSpawnCounter = 0

/**
 * 기본 위젯 스타일.
 * 일반 모드에서는 NOACTIVATE 를 쓰지 않음 — 클릭해서 타이핑·편집이 가능해야 하므로.
 * "뒤로" 는 blur 이벤트 + 글로벌 틱 pushWindowToBack 으로 처리.
 * NOACTIVATE 는 배경화면/디스플레이 모드 전용.
 */
function applyDefaultNoActivate(win: BrowserWindow, widgetId: string): void {
  if (win.isDestroyed()) return
  if (wallpaperWidgets.has(widgetId)) return
  // 기본은 NOACTIVATE 해제 — 타이핑/편집 지원. 모드별 특수 동작은 각자 경로에서 처리.
  setWindowNoActivate(win, false)
}

/**
 * 글로벌 "위젯 항상 뒤로" 타이머 — 배경화면 모드 아닌 위젯도 항상 아래에 깔리게.
 *
 * 포커스 중인 위젯은 제외 — 사용자가 텍스트 입력/편집 중이면 창이 뒤로 가면 안 됨.
 * blur 발생 즉시 scheduleBackPush 가 실행되므로 포커스 해제 후 자연스럽게 뒤로.
 */
let _bottomTickTimer: NodeJS.Timeout | null = null
function startBottomTickTimer(): void {
  if (_bottomTickTimer) return
  _bottomTickTimer = setInterval(() => {
    for (const [id, w] of widgetWindows) {
      if (w.isDestroyed()) continue
      if (pinnedWidgets.has(id)) continue   // Pin 상태 — 위에 유지
      if (wallpaperWidgets.has(id)) continue // 배경화면 모드는 자체 tick
      // 일반 모드: 포커스 상태면 편집 중이니 건드리지 않음.
      // 디스플레이 모드: NOACTIVATE 로 포커스가 애초에 잘 안 걸리지만, 혹시 걸려도 무조건 뒤로.
      if (!displayModeGlobalOn && w.isFocused()) continue
      pushWindowToBackSmart(w, id)
    }
  }, 500)  // 220→500ms — 위젯끼리 겹친 경계 깜빡임 줄이기. 다른 앱 덮어씀 → 최대 500ms 안에 BOTTOM.
}
function stopBottomTickTimer(): void {
  if (_bottomTickTimer) { clearInterval(_bottomTickTimer); _bottomTickTimer = null }
}

/**
 * 배경화면 모드에 들어가면 "창 자체를 감춰야" 하는 위젯 타입 목록.
 * (빈 콘텐츠로 렌더만 해두면 드래그 가능한 빈 창이 남아 바탕에 흔적으로 남음 — 완전 hide)
 * 사용자 요청: 타이머는 배경화면 모드에서도 보이게 → hide 대상에서 제외.
 */
const HIDE_ON_WALLPAPER_TYPES = new Set<string>([])
// 단축키 toggle 시 wallpaper 모드 가능한 위젯 타입 — src/types/widget.types.ts 와 동기.
// studentcheck 제외 — 사용자 요청 ("학급 체크는 배경화면 모드 빼달라").
// timer 제외 — 사용자 요청 ("타이머는 배경화면 모드 삭제. 전체 배경화면 모드 시 디스플레이 모드로 동기").
//   전체 배경화면 모드 시 enterAllWallpaperMode 가 broadcastAllDisplayMode(true) 도 호출하므로
//   타이머는 WidgetShell 의 shellDisplayMode 만 켜져 헤더가 숨겨진 디스플레이 모드 모양이 됨.
const WALLPAPER_ELIGIBLE_TYPES_M = new Set<string>([
  'timetable', 'calendar', 'goal',
  'studenttimetable', 'dday', 'clock', 'today', 'meal',
])

/** 열린 모든 wallpaper-eligible 위젯을 한 번에 wallpaper 모드 ON.
 *  사용자 요청: wallpaper 모드 진입 시 wallpaper 가 안 되는 다른 위젯들은 디스플레이 모드로
 *  전환 → 전자칠판/발표용으로 한 번에 깔끔하게 정렬되도록. */
function enterAllWallpaperMode(): void {
  for (const [id] of widgetWindows) {
    if (wallpaperWidgets.has(id)) continue       // 이미 ON
    if (pinnedWidgets.has(id)) continue          // 핀 고정은 제외
    const widgetType = id.replace(/^widget-/, '').split('-')[0]
    if (!WALLPAPER_ELIGIBLE_TYPES_M.has(widgetType)) continue
    try { setWallpaperMode(id, true) } catch { /* noop */ }
  }
  // wallpaper 가 아닌 나머지 위젯들도 헤더 숨기고 뒤로 보내기 — 디스플레이 모드 활성화.
  try { broadcastAllDisplayMode(true) } catch { /* noop */ }
}

/** 배경화면 모드 ON/OFF. 실패해도 예외 전파 안 함(UX 우선). */
function setWallpaperMode(widgetId: string, on: boolean): void {
  const win = widgetWindows.get(widgetId)
  if (!win || win.isDestroyed()) return

  wDebug(`>>> setWallpaperMode(${widgetId}, on=${on}) ENTER`)

  const existing = wallpaperWidgets.get(widgetId)
  if (existing) { clearInterval(existing); wallpaperWidgets.delete(widgetId) }

  const widgetType = widgetId.replace(/^widget-/, '').split('-')[0]
  const hideEntirely = HIDE_ON_WALLPAPER_TYPES.has(widgetType)
  // 토글 후 50ms / 200ms / 800ms / 2초 시점 z-order 추적 — "어디서 위로 올라가는지" 확인.
  const traceTimes = [50, 200, 800, 2000]
  for (const ms of traceTimes) {
    setTimeout(() => {
      if (win.isDestroyed()) return
      pushWindowToBack(win, `${on ? 'ON' : 'OFF'}-trace-${ms}ms`)
    }, ms)
  }

  if (on) {
    try {
      // 클릭 통과 — forward 옵션 없이 true 만 — forward:true 는 재해제 시 WS_EX_TRANSPARENT 잔류 버그 유발.
      win.setIgnoreMouseEvents(true)
      pinnedWidgets.delete(widgetId)
      win.setAlwaysOnTop(false)
      win.setSkipTaskbar(true)
      // setFocusable 호출 제거 — Windows z-order 재계산/클릭 차단 부작용. Win32 NOACTIVATE 만 사용.
      setWindowNoActivate(win, true)
      // 이 창에 남아있던 포커스만 해제.
      // mainWindow.focus() 는 사용자가 다른 앱에서 작업 중일 때 대시보드를
      // foreground 로 끌어올리는 부작용이 있어 제거.
      try { win.blur() } catch { /* noop */ }
      pushWindowToBack(win)
      // 연타 시 튀어나옴 방지 — 5단 retry. 19단 → 5단 줄여 깜빡임 완화.
      for (const delay of [50, 200, 600, 1500, 3000]) {
        setTimeout(() => { if (!win.isDestroyed()) pushWindowToBack(win) }, delay)
      }
      // 다른 창이 위에 올라오면 다시 맨 뒤로 — smart 버전: 다른 wallpaper widget 위에 있을 땐 가만히.
      const t = setInterval(() => {
        if (win.isDestroyed()) { clearInterval(t); wallpaperWidgets.delete(widgetId); return }
        pushWindowToBackSmart(win, widgetId)
      }, 500)
      wallpaperWidgets.set(widgetId, t)
      // 완전 숨김 대상이면 한 프레임 지나고 hide — 먼저 상태 이벤트 dispatch 가 끝나도록.
      if (hideEntirely) {
        setTimeout(() => { if (!win.isDestroyed()) win.hide() }, 30)
      }
    } catch { /* OS별 실패는 무시 */ }
    try {
      saveWidgetPosition({ widget_id: widgetId, widget_type: widgetType as WidgetType, wallpaper_mode: 1 })
    } catch { /* noop */ }
  } else {
    try {
      // 1) 클릭 통과 해제 — 두 번 호출해 확실히.
      win.setIgnoreMouseEvents(false)
      // 30ms 지연 재호출도 wallpaper 재켜짐 확인 — 안 하면 ON 중에 click-through 를 깸.
      setTimeout(() => {
        if (win.isDestroyed()) return
        if (wallpaperWidgets.has(widgetId)) return // 다시 ON 된 경우 건드리지 않음
        try { win.setIgnoreMouseEvents(false) } catch { /* noop */ }
      }, 30)
      win.setSkipTaskbar(true)
      // 3) hide 됐던 창 복원 (timer 등).
      if (!win.isVisible()) { try { win.showInactive() } catch { /* noop */ } }
      // 4) NOACTIVATE 해제 — 일반 창 동작 복귀.
      applyDefaultNoActivate(win, widgetId)
      // 5) WS_EX_TRANSPARENT 강제 제거 — 지연 호출도 wallpaper 재켜짐 시 중단.
      forceClearClickThrough(win)
      for (const delay of [50, 150, 400, 900]) {
        setTimeout(() => {
          if (win.isDestroyed()) return
          if (wallpaperWidgets.has(widgetId)) return
          forceClearClickThrough(win)
        }, delay)
      }
      // 6) 연타 시 튀어나옴 방지 — 5단 retry. 19단 → 5단 줄여 깜빡임 완화.
      try { win.setAlwaysOnTop(false) } catch { /* noop */ }
      pushWindowToBack(win)
      for (const delay of [50, 200, 600, 1500, 3000]) {
        setTimeout(() => {
          if (win.isDestroyed()) return
          if (wallpaperWidgets.has(widgetId)) return // 다시 ON 됐으면 ON 쪽 재시도가 처리
          if (pinnedWidgets.has(widgetId)) return
          try { win.setAlwaysOnTop(false) } catch { /* noop */ }
          pushWindowToBack(win)
        }, delay)
      }
    } catch { /* noop */ }
    try {
      saveWidgetPosition({ widget_id: widgetId, widget_type: widgetType as WidgetType, wallpaper_mode: 0 })
    } catch { /* noop */ }
  }

  // ★ 연타 시 "다른 위젯이 앞으로 튀어나오는" 증상 대응.
  //    toggle 이 일어나는 순간, 토글된 위젯뿐 아니라 다른 모든 위젯(Pin/배경모드 제외)도
  //    한번에 뒤로 밀어서 싱크. 글로벌 틱(220ms) 보다 더 적극적으로 — 즉시+여러 단 retry.
  const pushOthers = (): void => {
    for (const [otherId, otherWin] of widgetWindows) {
      if (otherId === widgetId) continue
      if (otherWin.isDestroyed()) continue
      if (pinnedWidgets.has(otherId)) continue
      if (wallpaperWidgets.has(otherId)) continue // 자체 tick 이 처리
      try { pushWindowToBack(otherWin) } catch { /* noop */ }
    }
  }
  pushOthers()
  for (const delay of [80, 250, 700, 1800]) {
    setTimeout(pushOthers, delay)
  }

  // 상태 변경을 대시보드 + 모든 위젯 창에 브로드캐스트.
  const payload = { widgetId, on }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('wallpaper-mode-changed', payload) } catch { /* noop */ }
  }
  for (const w of widgetWindows.values()) {
    if (w.isDestroyed()) continue
    try { w.webContents.send('wallpaper-mode-changed', payload) } catch { /* noop */ }
  }
}

/** 배경 모드인 위젯 전체 해제 — 탈출용 단축키/트레이에서 호출. */
function exitAllWallpaperMode(): void {
  for (const widgetId of Array.from(wallpaperWidgets.keys())) {
    setWallpaperMode(widgetId, false)
  }
}

/**
 * 창 보안 강화: Electron 보안 권장사항 Phase 3~6
 * - 외부 네비게이션 차단
 * - window.open은 기본 브라우저로만 열기
 * - 권한 요청 기본 거부 (로컬 앱은 어떤 permission도 불필요)
 */
function hardenBrowserWindow(win: BrowserWindow): void {
  // (1) window.open / target="_blank" → 외부 URL은 기본 브라우저로 넘기고 새 Electron 창은 거부
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => { /* noop */ })
    }
    return { action: 'deny' }
  })

  // (2) renderer가 다른 URL로 navigate 시도하면 차단. file:// 내부 이동만 허용.
  win.webContents.on('will-navigate', (event, url) => {
    const allowedPrefixes = [
      process.env.ELECTRON_RENDERER_URL ?? '',
      'file://',
    ]
    const ok = allowedPrefixes.some((p) => p && url.startsWith(p))
    if (!ok) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
    }
  })

  // (3) webview attach 거부 — 앱이 webview 태그를 쓰지 않음
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

// 위젯이 여러 개 연속으로 뜰 때 마다 메인 창을 맨 앞으로 재정렬.
// debounce로 마지막 호출에만 moveTop 실행.
let mainOnTopTimer: NodeJS.Timeout | null = null
function scheduleMainWindowOnTop(): void {
  if (mainOnTopTimer) clearTimeout(mainOnTopTimer)
  mainOnTopTimer = setTimeout(() => {
    mainOnTopTimer = null
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return
    mainWindow.moveTop()
  }, 180)
}

function loadRendererUrl(win: BrowserWindow, hash = ''): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL + hash)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.replace(/^#/, '') })
  }
}

function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    show: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#F8FAFC',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload가 contextBridge + ipcRenderer만 사용하므로 OS sandbox 활성화 가능 (defense in depth)
      sandbox: true,
      // 명시적 보안 강화 (Electron 기본값이지만 배포 감사 목적)
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      // 창이 숨겨지거나 뒤로 가도 타이머/오디오가 멈추지 않도록
      backgroundThrottling: false,
    },
  })

  const startMinimized = process.argv.includes('--autostart')
  mainWindow.on('ready-to-show', () => {
    if (!startMinimized) mainWindow?.show()
  })

  mainWindow.on('close', (e) => {
    e.preventDefault()
    mainWindow?.hide()
  })

  loadRendererUrl(mainWindow)

  return mainWindow
}

/**
 * 위젯 좌표가 현재 디스플레이 안에 충분히 들어 있는지 검사.
 *  - "1픽셀이라도 겹치면 OK" 였던 종전 로직은 외부 모니터 disconnect 시
 *    saved 좌표가 거의 화면 밖인데도 통과시켰다 → Windows OS 가 강제로 메인 화면
 *    풀스크린에 가까운 위치로 이동 → win.on('move')→persistBounds 가 그 좌표를 DB 에 저장 → 영구화.
 *  - 새 규칙: 위젯의 "중심점" 이 어느 디스플레이의 visible bounds 안에 있어야 onScreen.
 *  - off-screen 이면 null 반환 → 호출자가 spread 사용. 더 이상 (80, 80) fallback 으로
 *    여러 위젯이 한 점에 모이지 않음.
 */
function isOnScreen(x: number, y: number, w: number, h: number): boolean {
  const displays = screen.getAllDisplays()
  const cx = x + w / 2
  const cy = y + h / 2
  return displays.some((d) => {
    const b = d.bounds
    return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
  })
}

function clampToScreen(x: number, y: number, w: number, h: number): { x: number; y: number } | null {
  return isOnScreen(x, y, w, h) ? { x, y } : null
}

/**
 * "비정상 풀스크린" 좌표 감지.
 *
 * OS 재부팅 직후 외부 모니터가 인식되기 전 SchoolDesk 가 시작되면 Windows 가
 * saved 좌표(외부 모니터 영역)를 화면 밖으로 판단해 메인 화면에 강제로 이동시키면서
 * 사이즈도 풀스크린에 가깝게 부풀린다. 그 좌표가 그대로 DB 에 저장되면 다음 부팅 때마다
 * "여러 위젯이 같은 풀스크린 위치에 겹친다" 는 증상이 영구화됨.
 *
 * 이 함수는 그런 좌표를 식별: 어떤 디스플레이의 workArea 의 85% 이상을 차지하면 비정상.
 */
function isAnomalousFullscreen(w: number, h: number): boolean {
  if (w < 600 || h < 400) return false
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea
    if (w >= wa.width * 0.85 && h >= wa.height * 0.85) return true
  }
  return false
}

const WIDGET_ORDER: WidgetType[] = [
  'clock', 'calendar', 'today', 'meal', 'task', 'memo',
  'timetable', 'studenttimetable', 'checklist', 'timer', 'dday',
  'routine', 'goal', 'studentcheck',
]

function getSpreadPosition(widgetType: WidgetType, _w: number, _h: number): { x: number; y: number } {
  const work = screen.getPrimaryDisplay().workArea
  const baseIdx = WIDGET_ORDER.indexOf(widgetType)
  const safeIdx = baseIdx < 0 ? widgetSpawnCounter : (baseIdx + widgetSpawnCounter)
  widgetSpawnCounter += 1
  // ★ 통일 그리드 + cycle wrap.
  //   - 통일 셀: 위젯별 너비 차이로 같은 row 의 col 위치가 어긋나는 겹침을 차단.
  //   - cycle wrap: 14 개 위젯을 일렬로 쌓으면 row 가 커져 화면 밖(y=2000+)으로 떨어짐 (사용자
  //     로그 검증). 그리드가 화면을 채우면 처음으로 돌아오면서 30px diagonal offset 을 줘서
  //     overflow cycle 의 위젯도 starting 좌표 unique 유지 + 화면 안 보장.
  //   - CELL_W=380 / CELL_H=380 = WIDGET_DEFAULTS 의 흔한 사이즈(280~440w, 200~480h) 평균.
  //     사용자가 default 보다 크게 리사이즈한 위젯(calendar 742w 등)은 옆 셀 영역에 시각적으로
  //     걸칠 수 있지만 시작 좌표는 여전히 unique → 사용자가 드래그로 정리 가능.
  const CELL_W = 380
  const CELL_H = 380
  const safeWidth = Math.max(800, work.width)
  const safeHeight = Math.max(600, work.height)
  const cols = Math.max(2, Math.floor((safeWidth - 40) / CELL_W))
  const rows = Math.max(2, Math.floor((safeHeight - 40) / CELL_H))
  const totalCells = cols * rows
  // safeIdx 가 totalCells 를 넘으면 cycle 시작 — 같은 (col,row) 에 다시 가지만 30px diagonal
  // offset 으로 starting 좌표는 unique. 화면 밖으로는 절대 안 나감.
  const cycleIdx = safeIdx % totalCells
  const overflowCycle = Math.floor(safeIdx / totalCells)
  const wrapOffset = overflowCycle * 30
  const col = cycleIdx % cols
  const row = Math.floor(cycleIdx / cols)
  const rawX = work.x + 20 + col * CELL_W + wrapOffset
  const rawY = work.y + 20 + row * CELL_H + wrapOffset
  return { x: rawX, y: rawY }
}

/**
 * 저장된 위젯 좌표들이 "한곳에 모여있는" 클러스터인지 감지.
 *
 * 사용자 신고: Windows 에서 5 일만에 앱을 켰더니 모든 위젯이 한 점에 모여있음.
 * 원인: 디스플레이 변경(외부 모니터 분리/스케일 변경) 후 OS 가 화면 밖이 된 위젯들을
 * 메인 화면 좌상단 부근으로 강제 이동시킴 → 'move' 이벤트 → DB 에 (작은 값, 작은 값)
 * 좌표가 저장됨 → 다음 부팅 때마다 같은 자리에 모임.
 *
 * isAnomalousFullscreen 는 풀스크린(≥85% workArea) 만 잡으므로 좌상단 클러스터를 못 막음.
 * 이 함수는 visible=1 위젯들의 중심점이 100px 반경 안에 3 개 이상 모여있으면 클러스터로 판단.
 *
 * 반환: 클러스터로 판정된 widget_id 들의 Set. 호출자는 이 위젯들의 saved 좌표를 무시하고
 * getSpreadPosition 으로 재배치해야 한다.
 */
type WidgetPositionRow = ReturnType<typeof getWidgetPositions>[number]
function detectClusteredWidgets(positions: WidgetPositionRow[]): Set<string> {
  const visible = positions.filter((p) =>
    p.is_visible === 1
    && typeof p.x === 'number'
    && typeof p.y === 'number'
    && typeof p.width === 'number'
    && typeof p.height === 'number'
  )
  if (visible.length < 3) return new Set()

  const RADIUS = 120 // px — "거의 같은 자리" 기준
  const centers = visible.map((p) => ({
    id: p.widget_id,
    cx: (p.x as number) + (p.width as number) / 2,
    cy: (p.y as number) + (p.height as number) / 2,
  }))

  // 모든 쌍에 대해 인접 그래프 → 가장 큰 연결 컴포넌트 ≥ 3 이면 클러스터.
  const adj = new Map<string, Set<string>>(centers.map((c) => [c.id, new Set<string>()]))
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const a = centers[i], b = centers[j]
      const dx = a.cx - b.cx, dy = a.cy - b.cy
      if (dx * dx + dy * dy <= RADIUS * RADIUS) {
        adj.get(a.id)!.add(b.id)
        adj.get(b.id)!.add(a.id)
      }
    }
  }

  // BFS 로 가장 큰 컴포넌트 찾기.
  const visited = new Set<string>()
  let largest = new Set<string>()
  for (const c of centers) {
    if (visited.has(c.id)) continue
    const comp = new Set<string>()
    const queue = [c.id]
    while (queue.length > 0) {
      const cur = queue.shift()!
      if (comp.has(cur)) continue
      comp.add(cur)
      visited.add(cur)
      for (const n of adj.get(cur) ?? []) if (!comp.has(n)) queue.push(n)
    }
    if (comp.size > largest.size) largest = comp
  }
  return largest.size >= 3 ? largest : new Set()
}

function createWidgetWindow(widgetType: WidgetType, instanceId?: string, options?: { ignoreSavedPosition?: boolean }): BrowserWindow | null {
  // 동일 widgetType의 다중 인스턴스를 지원하기 위해 instanceId(예: routine id)가 있으면
  // widget id와 url hash에 함께 반영. 기본 인스턴스는 기존과 동일한 'widget-<type>'.
  const widgetId = instanceId ? `widget-${widgetType}-${instanceId}` : `widget-${widgetType}`

  const existing = widgetWindows.get(widgetId)
  if (existing && !existing.isDestroyed()) {
    // 포커스를 주지 않고 조용히 복원 — "진짜 바탕화면" 동작.
    // hide()로 최소화됐던 위젯도 이 경로로 복원된다.
    try { existing.showInactive() } catch { /* ignore */ }
    setTimeout(() => { if (!existing.isDestroyed()) pushWindowToBack(existing) }, 40)
    return existing
  }

  const positions = getWidgetPositions()
  const saved = positions.find((p) => p.widget_id === widgetId)
  const defaults = WIDGET_DEFAULTS[widgetType]

  // saved 가 비정상 풀스크린(=OS 가 부팅 직후 외부 모니터 미인식 상태에서 강제 이동시킨 좌표)
  // 이면 width/height 도 신뢰할 수 없음 → defaults 로 복귀.
  const savedAnomalous = !!saved
    && typeof saved.width === 'number'
    && typeof saved.height === 'number'
    && isAnomalousFullscreen(saved.width, saved.height)

  const width = (!savedAnomalous && saved?.width) ? saved.width : defaults.w
  const height = (!savedAnomalous && saved?.height) ? saved.height : defaults.h

  // ignoreSavedPosition: 호출자가 "saved 좌표가 신뢰 불가" 라고 명시 (클러스터 감지된 경우).
  const hasSavedPos = !options?.ignoreSavedPosition
    && !savedAnomalous
    && typeof saved?.x === 'number'
    && typeof saved?.y === 'number'
  const clamped = hasSavedPos ? clampToScreen(saved!.x!, saved!.y!, width, height) : null
  const { x, y } = clamped ?? getSpreadPosition(widgetType, width, height)
  // 기본 불투명도 0.95 — 살짝 투명하게 해서 바탕화면 위에 자연스럽게 떠 있는 느낌.
  // 사용자가 투명도 슬라이더로 직접 더 조정 가능.
  const opacity = saved?.opacity ?? 0.95
  // 위젯은 '일할 때 방해 안 되도록' 무조건 맨 뒤에서 시작.
  // 사용자가 세션 중 Pin 버튼으로 임시로 위로 올릴 수 있지만, 다음 실행 땐 다시 맨 뒤.
  const alwaysOnTop = false

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 220,
    minHeight: 160,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop,
    skipTaskbar: true,
    resizable: true,
    roundedCorners: true,
    show: false,
    // focusable=true: 위젯 내부 입력 필드(메모·체크리스트 등) 에 타이핑 가능해야 한다는 사용자 결정.
    // 클릭 시 창이 순간적으로 foreground 로 올라오는 것은 허용하되, blur 즉시 pushWindowToBack 으로 뒤로.
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload가 contextBridge + ipcRenderer만 사용하므로 OS sandbox 활성화 가능 (defense in depth)
      sandbox: true,
      // 명시적 보안 강화 (Electron 기본값이지만 배포 감사 목적)
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      // 위젯이 뒤로 가도 타이머/오디오 정상 작동 — 벨소리가 안 울리는 문제 방지
      backgroundThrottling: false,
    },
  })

  win.setOpacity(opacity)
  // 저장된 글씨 크기 배율 — renderer 가 WidgetShell body 에 CSS zoom 으로 적용.
  // setZoomFactor 사용 안 함 (cqmin/vw 를 스케일하지 못해 콘텐츠 글씨가 안 커지는 버그).
  loadRendererUrl(win, instanceId ? `#widget=${widgetType}&instance=${encodeURIComponent(instanceId)}` : `#widget=${widgetType}`)

  win.on('ready-to-show', () => {
    // ★ OS 부팅 직후 외부 모니터 미인식 상태에서 BrowserWindow 가 saved 좌표를
    //  벗어났다고 판단되어 OS 가 임의로 옮긴 케이스 방어:
    //  ready-to-show 시점에 한 번 더 정상 좌표/사이즈를 강제 적용.
    //  현재 좌표가 정상이면 setBounds 도 변화가 없어 무해.
    try {
      const cur = win.getBounds()
      const targetX = x, targetY = y, targetW = width, targetH = height
      if (cur.x !== targetX || cur.y !== targetY || cur.width !== targetW || cur.height !== targetH) {
        wDebug(`ready-to-show[${widgetId}]: restore bounds ${cur.width}x${cur.height}@(${cur.x},${cur.y}) → ${targetW}x${targetH}@(${targetX},${targetY})`)
        win.setBounds({ x: targetX, y: targetY, width: targetW, height: targetH })
      }
    } catch { /* noop */ }
    // showInactive: 위젯이 포커스를 훔치지 않고 조용히 뒤에서 뜸.
    win.showInactive()
    // 첫 표시 후 맨 뒤로 한 번 밀기 (다른 작업 창들 뒤로)
    setTimeout(() => pushWindowToBack(win), 50)
    // 여러 위젯이 연속 뜰 때 메인 창이 뒤로 밀리지 않도록 마지막에 맨 앞으로.
    scheduleMainWindowOnTop()
  })

  // blur(다른 창 클릭) 시 자동으로 맨 뒤로 밀어냄. Pin ON이면 유지.
  // 사용자 요청: "바탕화면 모드 아닌 위젯도 항상 뒤로" — 즉시 + 분산 재시도로 Windows z-order 경쟁 상대(포커스 이동·show 이벤트) 모두 커버.
  const scheduleBackPush = (): void => {
    if (win.isDestroyed()) return
    if (pinnedWidgets.has(widgetId)) return
    if (wallpaperWidgets.has(widgetId)) return // 자체 tick 이 담당
    if (win.isFocused()) return // 편집 중 (입력 필드 포커스) 이면 뒤로 안 보냄
    // 분산 재시도 — show/move 후 다른 창이 올라와도 끝까지 맨 뒤로.
    for (const delay of [0, 60, 180, 400, 800]) {
      setTimeout(() => {
        if (win.isDestroyed()) return
        if (pinnedWidgets.has(widgetId)) return
        if (wallpaperWidgets.has(widgetId)) return
        if (win.isFocused()) return
        pushWindowToBack(win)
      }, delay)
    }
  }
  // blur = 사용자가 다른 창으로 갔으므로 즉시 맨 뒤로.
  win.on('blur', scheduleBackPush)
  // 위치/크기 변경·show 후에도 z-order 가 뒤바뀌는 경우가 있어 재확정.
  win.on('moved', scheduleBackPush)
  win.on('show', scheduleBackPush)

  const persistBounds = () => {
    if (win.isDestroyed()) return
    // ★ 시작 직후 grace window 안에서는 'move'/'resize' 로 인한 저장 차단.
    // Windows 가 디스플레이 미인식 상태에서 위젯을 좌상단(0,0) 근처로 강제 이동시키면
    // 'move' 이벤트가 발사되는데, 그 좌표를 DB 에 저장하면 모든 위젯이 한곳에 모이는
    // 증상이 영구화됨. reconcile 로직(display-added 등)만이 grace window 안에서 좌표 갱신 가능.
    if (startupGraceWidgets.has(widgetId)) {
      wDebug(`persistBounds[${widgetId}]: SKIP within startup grace window`)
      return
    }
    const b = win.getBounds()
    // ★ OS 가 부팅 직후 디스플레이 미인식 상태에서 위젯을 메인 화면 풀스크린에 가깝게
    // 강제 이동시킨 경우, 그 좌표를 DB 에 저장해버리면 다음 부팅 때마다 같은 자리에
    // 모이는 증상이 영구화됨. 비정상 풀스크린 사이즈는 절대 저장하지 않는다.
    if (isAnomalousFullscreen(b.width, b.height)) {
      wDebug(`persistBounds[${widgetId}]: SKIP anomalous fullscreen ${b.width}x${b.height} @ (${b.x},${b.y})`)
      return
    }
    // 화면 밖 좌표도 저장하지 않음 — 외부 모니터가 잠시 disconnect 됐을 때
    // OS 가 화면 밖 위치를 보고하더라도 saved 를 보호.
    if (!isOnScreen(b.x, b.y, b.width, b.height)) {
      wDebug(`persistBounds[${widgetId}]: SKIP off-screen (${b.x},${b.y}) ${b.width}x${b.height}`)
      return
    }
    // ★ lockedCompact (학생기록 위젯의 잠금 모드 등) 에서는 height 가 인위적으로 줄어든
    // 상태(120px 등). 그 값을 그대로 저장하면 다음 시작에 작은 위젯으로 시작하는 부작용.
    // 반면 사용자가 드래그한 x/y 와 width 는 정상이므로 보존해야 한다 → 좌표는 항상 저장,
    // height 만 lockedCompactPrevHeight 또는 saved 의 기존값으로 대체.
    const isLockedCompact = lockedCompactWindows.has(win.id)
    const heightToSave = isLockedCompact
      ? (lockedCompactPrevHeight.get(win.id) ?? defaults.h)
      : b.height
    saveWidgetPosition({
      widget_id: widgetId,
      widget_type: widgetType,
      x: b.x,
      y: b.y,
      width: b.width,
      height: heightToSave,
      is_visible: 1,
      always_on_top: alwaysOnTop ? 1 : 0,
      opacity,
    })
  }

  let moveDebounce: NodeJS.Timeout | null = null
  const debouncedPersist = () => {
    if (moveDebounce) clearTimeout(moveDebounce)
    // lockedCompact 차단 제거 — persistBounds 내부에서 height 만 안전하게 처리하므로
    // 사용자가 드래그한 x/y 가 항상 DB 에 저장된다.
    moveDebounce = setTimeout(persistBounds, 400)
  }
  win.on('move', debouncedPersist)
  win.on('resize', debouncedPersist)

  // 창이 destroy 되기 직전 마지막 bounds 강제 저장.
  // 사용자가 드래그 후 400ms debounce 가 발사되기 전에 X/앱종료를 눌러도 좌표 유실 없도록.
  win.on('close', () => {
    if (moveDebounce) { clearTimeout(moveDebounce); moveDebounce = null }
    if (win.isDestroyed()) return
    // lockedCompact 차단 제거 — persistBounds 가 height 를 prev 로 안전하게 저장한다.
    try { persistBounds() } catch (err) { _crashLog('persistBounds:close', err) }
  })

  const capturedWinId = win.id
  win.on('closed', () => {
    widgetWindows.delete(widgetId)
    pinnedWidgets.delete(widgetId)
    lockedCompactWindows.delete(capturedWinId)
    lockedCompactPrevHeight.delete(capturedWinId)
    const t = wallpaperWidgets.get(widgetId)
    if (t) { clearInterval(t); wallpaperWidgets.delete(widgetId) }
    saveWidgetPosition({ widget_id: widgetId, widget_type: widgetType, is_visible: 0 })
  })

  widgetWindows.set(widgetId, win)
  saveWidgetPosition({
    widget_id: widgetId,
    widget_type: widgetType,
    x, y, width, height,
    is_visible: 1,
    always_on_top: alwaysOnTop ? 1 : 0,
    opacity,
  })

  // 기본 스타일 적용 + 전역 디스플레이 모드가 켜진 상태라면 새 위젯도 동일하게 비포커스/뒤로.
  if (!alwaysOnTop) {
    win.once('ready-to-show', () => {
      try { applyDefaultNoActivate(win, widgetId) } catch (err) { _crashLog('applyDefaultNoActivate', err) }
      if (displayModeGlobalOn) {
        // setFocusable 제거 — 클릭 차단 부작용 방지. Win32 NOACTIVATE 만 사용.
        setWindowNoActivate(win, true)
        pushWindowToBack(win)
      }
    })
  } else {
    pinnedWidgets.add(widgetId)
  }

  // 저장된 배경화면 모드가 있으면 자동 적용 — 앱 재시작 후에도 그대로 유지.
  const savedWallpaper = (saved as { wallpaper_mode?: number } | undefined)?.wallpaper_mode
  if (savedWallpaper === 1) {
    // `ready-to-show` 직후 적용 — show() 먼저 끝나야 HWND가 유효.
    // setWallpaperMode 내부에서 어떤 이유로든 예외가 나도 앱 전체가 죽지 않도록 방어.
    win.once('ready-to-show', () => {
      setTimeout(() => {
        try { setWallpaperMode(widgetId, true) } catch (err) { _crashLog('restore-wallpaper', err) }
      }, 120)
    })
  }
  return win
}

function closeWidgetWindow(widgetType: WidgetType): void {
  const widgetId = `widget-${widgetType}`
  const win = widgetWindows.get(widgetId)
  if (win && !win.isDestroyed()) win.close()
}

/**
 * 모든 위젯을 spread 위치로 재배치 + DB 갱신.
 * 화면 밖으로 밀려난 위젯들을 화면 안으로 복귀시킬 때 사용.
 * 트레이 메뉴 + 대시보드 버튼 양쪽에서 호출.
 */
function resetAllWidgetPositions(): void {
  widgetSpawnCounter = 0  // spread 카운터 리셋 — 새 그리드로 깔끔하게.
  for (const [id, w] of widgetWindows) {
    try {
      if (w.isDestroyed()) continue
      const b = w.getBounds()
      const widgetType = id.replace(/^widget-/, '').split('-')[0] as WidgetType
      const pos = getSpreadPosition(widgetType, b.width, b.height)
      wDebug(`reset-positions[${id}]: ${b.width}x${b.height}@(${b.x},${b.y}) → @(${pos.x},${pos.y})`)
      w.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height })
      saveWidgetPosition({
        widget_id: id,
        widget_type: widgetType,
        x: pos.x, y: pos.y,
        width: b.width, height: b.height,
      })
    } catch (err) { _crashLog(`reset-positions:${id}`, err) }
  }
}

function restoreVisibleWidgets(): void {
  let positions: ReturnType<typeof getWidgetPositions> = []
  try { positions = getWidgetPositions() } catch (err) { _crashLog('getWidgetPositions', err); return }

  // ★ 클러스터 감지: visible 위젯들의 중심점이 한곳에 3 개 이상 모여있으면 saved 좌표 신뢰 불가.
  //   (Windows 가 디스플레이 변경 후 위젯들을 좌상단 근처로 모은 결과가 DB 에 영구화된 상태)
  const clustered = detectClusteredWidgets(positions)
  if (clustered.size > 0) {
    wDebug(`restoreVisibleWidgets: detected cluster of ${clustered.size} widgets — bypassing saved positions: ${[...clustered].join(', ')}`)
  }

  // ★ Startup grace: 복원 직후 ~5 초 동안 OS 가 강제 이동시키는 'move' 이벤트로 좌표가
  //   DB 에 덮어써지는 것을 차단. 이 윈도우 안에서는 reconcile 로직만 좌표 갱신 가능.
  const GRACE_MS = 5000
  const graceIds: string[] = []

  for (const p of positions) {
    if (p.is_visible !== 1) continue
    try {
      // widget_id가 'widget-<type>-<instanceId>' 형태면 instanceId 추출.
      // 기본 인스턴스('widget-<type>')는 instanceId=undefined.
      const prefix = `widget-${p.widget_type}`
      const instanceId = p.widget_id.startsWith(prefix + '-')
        ? p.widget_id.slice(prefix.length + 1)
        : undefined
      // grace 는 createWidgetWindow 내부에서 발생할 수 있는 즉시 'move' 도 막아야 하므로
      // 생성 직전에 등록.
      startupGraceWidgets.add(p.widget_id)
      graceIds.push(p.widget_id)
      const ignoreSavedPosition = clustered.has(p.widget_id)
      createWidgetWindow(p.widget_type as WidgetType, instanceId, { ignoreSavedPosition })
    } catch (err) {
      // 한 위젯 복원 실패가 다른 위젯 복원을 막지 않도록 개별 격리.
      _crashLog(`restoreWidget:${p.widget_type}`, err)
    }
  }

  // ★ 클러스터 감지된 위젯들은 새 spread 좌표를 즉시 DB 에 반영. grace 윈도우 안에서는
  //   persistBounds 가 차단되므로 명시적으로 한 번 저장.
  if (clustered.size > 0) {
    for (const id of clustered) {
      const w = widgetWindows.get(id)
      if (!w || w.isDestroyed()) continue
      try {
        const b = w.getBounds()
        if (!isOnScreen(b.x, b.y, b.width, b.height)) continue
        if (isAnomalousFullscreen(b.width, b.height)) continue
        const widgetType = id.replace(/^widget-/, '').split('-')[0] as WidgetType
        saveWidgetPosition({
          widget_id: id,
          widget_type: widgetType,
          x: b.x, y: b.y,
          width: b.width, height: b.height,
        })
      } catch (err) { _crashLog(`restoreCluster:save:${id}`, err) }
    }
  }

  // grace 해제 — 5 초 후. 사용자가 그 안에 위젯을 드래그해도 좌표가 저장 안 되는 단점은
  // 매우 작은 가격(드래그 직후 0.5~5 초 내 다시 드래그하지 않을 가능성 매우 높음)으로
  // OS 강제 이동에 의한 영구 클러스터링 방지라는 큰 이득과 교환.
  setTimeout(() => {
    for (const id of graceIds) startupGraceWidgets.delete(id)
    wDebug(`restoreVisibleWidgets: startup grace window closed (${graceIds.length} widgets)`)
  }, GRACE_MS)
}

function findTrayIconPath(): string | null {
  // 개발 / 패키징(asar) / extraResources 등 다양한 배포 형태를 모두 커버한다.
  const candidates = [
    join(__dirname, '../../resources/tray-icon.png'),
    join(process.resourcesPath || '', 'tray-icon.png'),
    join(process.resourcesPath || '', 'app.asar.unpacked/resources/tray-icon.png'),
    join(app.getAppPath(), 'resources/tray-icon.png'),
  ]
  for (const p of candidates) {
    try { if (p && existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

function createTray(): void {
  const iconPath = findTrayIconPath()
  let trayIcon: Electron.NativeImage = nativeImage.createEmpty()
  if (iconPath) {
    try {
      const img = nativeImage.createFromPath(iconPath)
      if (!img.isEmpty()) trayIcon = img
    } catch { /* ignore */ }
  }
  // 최종 fallback: 1x1 투명 PNG (적어도 플레이스홀더로는 동작)
  if (trayIcon.isEmpty()) {
    trayIcon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    )
  }
  tray = new Tray(trayIcon)
  tray.setToolTip('SchoolDesk — 선생님의 똑똑한 도우미')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '대시보드 열기',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: '빠른 입력 (Ctrl+K)',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.webContents.send('open-quick-input')
        }
      },
    },
    { type: 'separator' },
    {
      label: '모든 위젯 맨 뒤로 보내기',
      click: () => {
        for (const [id, w] of widgetWindows) {
          if (w.isDestroyed()) continue
          w.setAlwaysOnTop(false)
          pinnedWidgets.delete(id)
          pushWindowToBack(w)
        }
      },
    },
    {
      label: '모든 위젯 맨 앞에 고정',
      click: () => {
        for (const [id, w] of widgetWindows) {
          if (w.isDestroyed()) continue
          w.setAlwaysOnTop(true)
          pinnedWidgets.add(id)
        }
      },
    },
    { type: 'separator' },
    {
      label: '배경화면 모드 전체 토글  (Ctrl+Alt+Shift+W)',
      click: () => {
        if (wallpaperWidgets.size > 0) exitAllWallpaperMode()
        else enterAllWallpaperMode()
      },
    },
    {
      label: '디스플레이 모드 전체 해제  (Ctrl+Alt+Shift+D)',
      click: () => broadcastAllDisplayMode(false),
    },
    {
      label: '모든 위젯 닫기',
      click: () => {
        for (const w of widgetWindows.values()) {
          if (!w.isDestroyed()) w.close()
        }
      },
    },
    {
      label: '위젯 위치 초기화 (사라진 위젯 찾기)',
      click: () => resetAllWidgetPositions(),
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        for (const w of widgetWindows.values()) {
          if (!w.isDestroyed()) w.destroy()
        }
        mainWindow?.destroy()
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

function registerShortcuts(): void {
  globalShortcut.register('CommandOrControl+K', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.webContents.send('open-quick-input')
    }
  })
  // 배경화면 모드 토글 — 켜져 있으면 해제, 아니면 모든 가능 위젯 일괄 진입.
  // (배경화면 모드는 클릭 통과라 한 번 켜지면 UI 토글이 막혀 탈출용으로도 동작.)
  globalShortcut.register('CommandOrControl+Alt+Shift+W', () => {
    if (wallpaperWidgets.size > 0) exitAllWallpaperMode()
    else enterAllWallpaperMode()
  })
  // 디스플레이 모드 전체 해제 — 마스터 토글로 켠 상태에서 헤더 사라져 UI 해제가 어려울 때 탈출용.
  globalShortcut.register('CommandOrControl+Alt+Shift+D', () => {
    broadcastAllDisplayMode(false)
  })
}

function getWidgetWindowForEvent(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return null
  for (const w of widgetWindows.values()) {
    if (w === win) return w
  }
  return null
}

function registerWindowIpc(): void {
  ipcMain.on('window:minimize', (e) => {
    const widget = getWidgetWindowForEvent(e)
    if (widget) {
      // 위젯은 taskbar 에서 제외되어 있어 minimize() 가 "사라짐" 상태가 됨 — 대신 hide() 로 숨김.
      // 복원은 WidgetLauncher 에서 다시 켜짐 토글.
      try { widget.hide() } catch { /* ignore */ }
    } else {
      mainWindow?.minimize()
    }
  })
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on('window:close', (e) => {
    const widget = getWidgetWindowForEvent(e)
    if (widget) widget.close()
    else mainWindow?.hide()
  })
  ipcMain.on('window:always-on-top', (e, flag: boolean) => {
    const widget = getWidgetWindowForEvent(e)
    const target = widget ?? mainWindow
    if (!target) return
    target.setAlwaysOnTop(flag)
    // 위젯 핀 상태 갱신: ON이면 blur 시 뒤로 밀어내지 않음.
    if (widget) {
      for (const [id, w] of widgetWindows) {
        if (w === widget) {
          if (flag) {
            pinnedWidgets.add(id)
            // Pin 켜지면 NOACTIVATE 해제 — 포커스 받아 앞으로 올라오게.
            setWindowNoActivate(widget, false)
          } else {
            pinnedWidgets.delete(id)
            // Pin 해제 시 즉시 NOACTIVATE + 뒤로 밀기 — "항상 뒤" 기본 복귀.
            applyDefaultNoActivate(widget, id)
            setTimeout(() => pushWindowToBack(widget), 50)
          }
          break
        }
      }
    }
  })
  ipcMain.on('widget:setOpacity', (e, value: number) => {
    const widget = getWidgetWindowForEvent(e)
    widget?.setOpacity(Math.max(0.2, Math.min(1, value)))
  })
  ipcMain.on('widget:startDrag', (e) => {
    const widget = getWidgetWindowForEvent(e)
    if (!widget) return
    // placeholder for future native drag
  })

  ipcMain.handle('widget:openWindow', (_e, type: WidgetType, opts?: { instanceId?: string }) => {
    createWidgetWindow(type, opts?.instanceId)
  })
  ipcMain.handle('widget:closeWindow', (_e, type: WidgetType) => {
    closeWidgetWindow(type)
  })
  ipcMain.handle('widget:isOpen', (_e, type: WidgetType) => {
    const w = widgetWindows.get(`widget-${type}`)
    return !!(w && !w.isDestroyed())
  })
  ipcMain.handle('widget:getAlwaysOnTop', (e) => {
    const w = getWidgetWindowForEvent(e) ?? BrowserWindow.fromWebContents(e.sender)
    return w?.isAlwaysOnTop() ?? false
  })
  // 위젯 창 자신에게 OS-level 포커스를 강제. renderer의 window.focus()는 Windows의
  // 포그라운드 락 때문에 종종 무시되는데, main 프로세스의 BrowserWindow.focus()는
  // 자기 자신이 띄운 창이므로 대부분 통과한다. window.confirm 등 모달 후에 호출.
  ipcMain.on('widget:focusSelf', (e) => {
    const w = getWidgetWindowForEvent(e) ?? BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isDestroyed()) return
    try {
      if (w.isMinimized()) w.restore()
      w.focus()
      // 추가 안전장치: 일시 alwaysOnTop → 곧바로 원상복귀. Windows 포그라운드 락 우회 기법.
      const wasOnTop = w.isAlwaysOnTop()
      if (!wasOnTop) {
        w.setAlwaysOnTop(true)
        setTimeout(() => { if (!w.isDestroyed()) w.setAlwaysOnTop(false) }, 50)
      }
    } catch { /* ignore */ }
  })

  // 학생 기록 위젯 등: 잠금 상태일 때 창을 헤더만 보이도록 컴팩트하게 줄였다가
  // 잠금 해제 시 원래 높이로 복원. 컴팩트 상태의 resize 는 DB에 저장되지 않음.
  ipcMain.on('widget:setLockCompact', (e, compact: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isDestroyed()) return
    const winId = w.id
    try {
      if (compact) {
        if (!lockedCompactPrevHeight.has(winId)) {
          const [, curH] = w.getSize()
          lockedCompactPrevHeight.set(winId, curH)
        }
        lockedCompactWindows.add(winId)
        // 헤더 + "잠금 해제" 버튼이 잘리지 않고 확실히 보이도록 여유 있게 120px.
        // (72 → 96 → 120 으로 단계적 상향; Windows 창 테두리·DPI 스케일 고려)
        w.setMinimumSize(220, 116)
        const [curW] = w.getSize()
        w.setSize(curW, 120)
      } else {
        lockedCompactWindows.delete(winId)
        w.setMinimumSize(220, 160) // 일반 위젯 기본 최소
        const prev = lockedCompactPrevHeight.get(winId)
        if (prev && prev > 120) {
          const [curW] = w.getSize()
          w.setSize(curW, prev)
        }
        lockedCompactPrevHeight.delete(winId)
      }
    } catch { /* ignore */ }
  })

  // 글씨 크기 — setZoomFactor 는 cqmin/vw 단위 텍스트를 스케일하지 못하므로 사용 안 함.
  // 대신 DB 저장만 하고, renderer 가 WidgetShell body 에 CSS zoom 으로 직접 적용.
  ipcMain.on('widget:setFontScale', (e, scale: number) => {
    const w = getWidgetWindowForEvent(e)
    if (!w) return
    const clamped = Math.max(0.7, Math.min(1.6, Number(scale) || 1))
    for (const [id, win] of widgetWindows) {
      if (win === w) {
        const t = id.replace(/^widget-/, '') as WidgetType
        try {
          saveWidgetPosition({ widget_id: id, widget_type: t, font_scale: clamped } as unknown as Parameters<typeof saveWidgetPosition>[0])
        } catch { /* ignore */ }
        break
      }
    }
  })
  // 저장된 font_scale 조회 — DB 에서 직접 읽어 renderer 초기 로드에 사용.
  ipcMain.handle('widget:getFontScale', (e) => {
    const senderWin = getWidgetWindowForEvent(e) ?? BrowserWindow.fromWebContents(e.sender)
    if (!senderWin) return 1
    for (const [id, win] of widgetWindows) {
      if (win === senderWin) {
        try {
          const positions = getWidgetPositions()
          const pos = positions.find((p) => p.widget_id === id)
          const scale = (pos as { font_scale?: number } | undefined)?.font_scale
          return typeof scale === 'number' ? scale : 1
        } catch { return 1 }
      }
    }
    return 1
  })
  ipcMain.handle('widget:resetPositions', () => {
    resetAllWidgetPositions()
    return true
  })
  ipcMain.handle('widget:listOpen', () => {
    const open: string[] = []
    for (const [id, w] of widgetWindows) {
      if (w.isDestroyed()) continue
      // 최소화(hide) 된 위젯은 "꺼짐" 으로 취급 — WidgetLauncher 에서 재클릭 시 showInactive 로 복원.
      if (!w.isVisible()) continue
      open.push(id.replace(/^widget-/, ''))
    }
    return open
  })

  // ─── 배경화면 모드 ───────────────────────────────────────
  ipcMain.handle('widget:setWallpaperMode', (_e, widgetId: string, on: boolean) => {
    if (typeof widgetId !== 'string' || !widgetId.startsWith('widget-')) return false
    setWallpaperMode(widgetId, !!on)
    return true
  })
  ipcMain.handle('widget:exitAllWallpaperMode', () => {
    exitAllWallpaperMode()
    return true
  })
  ipcMain.handle('widget:getWallpaperModeMap', () => {
    return Array.from(wallpaperWidgets.keys())
  })

  // ─── 디스플레이 모드 (헤더 숨김) — 마스터 토글 브로드캐스트 ────────────────
  // 배경화면 모드가 없는 위젯(task/memo/checklist/routine/studentrecord) 헤더의
  // 마스터 토글이 호출. 모든 위젯 창 + 메인 창에 on/off 이벤트를 뿌려 각 WidgetShell
  // 이 자기 shellDisplayMode 를 동기화한다.
  ipcMain.on('widget:setAllDisplayMode', (_e, on: boolean) => {
    broadcastAllDisplayMode(!!on)
  })
}

/**
 * 디스플레이 모드 on/off — 렌더러에 브로드캐스트 + 메인에서 z-order/포커스 네이티브 적용.
 *
 * on=true:
 *   - Pin/배경화면 모드가 아닌 모든 위젯 → setFocusable(false) + NOACTIVATE + pushWindowToBack
 *   - 사용자 요청: "배경화면 모드처럼 포커스 못가지게" → 클릭해도 앞으로 안 오고 깜빡임 최소화.
 *   - 마우스 클릭은 그대로 동작(setIgnoreMouseEvents 는 건드리지 않음) — 학생 체크 등 인터랙션 가능.
 * on=false:
 *   - focusable=true + NOACTIVATE 해제 + 한 번 뒤로 밀기.
 */
function broadcastAllDisplayMode(on: boolean): void {
  displayModeGlobalOn = !!on
  // 대시보드(mainWindow) 도 디스플레이 모드 중에는 뒤로 밀어서 위젯 클릭을 가리지 않게.
  // hide 대신 pushToBack — 사용자가 접근하고 싶을 때 taskbar/트레이로 복원 가능.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    try {
      if (displayModeGlobalOn) {
        pushWindowToBack(mainWindow)
      }
    } catch { /* noop */ }
  }
  const payload = { on: displayModeGlobalOn }
  for (const [id, w] of widgetWindows) {
    if (w.isDestroyed()) continue
    // 렌더러 알림
    try { w.webContents.send('all-display-mode-changed', payload) } catch { /* noop */ }
    // 네이티브 z-order/포커스 적용 — 배경화면 모드/Pin 은 제외.
    if (wallpaperWidgets.has(id)) continue
    if (pinnedWidgets.has(id)) continue
    try {
      if (displayModeGlobalOn) {
        // setFocusable(false) 제거 — Windows 에서 위젯의 onClick 이벤트를 일부 차단하는
        // 부작용이 있어 "디스플레이 모드에서 Monitor 버튼 안 눌리는" 현상 원인.
        // Win32 NOACTIVATE 만 적용해도 foreground 승격 차단은 충분히 됨.
        setWindowNoActivate(w, true)
        pushWindowToBack(w)
        for (const delay of [30, 120, 300, 600]) {
          setTimeout(() => {
            if (w.isDestroyed()) return
            if (!displayModeGlobalOn) return
            if (wallpaperWidgets.has(id) || pinnedWidgets.has(id)) return
            pushWindowToBack(w)
          }, delay)
        }
      } else {
        // 디스플레이 모드 해제 → NOACTIVATE 해제 + 기본 복귀.
        applyDefaultNoActivate(w, id)
        pushWindowToBack(w)
      }
    } catch { /* noop */ }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('all-display-mode-changed', payload) } catch { /* noop */ }
  }
}

// ─── 싱글 인스턴스 락 ─────────────────────────────
// 이미 실행 중인 경우 두 번째 프로세스는 즉시 종료 → 트레이 아이콘 중복 방지.
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  // 사용자가 exe를 (다른 폴더·다른 상황에서) 한 번 더 실행하면:
  //  1) 메인 창 복구/포커스
  //  2) 저장된 위젯 중 닫힌 것들을 되살려 "exe 재실행 = 전부 복원" UX 보장
  //     (포터블 exe가 실행 위치와 관계없이 %APPDATA% DB를 공유하므로, 다른 폴더에서 재실행 해도 같은 앱)
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  try { restoreVisibleWidgets() } catch { /* ignore */ }
})

app.whenReady().then(async () => {
  getDatabase()
  seedTemplates()
  initWin32Z() // Win32 FFI 초기화 (Windows만). 실패 시 graceful.

  // ─── 세션 전역 보안 강화 ─────────────────────────────
  // 프로덕션 빌드에서는 기본 애플리케이션 메뉴(View → Toggle DevTools 포함)를 제거한다.
  // 개발 중엔 DevTools가 필요하므로 유지.
  if (!process.env.ELECTRON_RENDERER_URL) {
    Menu.setApplicationMenu(null)
  }

  // 권한 요청 전부 거부 (카메라/마이크/알림/지리/미디어 등 어떤 권한도 앱이 필요 없음)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  // permission check도 거부 (더 엄격)
  session.defaultSession.setPermissionCheckHandler(() => false)

  // ─── 새로 생성되는 모든 웹콘텐츠에 보안 규칙 자동 적용 ───
  app.on('web-contents-created', (_event, contents) => {
    const win = BrowserWindow.fromWebContents(contents)
    if (win) hardenBrowserWindow(win)
  })

  // 체크한 지 24시간 지난 체크리스트 항목 자동 정리
  const cleanupExpired = () => {
    try {
      const removed = deleteExpiredCheckedItems()
      if (removed > 0) {
        // 위젯에 변경 알림 → 자동 refetch
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            try { w.webContents.send('data:changed', 'checklist') } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
  }
  cleanupExpired()
  setInterval(cleanupExpired, 60 * 60 * 1000) // 매 1시간

  registerIpcHandlers()
  registerWindowIpc()

  try {
    const autoStart = getSetting('auto_start') as unknown as boolean
    // Portable 모드에서 exe가 다른 폴더로 옮겨졌을 수 있으므로 매 부팅마다 재적용해 레지스트리 경로를 갱신한다.
    await applyAutoStart(!!autoStart)
  } catch { /* ignore */ }

  ipcMain.handle('system:setAutoStart', async (_e, enabled: boolean) => {
    await applyAutoStart(!!enabled)
    return await isAutoStartEnabled()
  })

  ipcMain.handle('system:isAutoStartEnabled', () => isAutoStartEnabled())
  ipcMain.handle('system:isLaunchedAtStartup', () => isLaunchedAtStartup())
  ipcMain.handle('system:isPortable', () => isPortableWin())

  createMainWindow()
  createTray()
  registerShortcuts()
  restoreVisibleWidgets()

  // 자동 백업 스케줄러 — 매 15분 체크, daily/weekly 설정 시 동기화 폴더로 자동 저장.
  // 스케줄러 내부에서 터져도 앱 시작은 계속되도록 방어.
  try { startBackupScheduler() } catch (err) { _crashLog('startBackupScheduler', err) }

  // 모든 위젯을 주기적으로 "항상 뒤로" — Pin·배경화면·포커스 상태 제외.
  try { startBottomTickTimer() } catch (err) { _crashLog('startBottomTickTimer', err) }

  // ★ 디스플레이 변경(외부 모니터 연결/해제, 해상도/스케일 변경)에 위젯 좌표 자동 적응.
  //   부팅 직후 외부 모니터가 늦게 인식되면 'display-added' 이벤트가 그때 발사된다.
  //   이 시점에 모든 위젯을 검사 — 화면 밖이거나 비정상 풀스크린이면 해당 디스플레이의
  //   spread 위치로 재배치 + DB 갱신. 같은 위치에 6 개 위젯이 모이는 상황을 영구 차단.
  const reconcileWidgetsToScreens = (reason: string): void => {
    if (widgetWindows.size === 0) return
    wDebug(`reconcileWidgetsToScreens: ${reason} (${widgetWindows.size} widgets)`)

    // ★ 클러스터 감지: 디스플레이 변경(특히 배율 변경) 시 Windows 가 위젯들을 메인 화면
    //    좌상단 부근으로 강제 이동시키면 사이즈는 정상·화면 안이라 기존 가드를 통과해버림.
    //    현재 라이브 bounds 의 중심점이 120px 반경에 3 개 이상 모이면 클러스터로 판정 → 강제 respread.
    const RADIUS = 120
    const liveCenters = [...widgetWindows.entries()]
      .filter(([, w]) => !w.isDestroyed())
      .map(([id, w]) => {
        const b = w.getBounds()
        return { id, b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
      })

    const adj = new Map<string, Set<string>>(liveCenters.map((c) => [c.id, new Set<string>()]))
    for (let i = 0; i < liveCenters.length; i++) {
      for (let j = i + 1; j < liveCenters.length; j++) {
        const a = liveCenters[i], bb = liveCenters[j]
        const dx = a.cx - bb.cx, dy = a.cy - bb.cy
        if (dx * dx + dy * dy <= RADIUS * RADIUS) {
          adj.get(a.id)!.add(bb.id)
          adj.get(bb.id)!.add(a.id)
        }
      }
    }
    const visited = new Set<string>()
    let largest = new Set<string>()
    for (const c of liveCenters) {
      if (visited.has(c.id)) continue
      const comp = new Set<string>()
      const queue = [c.id]
      while (queue.length > 0) {
        const cur = queue.shift()!
        if (comp.has(cur)) continue
        comp.add(cur); visited.add(cur)
        for (const n of adj.get(cur) ?? []) if (!comp.has(n)) queue.push(n)
      }
      if (comp.size > largest.size) largest = comp
    }
    const clustered = largest.size >= 3 ? largest : new Set<string>()
    if (clustered.size > 0) {
      wDebug(`reconcileWidgetsToScreens: live cluster of ${clustered.size} detected → forcing respread: ${[...clustered].join(', ')}`)
    }

    for (const [id, w] of widgetWindows) {
      try {
        if (w.isDestroyed()) continue
        const b = w.getBounds()
        const offScreen = !isOnScreen(b.x, b.y, b.width, b.height)
        const anomalous = isAnomalousFullscreen(b.width, b.height)
        const isClusteredId = clustered.has(id)
        if (!offScreen && !anomalous && !isClusteredId) continue

        const widgetType = id.replace(/^widget-/, '').split('-')[0] as WidgetType
        const defaults = WIDGET_DEFAULTS[widgetType]
        const newW = anomalous ? defaults.w : b.width
        const newH = anomalous ? defaults.h : b.height
        const pos = getSpreadPosition(widgetType, newW, newH)
        wDebug(`reconcile[${id}]: ${b.width}x${b.height}@(${b.x},${b.y}) offScreen=${offScreen} anomalous=${anomalous} clustered=${isClusteredId} → ${newW}x${newH}@(${pos.x},${pos.y})`)
        w.setBounds({ x: pos.x, y: pos.y, width: newW, height: newH })
        // 새 좌표는 정상이므로 persistBounds 의 가드 통과 → DB 갱신.
        try {
          saveWidgetPosition({
            widget_id: id,
            widget_type: widgetType,
            x: pos.x, y: pos.y,
            width: newW, height: newH,
          })
        } catch (err) { _crashLog(`reconcile:save:${id}`, err) }
      } catch (err) { _crashLog(`reconcile:${id}`, err) }
    }
  }

  // ★ 디스플레이 이벤트가 연속으로 여러 번 발사될 수 있으므로 (배율 변경 시 Windows 가
  //    metrics-changed 를 수 차례 발사) 짧은 debounce + 후행 트리거 한 번 더로 수렴.
  let reconcileTimer: NodeJS.Timeout | null = null
  const scheduleReconcile = (reason: string): void => {
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => {
      reconcileWidgetsToScreens(reason)
      // OS 가 우리 setBounds 직후 다시 한 번 자기 멋대로 옮길 수 있어 1.2 초 후 재검증.
      setTimeout(() => reconcileWidgetsToScreens(`${reason}+verify`), 1200)
    }, 250)
  }
  // ★ 디스플레이 이벤트 발생 직후 ~3 초 간 모든 위젯에 grace 등록 — Windows 가 위젯들을
  //    좌상단으로 강제 이동시키며 발사하는 'move' 이벤트가 잘못된 좌표를 DB 에 영구화하는 것을
  //    차단. reconcile 자체는 saveWidgetPosition 직접 호출이라 grace 영향 없음.
  const DISPLAY_GRACE_MS = 3000
  const armDisplayGrace = (): void => {
    const ids = [...widgetWindows.keys()]
    for (const id of ids) startupGraceWidgets.add(id)
    setTimeout(() => {
      for (const id of ids) startupGraceWidgets.delete(id)
      wDebug(`display grace closed (${ids.length} widgets)`)
    }, DISPLAY_GRACE_MS)
  }
  screen.on('display-added', () => { armDisplayGrace(); scheduleReconcile('display-added') })
  screen.on('display-removed', () => { armDisplayGrace(); scheduleReconcile('display-removed') })
  screen.on('display-metrics-changed', () => { armDisplayGrace(); scheduleReconcile('display-metrics-changed') })
  // 부팅 직후 자동 시작 케이스 — 디스플레이 인식이 늦을 수 있어 1.5 초 후 한 번 더 검사.
  setTimeout(() => reconcileWidgetsToScreens('post-startup-1500ms'), 1500)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 종료 직전: 모든 위젯의 마지막 bounds 를 closeDatabase() 호출 전에 강제 flush.
  // debounce(400ms) 큐에 남아있던 변경이 사라지지 않도록 — 다음 실행 때 같은 위치로 복원 보장.
  for (const [id, w] of widgetWindows) {
    try {
      if (w.isDestroyed()) continue
      const b = w.getBounds()
      // 안전장치: 비정상 풀스크린/화면밖 좌표는 저장 skip (createWidgetWindow 의 persistBounds 와 동일 정책).
      if (isAnomalousFullscreen(b.width, b.height)) continue
      if (!isOnScreen(b.x, b.y, b.width, b.height)) continue
      const t = id.replace(/^widget-/, '').split('-')[0] as WidgetType
      // lockedCompact 면 height 는 prev 로 대체, x/y/width 는 사용자가 옮긴 값 그대로 보존.
      const isLocked = lockedCompactWindows.has(w.id)
      const defaults = WIDGET_DEFAULTS[t]
      const heightToSave = isLocked
        ? (lockedCompactPrevHeight.get(w.id) ?? defaults?.h ?? b.height)
        : b.height
      saveWidgetPosition({
        widget_id: id,
        widget_type: t,
        x: b.x, y: b.y,
        width: b.width, height: heightToSave,
      })
    } catch (err) { _crashLog(`flushWidgetBounds:${id}`, err) }
  }
  globalShortcut.unregisterAll()
  stopBackupScheduler()
  stopBottomTickTimer()
  closeDatabase()
  // 트레이 아이콘 명시적 정리 — 비정상 종료 시 좀비 아이콘 방지
  try { tray?.destroy() } catch { /* ignore */ }
  tray = null
})

app.on('will-quit', () => {
  try { tray?.destroy() } catch { /* ignore */ }
  tray = null
})

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show()
  }
})

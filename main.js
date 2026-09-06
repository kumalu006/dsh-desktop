'use strict'

/**
 * Electron desktop shell for the DeepSeek Harness web GUI (Phase 1, local).
 *
 * What it does:
 *   - single-instance lock (double-click focuses the existing window)
 *   - reuse an already-running `dsh web` on 127.0.0.1:<port>, or spawn one
 *   - when it spawns the backend, capture the launch-token URL printed by
 *     `dsh web` and load it once to mint the browser cookie (dsh web authenticates
 *     every API call with a signed, authority-bound cookie; the cookie is
 *     exchanged from the one-time `?token=...` URL and then persists ~30 days)
 *   - tray menu; closing the window hides to tray (configurable)
 *   - on quit, stop only the backend process this app started
 *
 * The backend is the built dsh CLI (`node <checkout>/apps/cli/lib/bin.js web
 * --no-open --port <port>`); it binds loopback only. Sessions, settings and
 * credentials under ~/.dsh are reused unchanged.
 *
 * Backend working directory (the session workspace for new sessions) is
 * config.projectDir when set, otherwise the checkout.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ---------------------------------------------------------------------------
// Config: defaults (config.defaults.json) < user overrides (~/.dsh/desktop-config.json) < env
// ---------------------------------------------------------------------------

function loadConfig() {
  let defaults = {}
  try {
    defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.defaults.json'), 'utf8'))
  } catch (err) {
    // no defaults file: fall through with empty object
  }

  let user = {}
  try {
    user = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'desktop-config.json'), 'utf8'))
  } catch (err) {
    // no user overrides
  }

  const env = {}
  if (process.env.DSH_NODE) env.node = process.env.DSH_NODE
  if (process.env.DSH_CHECKOUT) env.checkout = process.env.DSH_CHECKOUT
  if (process.env.DSH_BIN) env.bin = process.env.DSH_BIN
  if (process.env.DSH_PROJECT_DIR) env.projectDir = process.env.DSH_PROJECT_DIR
  if (process.env.DSH_PORT) env.port = Number(process.env.DSH_PORT)
  if (process.env.DSH_HOST) env.host = process.env.DSH_HOST

  const cfg = { ...defaults, ...user, ...env }
  cfg.port = Number(cfg.port) || 3080
  cfg.host = cfg.host || '127.0.0.1'
  cfg.closeToTray = cfg.closeToTray !== false
  cfg.startupTimeoutMs = Number(cfg.startupTimeoutMs) || 30000
  cfg.node = cfg.node || 'node'
  return cfg
}

const config = loadConfig()
const BACKEND_URL = `http://${config.host}:${config.port}`
const LOG_DIR = path.join(os.homedir(), '.dsh', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'dsh-desktop.log')

// The launch-token URL dsh web prints as `dsh web: http://127.0.0.1:3080/?token=...`.
const TOKEN_URL_RE = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/

let mainWindow = null
let tray = null
let backend = null // child process this app spawned (never touch a foreign one)
let authenticatedUrl = null // captured from the spawned backend's stdout
let isQuitting = false

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

function log(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch (err) {
    // logging is best-effort
  }
}

function isBackendUp() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: config.host, port: config.port, path: '/', method: 'GET', timeout: 1500 },
      (res) => {
        res.resume()
        resolve(true)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

/** Whether this app's cookie jar already holds a dsh browser-session cookie for the authority. */
function hasAuthCookie() {
  return session.defaultSession.cookies
    .get({ url: BACKEND_URL })
    .then((cookies) => cookies.some((c) => c.name.startsWith('dsh-auth-')))
    .catch(() => false)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function buildEnv() {
  const home = os.homedir()
  const nodeDir = path.dirname(config.node)
  const base = [
    nodeDir,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  const existing = (process.env.PATH || '').split(':').filter(Boolean)
  const merged = [...new Set([...base, ...existing])]
  return {
    ...process.env,
    HOME: home,
    PATH: merged.join(':'),
  }
}

function resolveBackendBin() {
  if (config.bin) return config.bin
  return path.join(config.checkout, 'apps', 'cli', 'lib', 'bin.js')
}

function startBackend() {
  const bin = resolveBackendBin()
  const args = ['web', '--no-open', '--port', String(config.port)]
  log(`spawn backend: ${config.node} ${bin} ${args.join(' ')}`)
  backend = spawn(config.node, [bin, ...args], {
    cwd: config.projectDir || config.checkout || os.homedir(),
    env: buildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  backend.stdout.setEncoding('utf8')
  backend.stdout.on('data', (chunk) => {
    log(`[backend] ${chunk.trimEnd()}`)
    if (!authenticatedUrl) {
      const match = chunk.match(TOKEN_URL_RE)
      if (match) {
        authenticatedUrl = match[1]
        log(`captured launch-token URL`)
      }
    }
  })
  backend.stderr.setEncoding('utf8')
  backend.stderr.on('data', (chunk) => log(`[backend:err] ${chunk.trimEnd()}`))

  backend.on('exit', (code, signal) => {
    log(`backend exited code=${code} signal=${signal}`)
    backend = null
  })
  backend.on('error', (err) => {
    log(`backend spawn error: ${err.message}`)
    backend = null
  })
}

function stopBackend() {
  if (backend && backend.exitCode === null) {
    log('stopping backend we started')
    backend.kill('SIGTERM')
    backend = null
  }
}

/**
 * Bring the backend up and resolve how the window should authenticate.
 * @returns 'reused' | 'spawned' | 'failed'
 */
async function ensureBackend() {
  if (await isBackendUp()) {
    log(`backend already running at ${BACKEND_URL} — reusing`)
    return 'reused'
  }
  if (!config.checkout && !config.bin) {
    log('no checkout/bin configured and no backend running')
    return 'failed'
  }

  authenticatedUrl = null
  startBackend()

  // The token URL is printed after the Loader settles, which is a touch later
  // than the socket accepting connections — wait for the URL, not just the port.
  const deadline = Date.now() + config.startupTimeoutMs
  while (Date.now() < deadline) {
    if (authenticatedUrl) return 'spawned'
    if (backend === null) return 'failed' // spawn crashed before printing
    await sleep(300)
  }
  // No token line captured (e.g. printUrl disabled); fall back to a bare URL.
  if (await isBackendUp()) return 'spawned'
  return 'failed'
}

// ---------------------------------------------------------------------------
// Window / tray
// ---------------------------------------------------------------------------

function createWindow() {
  const url = authenticatedUrl || BACKEND_URL
  log(`loading ${authenticatedUrl ? 'authenticated' : 'bare'} URL in window`)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadURL(url)

  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.on('close', (event) => {
    if (config.closeToTray && !isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // External links (e.g. "open in browser") must not navigate the shell window.
  mainWindow.webContents.setWindowOpenHandler(({ url: externalUrl }) => {
    shell.openExternal(externalUrl)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(BACKEND_URL)) {
      event.preventDefault()
      shell.openExternal(targetUrl)
    }
  })
}

function trayIconPath() {
  const p = path.join(__dirname, 'assets', 'trayTemplate.png')
  return fs.existsSync(p) ? p : null
}

function createTray() {
  const iconPath = trayIconPath()
  if (!iconPath) return
  const image = nativeImage.createFromPath(iconPath)
  tray = new Tray(image)
  tray.setToolTip('DeepSeek Harness')
  const menu = Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: () => showMainWindow() },
    { label: '在浏览器中打开', click: () => shell.openExternal(BACKEND_URL) },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showMainWindow())
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApp() {
  isQuitting = true
  stopBackend()
  app.quit()
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(async () => {
    app.setName('DeepSeek Harness')

    const state = await ensureBackend()

    if (state === 'failed') {
      log('backend failed to start')
      dialog.showErrorBox(
        'DeepSeek Harness',
        `无法启动 dsh web 后端（${BACKEND_URL}）。\n\n` +
          `请检查：\n` +
          `  · dsh 源码目录存在且已构建：${config.checkout || '(未设置)'}\n` +
          `  · Node 可用：${config.node}\n` +
          `  · 日志：${LOG_FILE}`,
      )
      quitApp()
      return
    }

    if (state === 'reused' && !(await hasAuthCookie())) {
      // A foreign (manually started) server is running, but this app has no
      // session cookie yet and cannot mint one without that process's launch
      // token. Guide the user through the one-time transition.
      log('reused a foreign backend but no auth cookie — showing guidance')
      await dialog.showMessageBox({
        type: 'info',
        title: 'DeepSeek Harness',
        message: '检测到已有 dsh web 在运行，但本应用还没有会话凭据。',
        detail:
          `端口 ${config.port} 上有一个在终端里手动启动的 dsh web，本应用无法拿到它的登录令牌。\n\n` +
          '请按下面两步操作一次即可：\n' +
          '  1) 回到终端，按 Ctrl-C 停掉手动启动的 dsh web；\n' +
          '  2) 重新打开本应用（它会自己启动服务并完成认证，凭据会保存约 30 天）。\n\n' +
          '完成一次后，无论服务是谁启动的，本应用都能直接使用。',
        buttons: ['好的'],
      })
      quitApp()
      return
    }

    createWindow()
    createTray()
  })

  app.on('activate', () => {
    if (mainWindow) showMainWindow()
    else if (tray) createWindow()
  })

  app.on('before-quit', () => {
    isQuitting = true
    stopBackend()
  })

  // With close-to-tray, keep the app alive when the window is hidden/closed.
  app.on('window-all-closed', () => {
    if (!config.closeToTray) {
      stopBackend()
      app.quit()
    }
  })
}

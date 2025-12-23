import './style.css'
import Quagga from '@ericblade/quagga2'

type AppElements = {
  scanner: HTMLDivElement
  startButton: HTMLButtonElement
  stopButton: HTMLButtonElement
  clearButton: HTMLButtonElement
  status: HTMLParagraphElement
  resultText: HTMLTextAreaElement
  format: HTMLSpanElement
  notionStatus: HTMLParagraphElement

  statusDialog: HTMLDialogElement
  dialogIcon: HTMLDivElement
  dialogStatus: HTMLParagraphElement
  dialogClearButton: HTMLButtonElement
}

const appRoot = document.querySelector<HTMLDivElement>('#app')
if (!appRoot) throw new Error('Missing #app root element')

appRoot.innerHTML = `
  <main class="app">
    <header class="header">
      <h1 class="title">SGT Barcode Reader</h1>
      <p class="subtitle">นำกล้องไปที่บาร์โค้ดเพื่อสแกน</p>
    </header>

    <section class="preview" aria-label="Camera preview">
      <div id="scanner" class="scanner" aria-label="Live scanner"></div>
    </section>

    <section class="panel" aria-label="Controls and results">
      <div class="buttons">
        <button id="start" type="button" class="btn btn-primary">Start camera</button>
        <button id="stop" type="button" class="btn" disabled>Stop</button>
      </div>

      <div class="buttons buttons-spaced">
        <button id="clear" type="button" class="btn btn-wide">ลงทะเบียนต่อ</button>
      </div>

      <p id="status" class="status" role="status">พร้อมสำหรับสแกน.</p>

      <div class="result">
        <div class="resultHeader">
          <span class="resultLabel">หมายเลข 8 หลัก</span>
          <span class="resultMeta">Format: <span id="format">—</span></span>
        </div>
        <textarea
          id="resultText"
          class="resultText"
          readonly
          rows="3"
          placeholder="สแกนบาร์โค้ดเพื่อแสดงผลที่นี่"
        ></textarea>
      </div>

      <p class="hint">Tip: เพื่อให้ระบบสามารถทำงานได้ โปรดอนุญาตการเข้าถึงกล้องและใช้แสงสว่างเพียงพอ</p>

      <p id="notionStatus" class="status" role="status">กำลังรอ…</p>
    </section>
  </main>

  <dialog id="statusDialog" class="modal" aria-label="Status">
    <div class="modalBody">
      <div id="dialogIcon" class="modalIcon" aria-hidden="true">—</div>
      <p id="dialogStatus" class="modalStatus">—</p>
      <button id="dialogClear" type="button" class="btn btn-primary btn-wide">ล้างค่า</button>
    </div>
  </dialog>
`

function getEls(): AppElements {
  const scanner = document.querySelector<HTMLDivElement>('#scanner')
  const startButton = document.querySelector<HTMLButtonElement>('#start')
  const stopButton = document.querySelector<HTMLButtonElement>('#stop')
  const clearButton = document.querySelector<HTMLButtonElement>('#clear')
  const status = document.querySelector<HTMLParagraphElement>('#status')
  const resultText = document.querySelector<HTMLTextAreaElement>('#resultText')
  const format = document.querySelector<HTMLSpanElement>('#format')
  const notionStatus = document.querySelector<HTMLParagraphElement>('#notionStatus')

  const statusDialog = document.querySelector<HTMLDialogElement>('#statusDialog')
  const dialogIcon = document.querySelector<HTMLDivElement>('#dialogIcon')
  const dialogStatus = document.querySelector<HTMLParagraphElement>('#dialogStatus')
  const dialogClearButton = document.querySelector<HTMLButtonElement>('#dialogClear')

  if (
    !scanner ||
    !startButton ||
    !stopButton ||
    !clearButton ||
    !status ||
    !resultText ||
    !format ||
    !notionStatus ||
    !statusDialog ||
    !dialogIcon ||
    !dialogStatus ||
    !dialogClearButton
  ) {
    throw new Error('Failed to initialize UI elements')
  }

  return {
    scanner,
    startButton,
    stopButton,
    clearButton,
    status,
    resultText,
    format,
    notionStatus,

    statusDialog,
    dialogIcon,
    dialogStatus,
    dialogClearButton,
  }
}

function showStatusDialog(els: AppElements, kind: 'success' | 'error', message: string) {
  els.statusDialog.dataset.status = kind
  els.dialogIcon.textContent = kind === 'success' ? '✓' : '✕'
  els.dialogStatus.textContent = message
  try {
    if (!els.statusDialog.open) els.statusDialog.showModal()
  } catch {
    // If <dialog> isn't supported, fall back silently.
  }
}

let syncInFlight = false
let lastSyncedValue: string | null = null

async function syncScannedIdToNotion(els: AppElements, scannedId: string) {
  const value = scannedId.trim()
  if (!value) return

  // Avoid spamming Notion on repeated detections.
  if (syncInFlight) return
  if (lastSyncedValue === value) return

  syncInFlight = true
  els.notionStatus.textContent = `กำลังลงทะเบียน ${value}…`

  try {
    const data = await apiFetch('/api/notion/scan', {
      method: 'POST',
      body: JSON.stringify({ id: value }),
    })

    lastSyncedValue = value
    const pageId =
      data && typeof (data as any).pageId === 'string' && (data as any).pageId.trim()
        ? (data as any).pageId.trim()
        : ''
    const msg = `ผ่าน: ลงทะเบียน ID ${value} เรียบร้อยแล้ว${pageId ? ` (pageId: ${pageId})` : ''}
กด “ล้างค่า” เพื่อสแกนรายการถัดไป`
    els.notionStatus.textContent = msg
    showStatusDialog(els, 'success', msg)
  } catch (e) {
    // Avoid spamming the same failing request repeatedly while the camera keeps detecting.
    lastSyncedValue = value
    const msg = `ไม่ผ่าน: ${(e as Error).message}\nกด “ล้างค่า” แล้วลองสแกนใหม่อีกครั้ง`
    els.notionStatus.textContent = msg
    showStatusDialog(els, 'error', msg)
  } finally {
    syncInFlight = false
  }
}

const API_BASE = (() => {
  const envBase: unknown =
    // Vite
    (import.meta as any).env?.VITE_API_BASE ??
    // Fallback in case a formatter/tool changed the env access
    (import.meta as any).VITE_API_BASE

  if (typeof envBase === 'string' && envBase.trim()) return envBase.trim()

  const isLocalhost =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  if (isLocalhost) return 'http://localhost:8787'

  // In production, default to same-origin (relative /api/...).
  // This works for hosts that provide backend routes on the same domain (e.g. Netlify/Vercel).
  // For separate backends (e.g. Cloudflare Worker), set VITE_API_BASE at build time.
  return ''
})()

async function apiFetch(path: string, init?: RequestInit) {
  const url = API_BASE ? `${API_BASE}${path}` : path
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isLocalApi = API_BASE.startsWith('http://localhost:') || API_BASE.startsWith('http://127.0.0.1:')
    if (isLocalApi) {
      throw new Error(
        `Request failed (${msg}). If you're running locally, start the API server: \"npm run api\" (and ensure NOTION_TOKEN is set in .env).`,
      )
    }
    throw new Error(
      `Request blocked/failed (${msg}). If you're hosting on Neocities, update your site Content Security Policy to allow connect-src ${API_BASE || "<your-api-domain>"}.`,
    )
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  return data
}

function friendlyErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (/NotAllowedError/i.test(error.name)) return 'Camera permission denied.'
    if (/NotFoundError/i.test(error.name)) return 'No camera found on this device.'
    if (/NotReadableError/i.test(error.name)) return 'Camera is in use by another app.'
    return error.message || 'Unexpected error.'
  }
  return 'Unexpected error.'
}

function normalizeFormat(format: unknown): string {
  if (typeof format !== 'string') return '—'
  return format.replace(/_reader$/, '').replace(/_/g, ' ').toUpperCase()
}

let isRunning = false
let lastValue: string | null = null
let lastSeenAt = 0
let detectedHandler: ((data: any) => void) | null = null

function clearAll(els: AppElements) {
  els.resultText.value = ''
  els.format.textContent = '—'
  els.status.textContent = 'พร้อมสำหรับสแกน.'
  els.notionStatus.textContent = 'กำลังรอ…'
  lastValue = null
  lastSyncedValue = null

  els.statusDialog.dataset.status = ''
  els.dialogIcon.textContent = '—'
  els.dialogStatus.textContent = '—'

  try {
    els.statusDialog.close()
  } catch {
    // ignore
  }
}

async function startScanner(els: AppElements) {
  if (isRunning) return
  els.status.textContent = 'Requesting camera permission…'
  els.startButton.disabled = true

  try {
    // Clear previously injected elements.
    els.scanner.replaceChildren()

    await new Promise<void>((resolve, reject) => {
      ;(Quagga as any).init(
        {
          inputStream: {
            type: 'LiveStream',
            target: els.scanner,
            constraints: {
              facingMode: 'environment',
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          },
          locate: true,
          numOfWorkers: 0,
          decoder: {
            readers: [
              // Required
              'codabar_reader',
              // Useful extras
              // 'code_128_reader',
              // 'code_39_reader',
              // 'ean_reader',
              // 'ean_8_reader',
              // 'upc_reader',
              // 'upc_e_reader',
              // 'i2of5_reader',
            ],
          },
        },
        (err: unknown) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        },
      )
    })

    detectedHandler = (data: any) => {
      let code: string | undefined = data?.codeResult?.code.slice(1, -1)
      const formatRaw: string | undefined = data?.codeResult?.format
      if (!code) return

      const now = Date.now()
      if (code === lastValue && now - lastSeenAt < 1200) return

      lastValue = code
      lastSeenAt = now

      els.resultText.value = code
      els.format.textContent = normalizeFormat(formatRaw)
      els.status.textContent = 'Decoded.'

      void syncScannedIdToNotion(els, code)
    }

    ;(Quagga as any).onDetected(detectedHandler)
    ;(Quagga as any).start()
    isRunning = true

    els.stopButton.disabled = false
    els.status.textContent = 'Scanning…'
  } catch (e) {
    els.status.textContent = friendlyErrorMessage(e)
    els.startButton.disabled = false
  }
}

function stopScanner(els: AppElements) {
  if (!isRunning) return

  try {
    if (detectedHandler) {
      ;(Quagga as any).offDetected?.(detectedHandler)
    }
  } catch {
    // best-effort
  }

  try {
    ;(Quagga as any).stop()
  } catch {
    // best-effort
  }

  detectedHandler = null
  isRunning = false

  els.stopButton.disabled = true
  els.startButton.disabled = false
  els.status.textContent = 'Stopped.'
}

const els = getEls()

els.clearButton.addEventListener('click', () => {
  clearAll(els)
})

els.dialogClearButton.addEventListener('click', () => clearAll(els))

els.startButton.addEventListener('click', () => void startScanner(els))
els.stopButton.addEventListener('click', () => stopScanner(els))

// Auto-start if permission already granted (still needs user gesture on many browsers).
void (async () => {
  try {
    const permission = await (navigator.permissions?.query
      ? navigator.permissions.query({ name: 'camera' as PermissionName })
      : Promise.resolve(null))

    if (permission && permission.state === 'granted') {
      await startScanner(els)
    }
  } catch {
    // ignore
  }
})()

window.addEventListener('pagehide', () => stopScanner(els))

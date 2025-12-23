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

  notionQuery: HTMLInputElement
  notionSearchButton: HTMLButtonElement
  notionResults: HTMLDivElement
  notionPageId: HTMLInputElement
  notionProperty: HTMLInputElement
  notionValue: HTMLInputElement
  notionUpdateButton: HTMLButtonElement
  notionStatus: HTMLParagraphElement
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
        <button id="clear" type="button" class="btn btn-wide">Clear</button>
      </div>

      <p id="status" class="status" role="status">Ready.</p>

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

      <div class="notion">
        <div class="notionHeader">
          <span class="resultLabel">Notion</span>
          <span class="resultMeta">(server-side token)</span>
        </div>

        <div class="field">
          <label class="label" for="notionQuery">Search page</label>
          <div class="row">
            <input id="notionQuery" class="input" placeholder="Type page title…" />
            <button id="notionSearch" type="button" class="btn">Search</button>
          </div>
          <div id="notionResults" class="results"></div>
        </div>

        <div class="field">
          <label class="label" for="notionPageId">Page ID</label>
          <input id="notionPageId" class="input" placeholder="Paste Notion page id…" />
        </div>

        <div class="field">
          <label class="label" for="notionProperty">Property name</label>
          <input id="notionProperty" class="input" placeholder="e.g. Barcode" />
        </div>

        <div class="field">
          <label class="label" for="notionValue">Value</label>
          <input id="notionValue" class="input" placeholder="Defaults to scanned value" />
        </div>

        <button id="notionUpdate" type="button" class="btn btn-primary btn-wide">Update Notion</button>
        <p id="notionStatus" class="status" role="status"></p>
      </div>
    </section>
  </main>
`

function getEls(): AppElements {
  const scanner = document.querySelector<HTMLDivElement>('#scanner')
  const startButton = document.querySelector<HTMLButtonElement>('#start')
  const stopButton = document.querySelector<HTMLButtonElement>('#stop')
  const clearButton = document.querySelector<HTMLButtonElement>('#clear')
  const status = document.querySelector<HTMLParagraphElement>('#status')
  const resultText = document.querySelector<HTMLTextAreaElement>('#resultText')
  const format = document.querySelector<HTMLSpanElement>('#format')

  const notionQuery = document.querySelector<HTMLInputElement>('#notionQuery')
  const notionSearchButton = document.querySelector<HTMLButtonElement>('#notionSearch')
  const notionResults = document.querySelector<HTMLDivElement>('#notionResults')
  const notionPageId = document.querySelector<HTMLInputElement>('#notionPageId')
  const notionProperty = document.querySelector<HTMLInputElement>('#notionProperty')
  const notionValue = document.querySelector<HTMLInputElement>('#notionValue')
  const notionUpdateButton = document.querySelector<HTMLButtonElement>('#notionUpdate')
  const notionStatus = document.querySelector<HTMLParagraphElement>('#notionStatus')

  if (
    !scanner ||
    !startButton ||
    !stopButton ||
    !clearButton ||
    !status ||
    !resultText ||
    !format ||
    !notionQuery ||
    !notionSearchButton ||
    !notionResults ||
    !notionPageId ||
    !notionProperty ||
    !notionValue ||
    !notionUpdateButton ||
    !notionStatus
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
    notionQuery,
    notionSearchButton,
    notionResults,
    notionPageId,
    notionProperty,
    notionValue,
    notionUpdateButton,
    notionStatus,
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
  els.resultText.value = ''
  els.format.textContent = '—'
  els.status.textContent = 'Ready.'
})

els.startButton.addEventListener('click', () => void startScanner(els))
els.stopButton.addEventListener('click', () => stopScanner(els))

els.notionSearchButton.addEventListener('click', () => void notionSearch(els))
els.notionUpdateButton.addEventListener('click', () => void notionUpdate(els))

async function notionSearch(els: AppElements) {
  const q = els.notionQuery.value.trim()
  if (!q) return

  els.notionStatus.textContent = 'Searching…'
  els.notionResults.replaceChildren()

  try {
    const data = await apiFetch('/api/notion/search', {
      method: 'POST',
      body: JSON.stringify({ query: q, page_size: 5 }),
    })

    const results: Array<{ id: string; title: string; url: string }> = data.results ?? []
    if (results.length === 0) {
      els.notionStatus.textContent = 'No pages found.'
      return
    }

    for (const r of results) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pick'
      btn.textContent = r.title ? `${r.title} (${r.id})` : r.id
      btn.addEventListener('click', () => {
        els.notionPageId.value = r.id
        els.notionStatus.textContent = 'Selected page.'
      })
      els.notionResults.appendChild(btn)
    }
    els.notionStatus.textContent = 'Pick a page from results.'
  } catch (e) {
    els.notionStatus.textContent = (e as Error).message
  }
}

async function notionUpdate(els: AppElements) {
  const pageId = els.notionPageId.value.trim()
  const propertyName = els.notionProperty.value.trim()
  const value = (els.notionValue.value.trim() || els.resultText.value.trim())

  if (!pageId || !propertyName) {
    els.notionStatus.textContent = 'Please fill Page ID and Property name.'
    return
  }
  if (!value) {
    els.notionStatus.textContent = 'No value to update (scan first or type a value).'
    return
  }

  els.notionStatus.textContent = 'Updating…'
  try {
    const data = await apiFetch(`/api/notion/pages/${encodeURIComponent(pageId)}/property`, {
      method: 'PATCH',
      body: JSON.stringify({ propertyName, value }),
    })
    els.notionStatus.textContent = `Updated (${data.type}).`
  } catch (e) {
    els.notionStatus.textContent = (e as Error).message
  }
}

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

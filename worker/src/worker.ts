type Env = {
  NOTION_TOKEN: string
  ALLOWED_ORIGIN?: string
}

const NOTION_VERSION = '2022-06-28'
const API_VERSION = '2026-02-26.2'

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  })
}

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get('Origin')
  if (!origin) return null

  // Always allow localhost for local dev.
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin

  // If ALLOWED_ORIGIN is set, only allow that exact origin.
  if (env.ALLOWED_ORIGIN) {
    return origin === env.ALLOWED_ORIGIN ? origin : null
  }

  // If not set, allow any origin (less secure). Prefer setting ALLOWED_ORIGIN.
  return origin
}

function corsHeaders(req: Request, env: Env): HeadersInit {
  const origin = allowedOrigin(req, env)
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

async function notionFetch(env: Env, path: string, init: RequestInit) {
  const url = `https://api.notion.com/v1${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Notion HTTP ${res.status}`)
  }
  return data
}

function getPlainTitleFromPage(page: any): string {
  try {
    const props = page?.properties ?? {}
    for (const key of Object.keys(props)) {
      const p = props[key]
      if (p?.type === 'title') {
        return (p.title ?? []).map((t: any) => t?.plain_text ?? '').join('')
      }
    }
  } catch {
    // ignore
  }
  return ''
}

function normalizeForMatch(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
}

function normalizeKey(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s\-_]+/g, '')
}

function propertyPlainText(prop: any): string {
  if (!prop || typeof prop !== 'object') return ''

  try {
    switch (prop.type) {
      case 'title':
        return (prop.title ?? []).map((t: any) => t?.plain_text ?? '').join('').trim()
      case 'rich_text':
        return (prop.rich_text ?? []).map((t: any) => t?.plain_text ?? '').join('').trim()
      case 'number':
        return prop.number === null || prop.number === undefined ? '' : String(prop.number)
      case 'checkbox':
        return typeof prop.checkbox === 'boolean' ? String(prop.checkbox) : ''
      case 'status':
        return prop.status?.name ? String(prop.status.name).trim() : ''
      case 'date':
        return prop.date?.start ? String(prop.date.start).trim() : ''
      case 'select':
        return prop.select?.name ? String(prop.select.name).trim() : ''
      case 'multi_select':
        return Array.isArray(prop.multi_select)
          ? prop.multi_select.map((s: any) => s?.name ?? '').filter(Boolean).join(', ').trim()
          : ''
      case 'people':
        return Array.isArray(prop.people)
          ? prop.people.map((p: any) => p?.name ?? '').filter(Boolean).join(', ').trim()
          : ''
      case 'email':
        return prop.email ? String(prop.email).trim() : ''
      case 'phone_number':
        return prop.phone_number ? String(prop.phone_number).trim() : ''
      case 'url':
        return prop.url ? String(prop.url).trim() : ''
      case 'formula': {
        const f = prop.formula
        if (!f || typeof f !== 'object') return ''
        if (f.type === 'string') return (f.string ?? '').trim()
        if (f.type === 'number') return f.number === null || f.number === undefined ? '' : String(f.number)
        if (f.type === 'boolean') return typeof f.boolean === 'boolean' ? String(f.boolean) : ''
        if (f.type === 'date') return f.date?.start ? String(f.date.start).trim() : ''
        return ''
      }
      case 'rollup': {
        const r = prop.rollup
        if (!r || typeof r !== 'object') return ''
        if (r.type === 'number') return r.number === null || r.number === undefined ? '' : String(r.number)
        if (r.type === 'date') return r.date?.start ? String(r.date.start).trim() : ''
        if (r.type === 'array' && Array.isArray(r.array)) {
          const parts: string[] = []
          for (const item of r.array) {
            const text = propertyPlainText(item)
            if (text) parts.push(text)
          }
          return parts.join(' ').trim()
        }
        return ''
      }
      default:
        return ''
    }
  } catch {
    return ''
  }
}

function propertyItemsPlainText(propertyItems: any): string {
  if (!propertyItems || typeof propertyItems !== 'object') return ''
  if (Array.isArray(propertyItems.results)) {
    return propertyItems.results.map(propertyPlainText).filter(Boolean).join(' ').trim()
  }
  return propertyPlainText(propertyItems)
}

function getPropertyByCandidates(properties: any, candidates: string[]): any | null {
  if (!properties || typeof properties !== 'object') return null
  const candidateKeys = new Set(candidates.map(normalizeKey))
  for (const key of Object.keys(properties)) {
    if (candidateKeys.has(normalizeKey(key))) return properties[key]
  }
  return null
}

async function getCandidatePropertyText(env: Env, pageId: string, properties: any, candidates: string[]): Promise<string> {
  const prop = getPropertyByCandidates(properties, candidates)
  const direct = propertyPlainText(prop)
  if (direct) return direct

  const propertyId: string | undefined = prop?.id
  if (!propertyId) return ''

  try {
    const items = await notionFetch(env, `/pages/${encodeURIComponent(pageId)}/properties/${encodeURIComponent(propertyId)}`, {
      method: 'GET',
    })
    return propertyItemsPlainText(items)
  } catch {
    return ''
  }
}

function splitFullName(fullName: unknown): { firstName: string; lastName: string } {
  const s = String(fullName ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return { firstName: '', lastName: '' }
  const parts = s.split(' ')
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

function buildPropertyUpdate(type: string, value: unknown): any {
  switch (type) {
    case 'title':
      return { title: [{ text: { content: String(value ?? '') } }] }
    case 'rich_text':
      return { rich_text: [{ text: { content: String(value ?? '') } }] }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value ?? ''))
      if (Number.isNaN(n)) throw new Error(`Value is not a number: ${value}`)
      return { number: n }
    }
    case 'checkbox':
      if (typeof value === 'boolean') return { checkbox: value }
      {
        const s = String(value ?? '').toLowerCase()
        return { checkbox: s === 'true' || s === '1' || s === 'yes' }
      }
    case 'select':
      return { select: value ? { name: String(value) } : null }
    case 'status':
      return { status: value ? { name: String(value) } : null }
    case 'date':
      return { date: value ? { start: String(value) } : null }
    default:
      throw new Error(`Property type not supported by this endpoint: ${type}`)
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.NOTION_TOKEN) {
      return json({ error: 'Missing NOTION_TOKEN (set as Worker secret).' }, { status: 500 })
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req, env) })
    }

    // If ALLOWED_ORIGIN is set, reject unknown origins.
    if (env.ALLOWED_ORIGIN) {
      const origin = req.headers.get('Origin')
      if (origin && origin !== env.ALLOWED_ORIGIN && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        return json({ error: 'Origin not allowed' }, { status: 403, headers: corsHeaders(req, env) })
      }
    }

    const url = new URL(req.url)
    const path = url.pathname

    try {
      if (path === '/api/health' && req.method === 'GET') {
        return json({ ok: true }, { headers: corsHeaders(req, env) })
      }

      if (path === '/api/notion/search' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}))
        const query = body?.query
        const page_size = body?.page_size
        if (!query || typeof query !== 'string') {
          return json({ error: 'query is required' }, { status: 400, headers: corsHeaders(req, env) })
        }

        const response = await notionFetch(env, '/search', {
          method: 'POST',
          body: JSON.stringify({
            query,
            page_size: typeof page_size === 'number' ? page_size : 5,
            filter: { value: 'page', property: 'object' },
          }),
        })

        const results = (response.results ?? []).map((p: any) => ({
          id: p.id,
          title: getPlainTitleFromPage(p),
          url: p.url,
        }))

        return json({ results }, { headers: corsHeaders(req, env) })
      }

      if (path === '/api/notion/scan' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}))
        const scannedId = typeof body?.id === 'string' ? body.id.trim() : ''
        const debug = body?.debug === true
        if (!scannedId) {
          return json({ error: 'id is required' }, { status: 400, headers: corsHeaders(req, env) })
        }

        const search = await notionFetch(env, '/search', {
          method: 'POST',
          body: JSON.stringify({
            query: scannedId,
            page_size: 20,
            filter: { value: 'page', property: 'object' },
          }),
        })

        const results = (search?.results ?? []).map((p: any) => ({
          id: p.id,
          title: getPlainTitleFromPage(p),
          url: p.url,
        }))

        const target = normalizeForMatch(scannedId)
        const exactMatches = results.filter((r: any) => normalizeForMatch(r.title) === target)
        if (exactMatches.length === 0) {
          return json(
            {
              error: `No exact title match for id ${scannedId}`,
              resultsCount: results.length,
              hint: 'Make sure the Notion page title is exactly the scanned 8-digit id.',
            },
            { status: 404, headers: corsHeaders(req, env) },
          )
        }
        if (exactMatches.length > 1) {
          return json(
            {
              error: `Multiple pages match id ${scannedId}`,
              matches: exactMatches.map((m: any) => ({ id: m.id, title: m.title, url: m.url })),
            },
            { status: 409, headers: corsHeaders(req, env) },
          )
        }

        const page = exactMatches[0]

        const updated = await notionFetch(env, `/pages/${encodeURIComponent(page.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            properties: {
              '2025-WD': { checkbox: true },
            },
          }),
        })

        const pageAfter = await notionFetch(env, `/pages/${encodeURIComponent(page.id)}`, { method: 'GET' })
        const props = pageAfter?.properties ?? updated?.properties

        const firstNameCandidates = ['first name', 'firstname', 'ชื่อ', 'ชื่อจริง']
        const lastNameCandidates = ['last name', 'lastname', 'surname', 'นามสกุล', 'สกุล']
        const fullNameCandidates = ['full name', 'fullname', 'name', 'ชื่อ-สกุล', 'ชื่อสกุล', 'ชื่อ นามสกุล']
        const docCandidates = ['doc', 'document', 'เอกสาร', 'docname', 'doc name']

        let firstName = await getCandidatePropertyText(env, page.id, props, firstNameCandidates)
        let lastName = await getCandidatePropertyText(env, page.id, props, lastNameCandidates)
        let fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
        if (!fullName) fullName = await getCandidatePropertyText(env, page.id, props, fullNameCandidates)
        if (!firstName && !lastName && fullName) {
          const split = splitFullName(fullName)
          firstName = split.firstName
          lastName = split.lastName
        }
        fullName = fullName || [firstName, lastName].filter(Boolean).join(' ').trim()

        const doc = await getCandidatePropertyText(env, page.id, props, docCandidates)

        const responseBody: any = {
          ok: true,
          apiVersion: API_VERSION,
          scannedId,
          pageId: page.id,
          title: page.title,
          firstName,
          lastName,
          fullName,
          doc,
        }

        if (debug) {
          responseBody.debugProperties = Object.fromEntries(
            Object.entries(props ?? {}).map(([key, p]: any) => [
              key,
              { id: p?.id, type: p?.type, preview: propertyPlainText(p) },
            ]),
          )
        }

        return json(responseBody, { headers: corsHeaders(req, env) })
      }

      const updateMatch = path.match(/^\/api\/notion\/pages\/([^/]+)\/property$/)
      if (updateMatch && req.method === 'PATCH') {
        const pageId = decodeURIComponent(updateMatch[1])
        const body = await req.json().catch(() => ({}))
        const propertyName = body?.propertyName
        const value = body?.value

        if (!propertyName || typeof propertyName !== 'string') {
          return json({ error: 'propertyName is required' }, { status: 400, headers: corsHeaders(req, env) })
        }
        if (value === undefined) {
          return json({ error: 'value is required' }, { status: 400, headers: corsHeaders(req, env) })
        }

        const page = await notionFetch(env, `/pages/${pageId}`, { method: 'GET' })
        const prop = page?.properties?.[propertyName]
        if (!prop?.type) {
          return json(
            { error: `Property not found on page: ${propertyName}` },
            { status: 400, headers: corsHeaders(req, env) },
          )
        }

        const type: string = prop.type
        const typed = buildPropertyUpdate(type, value)

        const updated = await notionFetch(env, `/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            properties: {
              [propertyName]: typed,
            },
          }),
        })

        return json(
          { ok: true, pageId: updated.id, propertyName, type },
          { headers: corsHeaders(req, env) },
        )
      }

      return json({ error: 'Not found' }, { status: 404, headers: corsHeaders(req, env) })
    } catch (e: any) {
      return json({ error: e?.message ?? String(e) }, { status: 500, headers: corsHeaders(req, env) })
    }
  },
}

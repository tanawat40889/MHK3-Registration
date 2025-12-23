type Env = {
  NOTION_TOKEN: string
  ALLOWED_ORIGIN?: string
}

const NOTION_VERSION = '2022-06-28'

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

function buildPropertyUpdate(type: string, value: string): any {
  switch (type) {
    case 'title':
      return { title: [{ text: { content: value } }] }
    case 'rich_text':
      return { rich_text: [{ text: { content: value } }] }
    case 'number': {
      const n = Number(value)
      if (Number.isNaN(n)) throw new Error(`Value is not a number: ${value}`)
      return { number: n }
    }
    case 'checkbox':
      return { checkbox: value === 'true' || value === '1' || value.toLowerCase() === 'yes' }
    case 'select':
      return { select: value ? { name: value } : null }
    case 'status':
      return { status: value ? { name: value } : null }
    case 'date':
      return { date: value ? { start: value } : null }
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

      const updateMatch = path.match(/^\/api\/notion\/pages\/([^/]+)\/property$/)
      if (updateMatch && req.method === 'PATCH') {
        const pageId = decodeURIComponent(updateMatch[1])
        const body = await req.json().catch(() => ({}))
        const propertyName = body?.propertyName
        const value = body?.value

        if (!propertyName || typeof propertyName !== 'string') {
          return json({ error: 'propertyName is required' }, { status: 400, headers: corsHeaders(req, env) })
        }
        if (typeof value !== 'string') {
          return json({ error: 'value must be a string' }, { status: 400, headers: corsHeaders(req, env) })
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

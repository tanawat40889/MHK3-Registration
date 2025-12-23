const NOTION_VERSION = '2022-06-28'

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

function getToken() {
  const token = process.env.NOTION_TOKEN
  if (!token) return null
  return token
}

function extractTitle(page) {
  const props = page?.properties
  if (!props || typeof props !== 'object') return ''

  for (const key of Object.keys(props)) {
    const prop = props[key]
    if (prop?.type === 'title') {
      return (prop.title || []).map((t) => t?.plain_text || '').join('').trim()
    }
  }
  return ''
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {})
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })

  const token = getToken()
  if (!token) return json(500, { error: 'Missing NOTION_TOKEN (set as Netlify env var).' })

  let payload
  try {
    payload = event.body ? JSON.parse(event.body) : {}
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const query = typeof payload.query === 'string' ? payload.query : ''
  const page_size = Number.isFinite(payload.page_size) ? payload.page_size : 5

  const res = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, page_size }),
  })

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    return json(res.status, { error: data?.message || data?.error || 'Notion API error' })
  }

  const results = (data?.results || [])
    .filter((r) => r?.object === 'page')
    .map((p) => ({
      id: p.id,
      url: p.url,
      title: extractTitle(p),
    }))

  return json(200, { results })
}

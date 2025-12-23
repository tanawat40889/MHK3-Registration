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

function normalize(s) {
  return String(s || '').trim().replace(/\s+/g, '')
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

  const scannedId = typeof payload.id === 'string' ? payload.id.trim() : ''
  if (!scannedId) return json(400, { error: 'id is required' })

  // 1) Search pages
  const searchRes = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: scannedId,
      page_size: 20,
      filter: { value: 'page', property: 'object' },
    }),
  })

  const searchData = await searchRes.json().catch(() => null)
  if (!searchRes.ok) {
    return json(searchRes.status, { error: searchData?.message || searchData?.error || 'Notion API error' })
  }

  const results = (searchData?.results || [])
    .filter((r) => r?.object === 'page')
    .map((p) => ({
      id: p.id,
      url: p.url,
      title: extractTitle(p),
    }))

  const exactMatches = results.filter((r) => normalize(r.title) === normalize(scannedId))

  if (exactMatches.length === 0) {
    return json(404, {
      error: `ไม่พบหมายเลข ${scannedId} รบกวนสแกนใหม่อีกครั้ง`,
      resultsCount: results.length,
      hint: 'Make sure the Notion page title is exactly the scanned 8-digit id.',
    })
  }

  if (exactMatches.length > 1) {
    return json(409, {
      error: `พบหมายเลข ${scannedId} ซ้ำกันหลายรายการในระบบ รบกวนสแกนใหม่อีกครั้ง`,
      matches: exactMatches.map((m) => ({ id: m.id, title: m.title, url: m.url })),
    })
  }

  const page = exactMatches[0]

  // 2) Update checkbox property "2025-WD" to true
  const updateRes = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(page.id)}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        '2025-WD': { checkbox: true },
      },
    }),
  })

  const updateData = await updateRes.json().catch(() => null)
  if (!updateRes.ok) {
    return json(updateRes.status, { error: updateData?.message || 'Failed to update page' })
  }

  return json(200, { ok: true, scannedId, pageId: page.id, title: page.title })
}

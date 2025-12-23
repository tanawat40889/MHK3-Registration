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

function pageIdFromPath(pathname) {
  // /api/notion/pages/<pageId>/property
  const m = pathname.match(/^\/api\/notion\/pages\/([^/]+)\/property$/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {})
  if (event.httpMethod !== 'PATCH') return json(405, { error: 'Method not allowed' })

  const token = getToken()
  if (!token) return json(500, { error: 'Missing NOTION_TOKEN (set as Netlify env var).' })

  const pageId = pageIdFromPath(event.path || '')
  if (!pageId) return json(400, { error: 'Missing pageId in URL' })

  let payload
  try {
    payload = event.body ? JSON.parse(event.body) : {}
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const propertyName = typeof payload.propertyName === 'string' ? payload.propertyName.trim() : ''
  const value = payload.value

  if (!propertyName) return json(400, { error: 'Missing propertyName' })

  // 1) Retrieve page to discover property type
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  })

  const pageData = await pageRes.json().catch(() => null)
  if (!pageRes.ok) {
    return json(pageRes.status, { error: pageData?.message || 'Failed to fetch page' })
  }

  const prop = pageData?.properties?.[propertyName]
  const type = prop?.type
  if (!type) return json(400, { error: `Property not found: ${propertyName}` })

  // 2) Build update payload based on type
  let properties
  switch (type) {
    case 'title':
      properties = { [propertyName]: { title: [{ text: { content: String(value) } }] } }
      break
    case 'rich_text':
      properties = { [propertyName]: { rich_text: [{ text: { content: String(value) } }] } }
      break
    case 'number':
      properties = { [propertyName]: { number: value === '' ? null : Number(value) } }
      break
    case 'checkbox':
      properties = { [propertyName]: { checkbox: Boolean(value) } }
      break
    case 'select':
      properties = { [propertyName]: { select: value ? { name: String(value) } : null } }
      break
    case 'status':
      properties = { [propertyName]: { status: value ? { name: String(value) } : null } }
      break
    case 'date':
      properties = { [propertyName]: { date: value ? { start: String(value) } : null } }
      break
    default:
      return json(400, { error: `Unsupported property type: ${type}` })
  }

  const updateRes = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  })

  const updateData = await updateRes.json().catch(() => null)
  if (!updateRes.ok) {
    return json(updateRes.status, { error: updateData?.message || 'Failed to update page' })
  }

  return json(200, { ok: true, type })
}

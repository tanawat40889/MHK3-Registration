const NOTION_VERSION = '2022-06-28'

const API_VERSION = '2026-02-26.2'

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

function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s\-_]+/g, '')
}

function propertyPlainText(prop) {
  if (!prop || typeof prop !== 'object') return ''

  try {
    switch (prop.type) {
      case 'title':
        return (prop.title ?? []).map((t) => t?.plain_text ?? '').join('').trim()
      case 'rich_text':
        return (prop.rich_text ?? []).map((t) => t?.plain_text ?? '').join('').trim()
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
          ? prop.multi_select.map((s) => s?.name ?? '').filter(Boolean).join(', ').trim()
          : ''
      case 'people':
        return Array.isArray(prop.people)
          ? prop.people.map((p) => p?.name ?? '').filter(Boolean).join(', ').trim()
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
          const parts = []
          for (const item of r.array) {
            if (!item || typeof item !== 'object') continue
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

function splitFullName(fullName) {
  const s = String(fullName ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return { firstName: '', lastName: '' }
  const parts = s.split(' ')
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

function getPropertyByCandidates(properties, candidates) {
  if (!properties || typeof properties !== 'object') return null
  const candidateKeys = new Set(candidates.map(normalizeKey))

  for (const key of Object.keys(properties)) {
    if (candidateKeys.has(normalizeKey(key))) return properties[key]
  }
  return null
}

function propertyItemsPlainText(propertyItems) {
  if (!propertyItems || typeof propertyItems !== 'object') return ''
  if (Array.isArray(propertyItems.results)) {
    return propertyItems.results.map(propertyPlainText).filter(Boolean).join(' ').trim()
  }
  return propertyPlainText(propertyItems)
}

async function fetchPropertyItems(token, pageId, propertyId) {
  const res = await fetch(
    `https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}/properties/${encodeURIComponent(propertyId)}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
    },
  )

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.message || `Failed to retrieve property items (HTTP ${res.status})`)
  }
  return data
}

async function getCandidatePropertyText({ token, pageId, properties, candidates }) {
  const prop = getPropertyByCandidates(properties, candidates)
  const direct = propertyPlainText(prop)
  if (direct) return direct

  const propertyId = prop?.id
  if (!propertyId) return ''

  try {
    const propertyItems = await fetchPropertyItems(token, pageId, propertyId)
    return propertyItemsPlainText(propertyItems)
  } catch {
    return ''
  }
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

  const debug = payload?.debug === true

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

  // Fetch the page after update so rollups/formulas are up-to-date.
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(page.id)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  })

  const pageData = await pageRes.json().catch(() => null)
  if (!pageRes.ok) {
    return json(pageRes.status, { error: pageData?.message || 'Failed to retrieve page after update' })
  }

  const props = pageData?.properties ?? updateData?.properties
  const firstNameCandidates = ['first name', 'firstname', 'ชื่อ', 'ชื่อจริง']
  const lastNameCandidates = ['last name', 'lastname', 'surname', 'นามสกุล', 'สกุล']
  const fullNameCandidates = ['full name', 'fullname', 'name', 'ชื่อ-สกุล', 'ชื่อสกุล', 'ชื่อ นามสกุล']
  const docCandidates = ['doc', 'document', 'เอกสาร', 'docname', 'doc name']

  let firstName = await getCandidatePropertyText({
    token,
    pageId: page.id,
    properties: props,
    candidates: firstNameCandidates,
  })
  let lastName = await getCandidatePropertyText({
    token,
    pageId: page.id,
    properties: props,
    candidates: lastNameCandidates,
  })
  let fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
  if (!fullName) {
    fullName = await getCandidatePropertyText({
      token,
      pageId: page.id,
      properties: props,
      candidates: fullNameCandidates,
    })
  }

  const doc = await getCandidatePropertyText({
    token,
    pageId: page.id,
    properties: props,
    candidates: docCandidates,
  })

  if (!firstName && !lastName && fullName) {
    const split = splitFullName(fullName)
    firstName = split.firstName
    lastName = split.lastName
  }

  fullName = fullName || [firstName, lastName].filter(Boolean).join(' ').trim()

  const responseBody = {
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
      Object.entries(props ?? {}).map(([key, p]) => [
        key,
        {
          id: p?.id,
          type: p?.type,
          preview: propertyPlainText(p),
        },
      ]),
    )
  }

  return json(200, responseBody)
}

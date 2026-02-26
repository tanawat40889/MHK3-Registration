import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { Client } from '@notionhq/client'

const NOTION_TOKEN = process.env.NOTION_TOKEN
const PORT = Number(process.env.PORT ?? 8787)

const API_VERSION = '2026-02-26.2'

if (!NOTION_TOKEN) {
  // Fail fast so users don’t think updates are “working” when they aren’t.
  // eslint-disable-next-line no-console
  console.error('Missing NOTION_TOKEN in environment')
  process.exit(1)
}

const notion = new Client({ auth: NOTION_TOKEN })

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(
  cors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
  }),
)

function getPlainTitle(page) {
  try {
    const props = page?.properties ?? {}
    for (const key of Object.keys(props)) {
      const p = props[key]
      if (p?.type === 'title') {
        return (p.title ?? []).map((t) => t?.plain_text ?? '').join('')
      }
    }
  } catch {
    // ignore
  }
  return ''
}

function normalizeForMatch(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
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
            // rollup array items have their own type
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
  // Sometimes Notion returns a single property item object with { type, ... }
  return propertyPlainText(propertyItems)
}

async function getCandidatePropertyText({ notionClient, pageId, properties, candidates }) {
  const prop = getPropertyByCandidates(properties, candidates)
  const direct = propertyPlainText(prop)
  if (direct) return direct

  const propertyId = prop?.id
  if (!propertyId || !pageId) return ''

  try {
    const propertyItems = await notionClient.pages.properties.retrieve({
      page_id: pageId,
      property_id: propertyId,
    })
    return propertyItemsPlainText(propertyItems)
  } catch {
    return ''
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// Search pages by query text (returns a list with id + title)
app.post('/api/notion/search', async (req, res) => {
  try {
    const { query, page_size } = req.body ?? {}
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' })
      return
    }

    const response = await notion.search({
      query,
      page_size: typeof page_size === 'number' ? page_size : 5,
      filter: { value: 'page', property: 'object' },
    })

    const results = (response.results ?? []).map((p) => ({
      id: p.id,
      title: getPlainTitle(p),
      url: p.url,
    }))

    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// Scan flow: given an 8-digit id, find matching page and set checkbox property "2025-WD" to true.
app.post('/api/notion/scan', async (req, res) => {
  try {
    const { id, debug } = req.body ?? {}
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'id is required' })
      return
    }

    const scannedId = id.trim()
    const response = await notion.search({
      query: scannedId,
      page_size: 20,
      filter: { value: 'page', property: 'object' },
    })

    const results = (response.results ?? []).map((p) => ({
      id: p.id,
      title: getPlainTitle(p),
      url: p.url,
    }))

    const target = normalizeForMatch(scannedId)
    const exactMatches = results.filter((r) => normalizeForMatch(r.title) === target)

    if (exactMatches.length === 0) {
      res.status(404).json({
        error: `No exact title match for id ${scannedId}`,
        resultsCount: results.length,
        hint: 'Make sure the Notion page title is exactly the scanned 8-digit id.',
      })
      return
    }
    if (exactMatches.length > 1) {
      res.status(409).json({
        error: `Multiple pages match id ${scannedId}`,
        matches: exactMatches.map((m) => ({ id: m.id, title: m.title, url: m.url })),
      })
      return
    }

    const page = exactMatches[0]
    const updated = await notion.pages.update({
      page_id: page.id,
      properties: {
        '2025-WD': { checkbox: true },
      },
    })

    // Fetch fresh properties so we can display name/surname after scan.
    const pageAfterUpdate = await notion.pages.retrieve({ page_id: page.id })
    const props = pageAfterUpdate?.properties ?? updated?.properties
    const firstNameCandidates = ['first name', 'firstname', 'ชื่อ', 'ชื่อจริง']
    const lastNameCandidates = ['last name', 'lastname', 'surname', 'นามสกุล', 'สกุล']
    const fullNameCandidates = ['full name', 'fullname', 'name', 'ชื่อ-สกุล', 'ชื่อสกุล', 'ชื่อ นามสกุล']
    const docCandidates = ['doc', 'document', 'เอกสาร', 'docname', 'doc name']

    let firstName = await getCandidatePropertyText({
      notionClient: notion,
      pageId: page.id,
      properties: props,
      candidates: firstNameCandidates,
    })
    let lastName = await getCandidatePropertyText({
      notionClient: notion,
      pageId: page.id,
      properties: props,
      candidates: lastNameCandidates,
    })
    let fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
    if (!fullName) {
      fullName = await getCandidatePropertyText({
        notionClient: notion,
        pageId: page.id,
        properties: props,
        candidates: fullNameCandidates,
      })
    }

    const doc = await getCandidatePropertyText({
      notionClient: notion,
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
      pageId: updated.id,
      title: page.title,
      firstName,
      lastName,
      fullName,
      doc,
    }

    if (debug === true) {
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

    res.json(responseBody)
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// Update a single page property by name, using the page’s current property type
app.patch('/api/notion/pages/:pageId/property', async (req, res) => {
  try {
    const { pageId } = req.params
    const { propertyName, value } = req.body ?? {}

    if (!pageId || typeof pageId !== 'string') {
      res.status(400).json({ error: 'pageId is required' })
      return
    }
    if (!propertyName || typeof propertyName !== 'string') {
      res.status(400).json({ error: 'propertyName is required' })
      return
    }
    if (value === undefined) {
      res.status(400).json({ error: 'value is required' })
      return
    }

    const page = await notion.pages.retrieve({ page_id: pageId })
    const prop = page?.properties?.[propertyName]
    if (!prop || !prop.type) {
      res.status(400).json({
        error: `Property not found on page: ${propertyName}`,
      })
      return
    }

    const type = prop.type
    let typed

    switch (type) {
      case 'title':
        typed = { title: [{ text: { content: String(value ?? '') } }] }
        break
      case 'rich_text':
        typed = { rich_text: [{ text: { content: String(value ?? '') } }] }
        break
      case 'number': {
        const n = typeof value === 'number' ? value : Number(String(value ?? ''))
        if (Number.isNaN(n)) {
          res.status(400).json({ error: `Value is not a number: ${value}` })
          return
        }
        typed = { number: n }
        break
      }
      case 'checkbox':
        if (typeof value === 'boolean') {
          typed = { checkbox: value }
        } else {
          const s = String(value ?? '').toLowerCase()
          typed = { checkbox: s === 'true' || s === '1' || s === 'yes' }
        }
        break
      case 'select':
        typed = { select: value ? { name: String(value) } : null }
        break
      case 'status':
        typed = { status: value ? { name: String(value) } : null }
        break
      case 'date':
        // Accept ISO date or date-time string
        typed = { date: value ? { start: String(value) } : null }
        break
      default:
        res.status(400).json({
          error: `Property type not supported by this demo endpoint: ${type}`,
        })
        return
    }

    const updated = await notion.pages.update({
      page_id: pageId,
      properties: {
        [propertyName]: typed,
      },
    })

    res.json({ ok: true, pageId: updated.id, propertyName, type })
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Notion API server listening on http://localhost:${PORT}`)
})

import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { Client } from '@notionhq/client'

const NOTION_TOKEN = process.env.NOTION_TOKEN
const PORT = Number(process.env.PORT ?? 8787)

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
    if (typeof value !== 'string') {
      res.status(400).json({ error: 'value must be a string' })
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
        typed = { title: [{ text: { content: value } }] }
        break
      case 'rich_text':
        typed = { rich_text: [{ text: { content: value } }] }
        break
      case 'number': {
        const n = Number(value)
        if (Number.isNaN(n)) {
          res.status(400).json({ error: `Value is not a number: ${value}` })
          return
        }
        typed = { number: n }
        break
      }
      case 'checkbox':
        typed = { checkbox: value === 'true' || value === '1' || value.toLowerCase() === 'yes' }
        break
      case 'select':
        typed = { select: value ? { name: value } : null }
        break
      case 'status':
        typed = { status: value ? { name: value } : null }
        break
      case 'date':
        // Accept ISO date or date-time string
        typed = { date: value ? { start: value } : null }
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

# SGTID Barcode Reader

Simple mobile-first web app that uses the camera to decode barcodes using QuaggaJS (quagga2).

## Supported formats

- Includes **CODABAR** (`codabar_reader`) and several common 1D formats (Code 128/39, EAN/UPC, ITF).

## Run locally

```bash
npm install
npm run dev
```

Open the URL shown by Vite (usually `http://localhost:5173`).

## Notion backend + Neocities deployment

Neocities only hosts static files (it cannot run Node/Express). To use the Notion features when hosting on Neocities, deploy the backend as a serverless endpoint.

This repo includes a Cloudflare Worker backend in [worker/src/worker.ts](worker/src/worker.ts) that exposes:

- `POST /api/notion/search`
- `PATCH /api/notion/pages/:pageId/property`

### Deploy backend (Cloudflare Worker)

From the repo root:

```bash
cd worker
npx wrangler@latest deploy
```

Set secrets:

```bash
cd worker
npx wrangler@latest secret put NOTION_TOKEN
npx wrangler@latest secret put ALLOWED_ORIGIN
```

For `ALLOWED_ORIGIN`, use your Neocities origin, e.g. `https://YOURNAME.neocities.org`.

For your site, set it to:

`https://bkk11.neocities.org`

Note: you can name the Worker using `bkk11` (this repo uses `bkk11-notion-proxy`), but `ALLOWED_ORIGIN` must be a full origin including `https://`.

### Build frontend pointing at the Worker

Set the API base URL at build time (Vite will inline it into the bundle):

```bash
VITE_API_BASE=https://YOUR-WORKER.your-subdomain.workers.dev npm run build
```

For your deployed Worker:

```bash
VITE_API_BASE=https://bkk11-notion-proxy.bkk11.workers.dev npm run build
```

Health check (should return JSON):

`https://bkk11-notion-proxy.bkk11.workers.dev/api/health`

### Neocities CSP note

If you see an error like:

"Connecting to 'https://bkk11-notion-proxy.bkk11.workers.dev/...' violates Content Security Policy (connect-src 'self' ...)"

That CSP is coming from **Neocities** and it blocks outgoing `fetch()` requests to your Worker.

Fix: in Neocities site settings, update your Content Security Policy to allow your Worker domain in `connect-src`, e.g. add:

`connect-src 'self' https://bkk11-notion-proxy.bkk11.workers.dev`

Then upload the contents of `dist/` to Neocities.

## Free hosting alternative (recommended): Netlify (FE + serverless API)

Neocities CSP can block `fetch()` to another domain. Netlify can host the frontend **and** provide a serverless backend on the **same origin**, so the Notion calls work without CSP issues.

This repo includes Netlify Functions in [netlify/functions](netlify/functions) and redirects in [netlify.toml](netlify.toml) so your frontend can call:

- `POST /api/notion/search`
- `PATCH /api/notion/pages/:pageId/property`

### Deploy on Netlify

1) Push this repo to GitHub
2) Netlify → “Add new site” → “Import an existing project”
3) Build settings:
	- Build command: `npm run build`
	- Publish directory: `dist`

4) Netlify → Site settings → Environment variables:
	- `NOTION_TOKEN` = your Notion integration token
	- (optional) `ALLOWED_ORIGIN` = `https://bkk11.neocities.org` (not required for Netlify same-origin)

5) Deploy

Health check after deploy:

`https://YOUR-NETLIFY-SITE.netlify.app/api/health`

Note: for Netlify, you can keep `VITE_API_BASE` empty (default is same-origin `/api/...`).

## Notes (mobile)

- Use HTTPS (or `localhost`) for camera access.
- Grant camera permission when prompted.
- The app requests the **rear camera** via `facingMode: environment` when available.

## How it works

- Tap “Start camera” and point at the barcode.
- The decoded string and format will appear when detected.

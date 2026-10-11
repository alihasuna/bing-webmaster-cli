// Shared test setup: hermetic env + a fetch mock. Imported before the CLI module.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const tmp = mkdtempSync(join(tmpdir(), 'bing-webmaster-test-'))
process.env.BING_WEBMASTER_API_KEY = 'test-key'
process.env.BING_WEBMASTER_NO_DOTENV = '1'
process.env.BING_WEBMASTER_STATE_FILE = join(tmp, 'state.json')
delete process.env.BING_SITE_URL
delete process.env.INDEXNOW_KEY
delete process.env.INDEXNOW_KEY_LOCATION

export const SITE = 'https://example.com/'

// routes: { BingMethod: value | (call) => value, 'https://full/url': Response | (call) => Response }
// A plain value is wrapped as Bing's { d: value } JSON envelope.
export function mockFetch(t, routes = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const bing = url.hostname === 'ssl.bing.com' ? url.pathname.split('/').pop() : null
    const call = { url, bing, http: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const route = bing && bing in routes ? routes[bing] : routes[url.href]
    if (route === undefined) throw new Error(`Unexpected fetch: ${url.href}`)
    const value = typeof route === 'function' ? await route(call) : route
    if (value instanceof Response) return value
    return new Response(JSON.stringify({ d: value ?? null }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

export async function captureLog(fn) {
  const lines = []
  const original = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

export const xml = (body, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'application/xml' } })

export const urlset = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(([loc, lastmod]) => `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`

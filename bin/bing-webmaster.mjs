#!/usr/bin/env node
/**
 * bing-webmaster — command-line control of Bing Webmaster Tools via its official API.
 *
 *   bing-webmaster help                       all commands, grouped by risk
 *   bing-webmaster summary --site <url>       one-screen health check
 *   bing-webmaster mcp [--read-only]          run as an MCP server (stdio) for AI assistants
 *
 * Every Bing Webmaster API method (IWebmasterApi) has a command, except the
 * obsolete deep-link methods (reachable via `call` if ever needed).
 *
 * Safety model
 *   read    runs immediately
 *   write   DRY-RUN unless --yes (prints the exact request it would send)
 *   danger  DRY-RUN unless --yes, AND requires an explicit --site (or a site URL
 *           argument) so nothing fires against BING_SITE_URL by accident
 *   In MCP mode, write/danger tools return the dry run plus a one-time
 *   confirm_token and only send when called again with that token.
 *
 * Common options
 *   --site <url>   Bing site entry, exactly as listed by `sites` (or set BING_SITE_URL)
 *   --limit <n>    Max rows to print (default 25)
 *   --json         JSON output (dates normalised to YYYY-MM-DD)
 *   --csv          CSV output for table reads
 *   --raw          JSON output exactly as Bing returned it
 *   --yes          Actually send a write/danger request
 *
 * Auth: BING_WEBMASTER_API_KEY (Bing Webmaster → Settings → API access → API Key),
 * from the environment, a .env / .env.local file in the current directory, or
 * ~/.config/bing-webmaster/.env. IndexNow commands use INDEXNOW_KEY instead.
 *
 * Notes
 * - Bing JSON API: GET params in the query string; POST bodies are wrapped
 *   requests keyed by the C# parameter names; dates are WCF "/Date(ms)/".
 * - A DNS-verified domain entry (https://example.com/) also covers its www host.
 * - IndexNow is a separate protocol (api.indexnow.org), not part of this API.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const API = 'https://ssl.bing.com/webmaster/api.svc/json/'
const NS = 'Microsoft.Bing.Webmaster.Api'
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
const SUBMIT_BATCH_MAX = 500 // Bing: max URLs per SubmitUrlBatch request
const INDEXNOW_BATCH_MAX = 10000 // IndexNow: max URLs per POST
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bing-webmaster')
const stateFile = () => process.env.BING_WEBMASTER_STATE_FILE || join(configDir(), 'state.json')

// ── args & per-invocation context ─────────────────────────────────────
const BOOLEAN_FLAGS = new Set(['json', 'raw', 'csv', 'yes', 'directory', 'cache-only', 'all-subdomains', 'get', 'post', 'help', 'changed', 'read-only', 'version'])

export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s)
    if (inline !== undefined) flags[name] = inline
    else if (BOOLEAN_FLAGS.has(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[name] = true
    else flags[name] = argv[++i]
  }
  const [command = 'help', ...args] = positional
  return { command, args, flags }
}

// Commands read these; setContext() swaps them per CLI run / MCP tool call
// (MCP calls are processed one at a time, so this is safe).
let flags = {}
let SITE = null
let LIMIT = 25

function setContext(f = {}) {
  flags = f
  const s = f.site || process.env.BING_SITE_URL
  SITE = s && s !== true ? normaliseSite(s) : null
  LIMIT = Number(f.limit) > 0 ? Number(f.limit) : 25
}

export function normaliseSite(s) {
  const withScheme = /^https?:\/\//.test(s) ? s : `https://${s}`
  return withScheme.endsWith('/') ? withScheme : `${withScheme}/`
}

// ── API ───────────────────────────────────────────────────────────────
async function request(method, { get, body } = {}) {
  const key = process.env.BING_WEBMASTER_API_KEY
  if (!key) throw new Error('Missing BING_WEBMASTER_API_KEY. Set it in your environment or a .env file.\n   Get one at Bing Webmaster Tools → Settings → API access → API Key.')
  const qs = new URLSearchParams({ ...(get ?? {}), apikey: key })
  const res = await fetch(`${API}${method}?${qs}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }
    : undefined)
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : { d: null }
  } catch {
    throw new Error(`${method}: HTTP ${res.status} ${res.status === 404 ? '(endpoint not found — Bing may have retired it)' : `non-JSON response: ${text.slice(0, 200)}`}`)
  }
  if (res.status === 404) throw new Error(`${method}: HTTP 404 — endpoint not found (Bing appears to have retired it)`)
  if (!res.ok || parsed.ErrorCode) {
    const site = get?.siteUrl ?? body?.siteUrl
    const hint = parsed.ErrorCode === 14 ? ` (is ${site ?? 'the site'} on this Bing account?)` : ''
    throw new Error(`${method}: HTTP ${res.status} ${parsed.Message ?? text.slice(0, 200)}${hint}`)
  }
  return parsed.d
}

const get = (method, params = {}) => request(method, { get: params })
const post = (method, body) => request(method, { body })

const wcfDate = (d = new Date()) => `/Date(${d.getTime()})/`

// Bing returns WCF dates: "/Date(1791535751000)/" or "/Date(1696748400000-0700)/".
// Year-1601 / year-1 values are its "never" sentinels.
export function parseDate(v) {
  const m = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(v)
  if (!m) return v
  const ms = Number(m[1])
  return ms < 0 ? null : new Date(ms).toISOString().slice(0, 10)
}

export function clean(v) {
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) if (k !== '__type') out[k] = clean(val)
    return out
  }
  return typeof v === 'string' ? parseDate(v) : v
}

// ── helpers ───────────────────────────────────────────────────────────
function need(value, usage) {
  if (value === undefined || value === '') throw new Error(`Missing argument. Usage: bing-webmaster ${usage}`)
  return value
}

function pick(value, map, label) {
  const key = String(value ?? '').toLowerCase()
  if (!(key in map)) throw new Error(`${label} must be one of: ${Object.keys(map).join(', ')}`)
  return map[key]
}

const page = () => Number(flags.page ?? 0)

function site() {
  if (!SITE) throw new Error('No site selected. Pass --site https://example.com/ or set BING_SITE_URL (run "sites" to list yours).')
  return { siteUrl: SITE }
}

// Query/page stats come back as one row per (key, week); roll them up.
function aggregate(rows, key, label = key) {
  const map = new Map()
  for (const r of rows) {
    const k = r[key]
    const a = map.get(k) ?? { [label]: k, Clicks: 0, Impressions: 0, _pos: 0 }
    a.Clicks += r.Clicks ?? 0
    a.Impressions += r.Impressions ?? 0
    a._pos += (r.AvgImpressionPosition ?? 0) * (r.Impressions ?? 0)
    map.set(k, a)
  }
  return [...map.values()]
    .map(({ _pos, ...a }) => ({
      ...a,
      CTR: a.Impressions ? `${((a.Clicks / a.Impressions) * 100).toFixed(1)}%` : '–',
      AvgPosition: a.Impressions ? +(_pos / a.Impressions).toFixed(1) : null,
    }))
    .sort((x, y) => y.Clicks - x.Clicks || y.Impressions - x.Impressions)
}

const byDateDesc = (rows) => [...rows].sort((a, b) => (a.Date < b.Date ? 1 : -1))

function dateRange(rows) {
  const dates = rows.map((r) => r.Date).filter(Boolean).sort()
  return dates.length ? `${dates[0]} → ${dates.at(-1)}` : 'no data'
}

const ISSUE_FLAGS = {
  1: 'Code301', 2: 'Code302', 4: 'Code4xx', 8: 'Code5xx', 16: 'BlockedByRobotsTxt',
  32: 'ContainsMalware', 64: 'ImportantUrlBlockedByRobotsTxt', 128: 'DnsErrors', 256: 'TimeOutErrors',
}
const issueNames = (n) =>
  Object.entries(ISSUE_FLAGS).filter(([bit]) => n & Number(bit)).map(([, name]) => name).join(', ') || String(n)

const ROLE_NAMES = ['Administrator', 'ReadOnly', 'ReadWrite']

// Keyword research defaults: United States, last ~6 months.
export function keywordParams(q) {
  const to = flags.to ?? new Date().toISOString().slice(0, 10)
  const from = flags.from ?? new Date(Date.now() - 182 * 864e5).toISOString().slice(0, 10)
  for (const [label, d] of [['--from', from], ['--to', to]]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new Error(`${label} must be a date like 2026-01-31`)
  }
  return { q, country: flags.country ?? 'us', language: flags.lang ?? 'en-US', startDate: from, endDate: to }
}

// ── sitemaps ──────────────────────────────────────────────────────────
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const xmlText = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e])
const tag = (block, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(block)
  return m ? xmlText(m[1]) : undefined
}

// Returns [{ loc, lastmod? }] for a sitemap, following sitemap indexes (and .gz).
export async function readSitemap(url, depth = 0) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sitemap ${url} returned HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const xml = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8')
  if (/<(?:\w+:)?sitemapindex[\s>]/.test(xml)) {
    if (depth >= 3) throw new Error(`Sitemap index nesting too deep at ${url}`)
    const children = [...xml.matchAll(/<(?:\w+:)?sitemap>([\s\S]*?)<\/(?:\w+:)?sitemap>/g)].map((m) => tag(m[1], 'loc')).filter(Boolean)
    const nested = []
    for (const child of children) nested.push(...(await readSitemap(child, depth + 1)))
    return dedupe(nested)
  }
  const entries = [...xml.matchAll(/<(?:\w+:)?url>([\s\S]*?)<\/(?:\w+:)?url>/g)]
    .map((m) => ({ loc: tag(m[1], 'loc'), lastmod: tag(m[1], 'lastmod') }))
    .filter((e) => e.loc)
  return dedupe(entries)
}

function dedupe(entries) {
  const seen = new Map()
  for (const e of entries) if (!seen.has(e.loc)) seen.set(e.loc, e)
  return [...seen.values()]
}

const defaultSitemap = () => new URL('sitemap.xml', site().siteUrl).href
const sitemapFlag = () => (typeof flags.sitemap === 'string' ? flags.sitemap : defaultSitemap())

// ── change tracking (submit --changed, indexnow --changed) ────────────
export function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}

function saveState(siteKey, channel, value) {
  const state = loadState()
  state[siteKey] = { ...state[siteKey], [channel]: value }
  mkdirSync(dirname(stateFile()), { recursive: true })
  writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`)
}

// A URL counts as changed if its <lastmod> is newer than the last successful run,
// or it was left over (over quota) last time. Date-only lastmods compare by day,
// so a page edited later on the day of the last run is still picked up.
export function isNewer(lastmod, lastRun) {
  if (!lastmod) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) return lastmod >= lastRun.slice(0, 10)
  const t = Date.parse(lastmod)
  return !Number.isNaN(t) && t > Date.parse(lastRun)
}

function selectChanged(siteKey, channel, entries, cap) {
  const startedAt = new Date().toISOString()
  const prev = loadState()[siteKey]?.[channel]
  const pending = new Set(prev?.pending ?? [])
  const changed = prev?.lastRun ? entries.filter((e) => pending.has(e.loc) || isNewer(e.lastmod, prev.lastRun)) : entries
  const ts = (e) => Date.parse(e.lastmod ?? '') || 0
  changed.sort((a, b) => ts(b) - ts(a)) // newest first when capped
  const take = changed.slice(0, cap)
  const rest = changed.slice(cap)
  const notes = [prev?.lastRun
    ? `${changed.length} of ${entries.length} sitemap URLs changed since ${prev.lastRun}${pending.size ? ` (incl. ${pending.size} left over from last run)` : ''}.`
    : `No previous run recorded for ${siteKey} — treating all ${entries.length} URLs as changed.`]
  const undated = prev?.lastRun ? entries.filter((e) => !e.lastmod).length : 0
  if (undated) notes.push(`${undated} URL(s) have no <lastmod> and are skipped by --changed.`)
  if (rest.length) notes.push(`Capped at ${cap}; ${rest.length} URL(s) will be carried over to the next run.`)
  return {
    list: take.map((e) => e.loc),
    notes,
    afterSuccess: () => saveState(siteKey, channel, { lastRun: startedAt, pending: rest.map((e) => e.loc) }),
  }
}

// Removals must echo back the exact object Bing returned (with __type + WCF dates).
async function findRaw(method, params, match, what) {
  const rows = (await get(method, params)) ?? []
  const hit = rows.find(match)
  if (!hit) throw new Error(`No ${what} found. Current: ${JSON.stringify(clean(rows))}`)
  return hit
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

// ── IndexNow ──────────────────────────────────────────────────────────
const INDEXNOW_ERRORS = {
  400: 'bad request (invalid format)',
  403: 'key not valid — is the key file hosted at keyLocation (default https://<host>/<key>.txt) and does it contain exactly the key?',
  422: 'URLs don\'t belong to the host, or the key doesn\'t match the protocol',
  429: 'too many requests — slow down',
}

async function indexNowPost(body) {
  const res = await fetch(INDEXNOW_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) })
  if (res.status !== 200 && res.status !== 202) {
    const text = await res.text().catch(() => '')
    throw new Error(`IndexNow: HTTP ${res.status} ${INDEXNOW_ERRORS[res.status] ?? text.slice(0, 200)}`)
  }
  return { status: res.status, accepted: body.urlList.length, note: res.status === 202 ? 'Accepted; key validation pending' : 'OK' }
}

// ── command parameters (used for MCP input schemas) ───────────────────
// args: positionals in order ({ name, desc, optional?, rest?, enum? })
// opts: keys of OPTS; prop = schema property name, flag = CLI flag name
const OPTS = {
  page: { schema: { type: 'integer', minimum: 0, description: 'Result page (0-based)' } },
  country: { schema: { type: 'string', description: 'Market country code (default us)' } },
  lang: { schema: { type: 'string', description: 'Language (default en-US)' } },
  from: { schema: { type: 'string', description: 'Start date YYYY-MM-DD (default ~6 months ago)' } },
  to: { schema: { type: 'string', description: 'End date YYYY-MM-DD (default today)' } },
  crawled: { schema: { type: 'string', enum: ['any', 'week', '2weeks', '3weeks'], description: 'Last crawled within' } },
  discovered: { schema: { type: 'string', enum: ['any', 'week', 'month'], description: 'Discovered within' } },
  http: { schema: { type: 'string', enum: ['any', '2xx', '3xx', '301', '302', '4xx', '5xx', 'other'], description: 'HTTP status filter' } },
  'all-subdomains': { schema: { type: 'boolean', description: 'Include roles on all subdomains' } },
  role: { required: true, schema: { type: 'string', enum: ['admin', 'readwrite', 'readonly'], description: 'Access level' } },
  sitemap: { schema: { type: 'string', description: 'Take URLs from this sitemap; "auto" = <site>/sitemap.xml. Sitemap indexes are followed.' } },
  changed: { schema: { type: 'boolean', description: 'With sitemap: only URLs whose <lastmod> is newer than the last successful run' } },
  'key-location': { schema: { type: 'string', description: 'Full URL of the hosted key file if not https://<host>/<key>.txt' } },
  scope: { schema: { type: 'string', enum: ['domain', 'host', 'directory'], description: 'Move scope (default domain)' } },
  'move-type': { flag: 'type', prop: 'type', schema: { type: 'string', enum: ['local', 'global'], description: 'Move type (default global)' } },
  rate: { schema: { type: 'integer', minimum: 1, maximum: 10, description: 'Same crawl rate (1-10) for every hour' } },
  hours: { schema: { type: 'string', description: '24 comma-separated crawl rates (1-10), one per hour' } },
  boost: { schema: { type: 'string', enum: ['on', 'off'], description: 'Crawl boost' } },
  directory: { schema: { type: 'boolean', description: 'Block the whole directory' } },
  'cache-only': { schema: { type: 'boolean', description: 'Only remove the cached copy, keep the result' } },
  reason: { required: true, schema: { type: 'integer', description: 'BlockReason number (undocumented by Bing)' } },
  'geo-type': { flag: 'type', prop: 'type', schema: { type: 'string', enum: ['page', 'directory', 'domain', 'subdomain'], description: 'What the URL represents (default domain)' } },
}

const URL_ARG = { name: 'url', desc: 'Full URL' }
const SITEMAP_ARG = { name: 'sitemapUrl', desc: 'Sitemap or feed URL' }
const PHRASE_ARG = { name: 'phrase', desc: 'Keyword phrase' }
const QUERY_ARG = { name: 'query', desc: 'Search query' }
const PAGE_URL_ARG = { name: 'pageUrl', desc: 'Page URL' }

// ── commands ──────────────────────────────────────────────────────────
// risk: 'read' | 'write' | 'danger'. Writes return a plan
// { method, body, endpoint?, preview?, notes?, send?, afterSuccess? };
// main() prints it as a dry run or sends it with --yes.
// site: false = command never uses a site; 'optional' = only for defaults.
export const COMMANDS = {
  // Overview
  summary: { risk: 'read', group: 'Overview', usage: 'summary', desc: 'Health check across all main reports', run: () => summary() },
  sites: { risk: 'read', site: false, group: 'Overview', usage: 'sites', desc: 'Sites on the account + verification', run: async () => clean(await get('GetUserSites')).map(({ Url, IsVerified }) => ({ Url, IsVerified })) },

  // Search performance
  traffic: { risk: 'read', group: 'Search performance', usage: 'traffic', desc: 'Daily clicks / impressions', run: async () => byDateDesc(clean(await get('GetRankAndTrafficStats', site()))) },
  queries: { risk: 'read', group: 'Search performance', usage: 'queries', desc: 'Top search queries', run: async () => aggregate(clean(await get('GetQueryStats', site())), 'Query') },
  pages: { risk: 'read', group: 'Search performance', usage: 'pages', desc: 'Top pages', run: async () => aggregate(clean(await get('GetPageStats', site())), 'Query', 'Page') },
  'query-pages': { risk: 'read', args: [QUERY_ARG], group: 'Search performance', usage: 'query-pages <query>', desc: 'Pages ranking for one query', run: async (a) => aggregate(clean(await get('GetQueryPageStats', { ...site(), query: need(a.join(' '), 'query-pages <query>') })), 'Query', 'Page') },
  'page-queries': { risk: 'read', args: [PAGE_URL_ARG], group: 'Search performance', usage: 'page-queries <pageUrl>', desc: 'Queries a page ranks for', run: async ([p]) => aggregate(clean(await get('GetPageQueryStats', { ...site(), page: need(p, 'page-queries <pageUrl>') })), 'Query') },
  'query-page-detail': { risk: 'read', args: [QUERY_ARG, PAGE_URL_ARG], group: 'Search performance', usage: 'query-page-detail <query> <pageUrl>', desc: 'Daily stats for one query on one page', run: async ([q, p]) => byDateDesc(clean(await get('GetQueryPageDetailStats', { ...site(), query: need(q, 'query-page-detail <query> <pageUrl>'), page: need(p, 'query-page-detail <query> <pageUrl>') }))) },
  'query-traffic': { risk: 'read', args: [QUERY_ARG], group: 'Search performance', usage: 'query-traffic <query>', desc: 'Daily traffic for one query', run: async (a) => byDateDesc(clean(await get('GetQueryTrafficStats', { ...site(), query: need(a.join(' '), 'query-traffic <query>') }))) },

  // Keyword research
  keyword: { risk: 'read', site: false, args: [PHRASE_ARG], opts: ['country', 'lang', 'from', 'to'], group: 'Keyword research', usage: 'keyword <phrase> [--country us] [--lang en-US] [--from YYYY-MM-DD] [--to YYYY-MM-DD]', desc: 'Bing search impressions for a phrase over a period', run: async (a) => clean(await get('GetKeyword', keywordParams(need(a.join(' '), 'keyword <phrase>')))) },
  'keyword-stats': { risk: 'read', site: false, args: [PHRASE_ARG], opts: ['country', 'lang'], group: 'Keyword research', usage: 'keyword-stats <phrase> [--country us] [--lang en-US]', desc: 'Weekly impression history for a phrase', run: async (a) => { const { startDate, endDate, ...p } = keywordParams(need(a.join(' '), 'keyword-stats <phrase>')); return byDateDesc(clean(await get('GetKeywordStats', p))) } },
  'related-keywords': { risk: 'read', site: false, args: [PHRASE_ARG], opts: ['country', 'lang', 'from', 'to'], group: 'Keyword research', usage: 'related-keywords <phrase> [--country us] [--lang en-US] [--from] [--to]', desc: 'Related phrases with impressions', run: async (a) => clean(await get('GetRelatedKeywords', keywordParams(need(a.join(' '), 'related-keywords <phrase>')))).sort((a, b) => b.Impressions - a.Impressions) },

  // Index & crawl
  crawl: { risk: 'read', group: 'Index & crawl', usage: 'crawl', desc: 'Daily crawl stats', run: async () => byDateDesc(clean(await get('GetCrawlStats', site()))) },
  issues: { risk: 'read', group: 'Index & crawl', usage: 'issues', desc: 'Crawl issues by URL', run: async () => clean(await get('GetCrawlIssues', site())).map((r) => ({ ...r, Issues: issueNames(r.Issues) })) },
  url: { risk: 'read', args: [URL_ARG], group: 'Index & crawl', usage: 'url <url>', desc: 'Index info for one URL', run: async ([u]) => clean(await get('GetUrlInfo', { ...site(), url: need(u, 'url <url>') })) },
  'url-traffic': { risk: 'read', args: [URL_ARG], group: 'Index & crawl', usage: 'url-traffic <url>', desc: 'Clicks / impressions for one URL', run: async ([u]) => clean(await get('GetUrlTrafficInfo', { ...site(), url: need(u, 'url-traffic <url>') })) },
  children: {
    risk: 'read', args: [{ name: 'url', desc: 'Directory URL, or domain:host' }], opts: ['page', 'crawled', 'discovered', 'http'],
    group: 'Index & crawl', usage: 'children <url|domain:host> [--page n] [--crawled any|week|2weeks|3weeks] [--discovered any|week|month] [--http any|2xx|3xx|301|302|4xx|5xx|other]',
    desc: 'Index info for URLs under a directory',
    run: async ([u]) => clean(await post('GetChildrenUrlInfo', {
      ...site(), url: need(u, 'children <url>'), page: page(),
      filterProperties: {
        __type: `FilterProperties:#${NS}`,
        CrawlDateFilter: pick(flags.crawled ?? 'any', { any: 0, week: 1, '2weeks': 2, '3weeks': 4 }, '--crawled'),
        DiscoveredDateFilter: pick(flags.discovered ?? 'any', { any: 0, week: 1, month: 2 }, '--discovered'),
        DocFlagsFilters: 0,
        HttpCodeFilters: pick(flags.http ?? 'any', { any: 0, '2xx': 1, '3xx': 2, 301: 4, 302: 8, '4xx': 16, '5xx': 32, other: 64 }, '--http'),
      },
    })),
  },
  'children-traffic': { risk: 'read', args: [{ name: 'url', desc: 'Directory URL' }], opts: ['page'], group: 'Index & crawl', usage: 'children-traffic <url> [--page n]', desc: 'Traffic for URLs under a directory', run: async ([u]) => clean(await get('GetChildrenUrlTrafficInfo', { ...site(), url: need(u, 'children-traffic <url>'), page: page() })) },
  'crawl-settings': { risk: 'read', group: 'Index & crawl', usage: 'crawl-settings', desc: 'Hourly crawl rate + crawl boost', run: async () => clean(await get('GetCrawlSettings', site())) },
  fetched: { risk: 'read', group: 'Index & crawl', usage: 'fetched', desc: 'URLs fetched with "fetch" (Fetch as Bingbot)', run: async () => clean(await get('GetFetchedUrls', site())) },
  'fetched-details': { risk: 'read', args: [URL_ARG], group: 'Index & crawl', usage: 'fetched-details <url>', desc: 'Result of a Fetch as Bingbot', run: async ([u]) => clean(await get('GetFetchedUrlDetails', { ...site(), url: need(u, 'fetched-details <url>') })) },

  // Sitemaps & submission
  sitemaps: { risk: 'read', group: 'Sitemaps & submission', usage: 'sitemaps', desc: 'Submitted sitemaps / feeds', run: async () => clean(await get('GetFeeds', site())).map(({ Url, Status, UrlCount, LastCrawled, Submitted }) => ({ Url, Status, UrlCount, LastCrawled, Submitted })) },
  'sitemap-details': { risk: 'read', args: [SITEMAP_ARG], group: 'Sitemaps & submission', usage: 'sitemap-details <sitemapUrl>', desc: 'Child sitemaps of a sitemap index', run: async ([f]) => clean(await get('GetFeedDetails', { ...site(), feedUrl: need(f, 'sitemap-details <sitemapUrl>') })) },
  quota: { risk: 'read', group: 'Sitemaps & submission', usage: 'quota', desc: 'URL + content submission quota left', run: async () => ({ urls: clean(await get('GetUrlSubmissionQuota', site())), content: clean(await get('GetContentSubmissionQuota', site())) }) },
  submit: {
    risk: 'write', args: [{ name: 'urls', desc: 'URLs to submit (omit when using sitemap)', rest: true, optional: true }], opts: ['sitemap', 'changed'],
    group: 'Sitemaps & submission', usage: 'submit <url> [url…] | submit --sitemap [sitemapUrl] [--changed]',
    desc: 'Ask Bing to (re)crawl URLs (uses daily quota)',
    run: async (urls) => {
      let list = urls
      let notes = []
      let afterSuccess
      if (flags.sitemap !== undefined) {
        const { siteUrl } = site()
        const entries = await readSitemap(sitemapFlag())
        const { DailyQuota, MonthlyQuota } = await get('GetUrlSubmissionQuota', site())
        const cap = Math.min(DailyQuota, MonthlyQuota ?? Infinity)
        if (cap <= 0) throw new Error('No URL submission quota left (check with "quota"). Try again tomorrow, or use "indexnow".')
        if (flags.changed) {
          ;({ list, notes, afterSuccess } = selectChanged(siteUrl, 'submit', entries, cap))
          if (!list.length) return `Nothing to submit — ${notes.join(' ')}`
        } else {
          list = entries.map((e) => e.loc)
          if (list.length > cap) {
            notes.push(`Sitemap has ${list.length} URLs, quota left is ${cap} — submitting the first ${cap}.`)
            list = list.slice(0, cap)
          }
        }
      } else if (flags.changed) {
        throw new Error('--changed only works with --sitemap')
      }
      need(list[0], 'submit <url> [url…]')
      const { siteUrl } = site()
      if (list.length === 1) return { method: 'SubmitUrl', body: { siteUrl, url: list[0] }, notes, afterSuccess }
      const batches = chunk(list, SUBMIT_BATCH_MAX)
      if (batches.length > 1) notes.push(`${list.length} URLs will be sent as ${batches.length} SubmitUrlBatch requests of up to ${SUBMIT_BATCH_MAX}.`)
      return {
        method: 'SubmitUrlBatch', body: { siteUrl, urlList: list }, notes, afterSuccess,
        send: batches.length > 1 ? async () => { for (const b of batches) await post('SubmitUrlBatch', { siteUrl, urlList: b }); return { submitted: list.length } } : undefined,
      }
    },
  },
  'submit-content': {
    risk: 'write', args: [URL_ARG], group: 'Sitemaps & submission', usage: 'submit-content <url>',
    desc: 'Push a page\'s live HTML straight to Bing (uses content quota)',
    run: async ([u]) => {
      const url = need(u, 'submit-content <url>')
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status !== 200) throw new Error(`${url} returned HTTP ${res.status}; submit the final URL instead`)
      const html = await res.text()
      const head = [`HTTP/1.1 200 OK`, `Date: ${new Date().toUTCString()}`, `Content-Type: ${res.headers.get('content-type') ?? 'text/html; charset=utf-8'}`, `Content-Length: ${Buffer.byteLength(html)}`]
      const httpMessage = Buffer.from(`${head.join('\r\n')}\r\n\r\n${html}`).toString('base64')
      return { method: 'SubmitContent', body: { ...site(), url, httpMessage, structuredData: '', dynamicServing: 0 }, preview: `${html.length} chars of HTML from ${url}` }
    },
  },
  'add-sitemap': { risk: 'write', args: [SITEMAP_ARG], group: 'Sitemaps & submission', usage: 'add-sitemap <sitemapUrl>', desc: 'Submit (or resubmit) a sitemap', run: async ([f]) => ({ method: 'SubmitFeed', body: { ...site(), feedUrl: need(f, 'add-sitemap <sitemapUrl>') } }) },
  'remove-sitemap': { risk: 'danger', args: [SITEMAP_ARG], group: 'Sitemaps & submission', usage: 'remove-sitemap <sitemapUrl> --site <site>', desc: 'Remove a sitemap', run: async ([f]) => ({ method: 'RemoveFeed', body: { ...site(), feedUrl: need(f, 'remove-sitemap <sitemapUrl>') } }) },
  fetch: { risk: 'write', args: [URL_ARG], group: 'Sitemaps & submission', usage: 'fetch <url>', desc: 'Fetch as Bingbot (see results with "fetched")', run: async ([u]) => ({ method: 'FetchUrl', body: { ...site(), url: need(u, 'fetch <url>') } }) },

  // IndexNow
  'indexnow-key': {
    risk: 'read', site: 'optional', group: 'IndexNow', usage: 'indexnow-key [--out <dir>]',
    desc: 'Generate an IndexNow key and the key file to host at /<key>.txt',
    run: async () => {
      const key = randomBytes(16).toString('hex')
      const out = { key, keyFile: `${key}.txt`, keyFileContents: key, hostAt: SITE ? new URL(`${key}.txt`, SITE).href : `https://<your-site>/${key}.txt`, env: `INDEXNOW_KEY=${key}` }
      if (typeof flags.out === 'string') {
        writeFileSync(join(flags.out, `${key}.txt`), key)
        out.written = join(flags.out, `${key}.txt`)
      }
      return out
    },
  },
  indexnow: {
    risk: 'write', site: 'optional', args: [{ name: 'urls', desc: 'URLs to notify (one host; omit when using sitemap)', rest: true, optional: true }], opts: ['sitemap', 'changed', 'key-location'],
    group: 'IndexNow', usage: 'indexnow <url…> | indexnow --sitemap [sitemapUrl] [--changed] [--key-location <url>]',
    desc: 'Notify IndexNow engines (Bing, Yandex, Seznam…) of new/changed URLs',
    run: async (urls) => {
      const key = process.env.INDEXNOW_KEY
      if (!key) throw new Error('Missing INDEXNOW_KEY. Run "bing-webmaster indexnow-key", host the key file, then set INDEXNOW_KEY in your environment or .env.')
      if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) throw new Error('INDEXNOW_KEY must be 8-128 characters of a-z, A-Z, 0-9 or "-"')
      let list = urls
      let notes = []
      let afterSuccess
      if (flags.sitemap !== undefined) {
        const sm = sitemapFlag()
        const entries = await readSitemap(sm)
        if (flags.changed) {
          ;({ list, notes, afterSuccess } = selectChanged(SITE ?? new URL('/', sm).href, 'indexnow', entries, Infinity))
          if (!list.length) return `Nothing to notify — ${notes.join(' ')}`
        } else list = entries.map((e) => e.loc)
      } else if (flags.changed) {
        throw new Error('--changed only works with --sitemap')
      }
      need(list[0], 'indexnow <url…>')
      const hosts = new Set(list.map((u) => {
        try {
          return new URL(u).host
        } catch {
          throw new Error(`Not a valid URL: ${u}`)
        }
      }))
      if (hosts.size > 1) throw new Error(`IndexNow needs one host per request; got ${[...hosts].join(', ')}`)
      const [host] = hosts
      const keyLocation = typeof flags['key-location'] === 'string' ? flags['key-location'] : process.env.INDEXNOW_KEY_LOCATION
      const body = { host, key, ...(keyLocation ? { keyLocation } : {}), urlList: list }
      const batches = chunk(list, INDEXNOW_BATCH_MAX)
      if (batches.length > 1) notes.push(`${list.length} URLs will be sent as ${batches.length} requests of up to ${INDEXNOW_BATCH_MAX}.`)
      return {
        method: 'IndexNow', endpoint: INDEXNOW_ENDPOINT, body, notes, afterSuccess,
        send: async () => {
          const results = []
          for (const b of batches) results.push(await indexNowPost({ ...body, urlList: b }))
          return results.length === 1 ? results[0] : results
        },
      }
    },
  },

  // Links
  links: { risk: 'read', opts: ['page'], group: 'Links', usage: 'links [--page n]', desc: 'Pages with inbound links + counts', run: async () => clean(await get('GetLinkCounts', { ...site(), page: page() })).Links },
  'url-links': { risk: 'read', args: [URL_ARG], opts: ['page'], group: 'Links', usage: 'url-links <url> [--page n]', desc: 'Inbound links to one URL', run: async ([u]) => clean(await get('GetUrlLinks', { ...site(), link: need(u, 'url-links <url>'), page: page() })).Details },
  connected: { risk: 'read', group: 'Links', usage: 'connected', desc: 'Connected pages (social profiles etc. that link to you)', run: async () => clean(await get('GetConnectedPages', site())) },
  'add-connected': { risk: 'write', args: [PAGE_URL_ARG], group: 'Links', usage: 'add-connected <pageUrl>', desc: 'Add a connected page (e.g. Instagram profile)', run: async ([u]) => ({ method: 'AddConnectedPage', body: { ...site(), masterUrl: need(u, 'add-connected <pageUrl>') } }) },

  // Sites & users
  'add-site': { risk: 'write', site: false, args: [{ name: 'siteUrl', desc: 'Site to add, e.g. https://example.com/' }], group: 'Sites & users', usage: 'add-site <siteUrl>', desc: 'Add a site to the account', run: async ([s]) => ({ method: 'AddSite', body: { siteUrl: normaliseSite(need(s, 'add-site <siteUrl>')) } }) },
  'verify-site': { risk: 'write', group: 'Sites & users', usage: 'verify-site [--site <site>]', desc: 'Re-run ownership verification', run: async () => ({ method: 'VerifySite', body: site() }) },
  'remove-site': { risk: 'danger', site: false, explicitSite: true, args: [{ name: 'siteUrl', desc: 'Site to remove, exactly as listed by sites' }], group: 'Sites & users', usage: 'remove-site <siteUrl>', desc: 'Remove a site from the account (loses its history)', run: async ([s]) => ({ method: 'RemoveSite', body: { siteUrl: normaliseSite(need(s, 'remove-site <siteUrl>')) } }) },
  roles: {
    risk: 'read', opts: ['all-subdomains'], group: 'Sites & users', usage: 'roles [--all-subdomains]', desc: 'Who has access to the site',
    run: async () => clean(await get('GetSiteRoles', { ...site(), includeAllSubdomains: String(!!flags['all-subdomains']) }))
      .map(({ Email, Role, Site, DelegatorEmail, Expired, Date }) => ({ Email, Role: ROLE_NAMES[Role] ?? Role, Site, DelegatedBy: DelegatorEmail, Expired, Date })),
  },
  'add-user': {
    risk: 'danger', args: [{ name: 'email', desc: 'Email of the Microsoft account to add' }], opts: ['role'],
    group: 'Sites & users', usage: 'add-user <email> --role admin|readwrite|readonly --site <site>', desc: 'Give someone access to the site',
    run: async ([email]) => {
      const role = pick(flags.role, { admin: 'admin', readwrite: 'readwrite', readonly: 'readonly' }, '--role')
      const { siteUrl } = site()
      const siteRow = (await get('GetUserSites')).find((s) => normaliseSite(s.Url) === siteUrl)
      if (!siteRow) throw new Error(`${siteUrl} is not on this account`)
      return {
        method: 'AddSiteRoles',
        body: { siteUrl, delegatedUrl: siteUrl, userEmail: need(email, 'add-user <email> --role …'), authenticationCode: siteRow.AuthenticationCode, isAdministrator: role === 'admin', isReadOnly: role === 'readonly' },
      }
    },
  },
  'remove-user': {
    risk: 'danger', args: [{ name: 'email', desc: 'Email of the user to remove' }],
    group: 'Sites & users', usage: 'remove-user <email> --site <site>', desc: 'Revoke someone\'s access',
    run: async ([email]) => {
      need(email, 'remove-user <email>')
      const siteRole = await findRaw('GetSiteRoles', { ...site(), includeAllSubdomains: 'true' }, (r) => r.Email?.toLowerCase() === email.toLowerCase(), `role for ${email}`)
      const admins = (await get('GetSiteRoles', { ...site(), includeAllSubdomains: 'true' })).filter((r) => r.Role === 0 && !r.Expired)
      if (siteRole.Role === 0 && admins.length <= 1) throw new Error(`${email} is the only Administrator — add another admin before removing them`)
      return { method: 'RemoveSiteRole', body: { ...site(), siteRole } }
    },
  },
  'site-moves': { risk: 'read', group: 'Sites & users', usage: 'site-moves', desc: 'Registered site moves (Bing returns 404 — endpoint retired)', run: async () => clean(await get('GetSiteMoves', site())) },
  'site-move': {
    risk: 'danger', args: [{ name: 'fromUrl', desc: 'Old URL' }, { name: 'toUrl', desc: 'New URL' }], opts: ['scope', 'move-type'],
    group: 'Sites & users', usage: 'site-move <fromUrl> <toUrl> --site <fromSite> [--scope domain|host|directory] [--type local|global]',
    desc: 'Tell Bing a site moved (Bing returns 404 — retired; use the dashboard Site Move tool)',
    run: async ([from, to]) => ({
      method: 'SubmitSiteMove',
      body: {
        ...site(),
        settings: {
          __type: `SiteMoveSettings:#${NS}`, Date: wcfDate(),
          MoveScope: pick(flags.scope ?? 'domain', { domain: 0, host: 1, directory: 2 }, '--scope'),
          MoveType: pick(flags.type ?? 'global', { local: 0, global: 1 }, '--type'),
          SourceUrl: need(from, 'site-move <fromUrl> <toUrl>'), TargetUrl: need(to, 'site-move <fromUrl> <toUrl>'),
        },
      },
    }),
  },

  // Configuration
  'crawl-rate': {
    risk: 'danger', opts: ['rate', 'hours', 'boost'], group: 'Configuration', usage: 'crawl-rate --site <site> [--rate 1-10 | --hours h0,…,h23] [--boost on|off]',
    desc: 'Change hourly crawl rate / crawl boost (read-modify-write)',
    run: async () => {
      const current = await get('GetCrawlSettings', site())
      const next = { ...current }
      if (flags.rate !== undefined) next.CrawlRate = Array(24).fill(Number(flags.rate))
      if (flags.hours !== undefined) next.CrawlRate = String(flags.hours).split(',').map(Number)
      if (next.CrawlRate.length !== 24 || next.CrawlRate.some((n) => !Number.isInteger(n) || n < 1 || n > 10)) throw new Error('Crawl rate needs 24 integers between 1 and 10')
      if (flags.boost !== undefined) next.CrawlBoostEnabled = pick(flags.boost, { on: true, off: false }, '--boost')
      return { method: 'SaveCrawlSettings', body: { ...site(), crawlSettings: next }, preview: { before: clean(current), after: clean(next) } }
    },
  },
  blocked: { risk: 'read', group: 'Configuration', usage: 'blocked', desc: 'URLs/directories blocked from Bing results', run: async () => clean(await get('GetBlockedUrls', site())) },
  block: {
    risk: 'danger', args: [URL_ARG], opts: ['directory', 'cache-only'], group: 'Configuration', usage: 'block <url> --site <site> [--directory] [--cache-only]',
    desc: 'Remove a URL/directory from Bing results',
    run: async ([u]) => ({
      method: 'AddBlockedUrl',
      body: { ...site(), blockedUrl: { __type: `BlockedUrl:#${NS}`, Date: wcfDate(), EntityType: flags.directory ? 1 : 0, RequestType: flags['cache-only'] ? 0 : 1, Url: need(u, 'block <url>') } },
    }),
  },
  unblock: {
    risk: 'danger', args: [URL_ARG], group: 'Configuration', usage: 'unblock <url> --site <site>', desc: 'Undo a block',
    run: async ([u]) => ({ method: 'RemoveBlockedUrl', body: { ...site(), blockedUrl: await findRaw('GetBlockedUrls', site(), (r) => r.Url === need(u, 'unblock <url>'), `block for ${u}`) } }),
  },
  'preview-blocks': { risk: 'read', group: 'Configuration', usage: 'preview-blocks', desc: 'Pages with search-result previews blocked', run: async () => clean(await get('GetActivePagePreviewBlocks', site())) },
  'preview-block': { risk: 'danger', args: [URL_ARG], opts: ['reason'], group: 'Configuration', usage: 'preview-block <url> --reason <n> --site <site>', desc: 'Block a page\'s rich preview (BlockReason values undocumented)', run: async ([u]) => ({ method: 'AddPagePreviewBlock', body: { ...site(), url: need(u, 'preview-block <url>'), reason: Number(need(flags.reason, 'preview-block <url> --reason <n>')) } }) },
  'preview-unblock': { risk: 'danger', args: [URL_ARG], group: 'Configuration', usage: 'preview-unblock <url> --site <site>', desc: 'Remove a preview block', run: async ([u]) => ({ method: 'RemovePagePreviewBlock', body: { ...site(), url: need(u, 'preview-unblock <url>') } }) },
  params: { risk: 'read', group: 'Configuration', usage: 'params', desc: 'URL parameters Bing ignores (normalisation)', run: async () => clean(await get('GetQueryParameters', site())) },
  'add-param': { risk: 'danger', args: [{ name: 'name', desc: 'URL parameter name, e.g. utm_source' }], group: 'Configuration', usage: 'add-param <name> --site <site>', desc: 'Tell Bing to ignore a URL parameter (e.g. utm_source)', run: async ([p]) => ({ method: 'AddQueryParameter', body: { ...site(), queryParameter: need(p, 'add-param <name>') } }) },
  'remove-param': { risk: 'danger', args: [{ name: 'name', desc: 'URL parameter name' }], group: 'Configuration', usage: 'remove-param <name> --site <site>', desc: 'Remove an ignored URL parameter', run: async ([p]) => ({ method: 'RemoveQueryParameter', body: { ...site(), queryParameter: need(p, 'remove-param <name>') } }) },
  'toggle-param': { risk: 'danger', args: [{ name: 'name', desc: 'URL parameter name' }, { name: 'state', desc: 'Enable or disable', enum: ['on', 'off'] }], group: 'Configuration', usage: 'toggle-param <name> on|off --site <site>', desc: 'Enable/disable an ignored URL parameter', run: async ([p, state]) => ({ method: 'EnableDisableQueryParameter', body: { ...site(), queryParameter: need(p, 'toggle-param <name> on|off'), isEnabled: pick(state, { on: true, off: false }, 'state') } }) },
  geo: { risk: 'read', group: 'Configuration', usage: 'geo', desc: 'Country/region targeting', run: async () => clean(await get('GetCountryRegionSettings', site())) },
  'add-geo': {
    risk: 'danger', args: [URL_ARG, { name: 'countryCode', desc: 'Two-letter country code, e.g. CA' }], opts: ['geo-type'],
    group: 'Configuration', usage: 'add-geo <url> <CC> --site <site> [--type page|directory|domain|subdomain]',
    desc: 'Target a URL/section at a country (e.g. CA)',
    run: async ([u, cc]) => ({
      method: 'AddCountryRegionSettings',
      body: { ...site(), settings: { __type: `CountryRegionSettings:#${NS}`, Date: wcfDate(), TwoLetterIsoCountryCode: need(cc, 'add-geo <url> <CC>').toUpperCase(), Type: pick(flags.type ?? 'domain', { page: 0, directory: 1, domain: 2, subdomain: 3 }, '--type'), Url: need(u, 'add-geo <url> <CC>') } },
    }),
  },
  'remove-geo': {
    risk: 'danger', args: [URL_ARG], group: 'Configuration', usage: 'remove-geo <url> --site <site>', desc: 'Remove country targeting',
    run: async ([u]) => ({ method: 'RemoveCountryRegionSettings', body: { ...site(), settings: await findRaw('GetCountryRegionSettings', site(), (r) => r.Url === need(u, 'remove-geo <url>'), `geo setting for ${u}`) } }),
  },

  // Escape hatch
  call: {
    risk: 'dynamic', site: 'optional', group: 'Advanced', usage: 'call <Method> [key=value …] [--body \'{json}\'] [--post]',
    desc: 'Call any API method directly (Get* = read; anything else is danger)',
    mcpSchema: {
      method: { type: 'string', description: 'API method name, e.g. GetUrlInfo' },
      params: { type: 'object', description: 'Query parameters (siteUrl added automatically)', additionalProperties: true },
      body: { type: 'object', description: 'JSON body for POST methods', additionalProperties: true },
      post: { type: 'boolean', description: 'Force POST for a Get* method' },
    },
    mcpRequired: ['method'],
    toCli: ({ method, params = {}, body, post: usePost }) => ({
      args: [method, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)],
      flags: { ...(body ? { body: JSON.stringify(body) } : {}), ...(usePost ? { post: true } : {}) },
    }),
    run: async ([method, ...kv]) => {
      need(method, 'call <Method> …')
      const params = Object.fromEntries(kv.map((p) => p.split(/=(.*)/s).slice(0, 2)))
      if (!('siteUrl' in params) && method !== 'GetUserSites' && !/Keyword/.test(method) && SITE) params.siteUrl = SITE
      const typed = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v]))
      if (flags.body || flags.post || !/^Get/.test(method)) return { method, body: { ...typed, ...(flags.body ? JSON.parse(flags.body) : {}) } }
      return clean(await get(method, params))
    },
  },
}

// ── summary ───────────────────────────────────────────────────────────
async function summary() {
  site()
  const names = ['sites', 'traffic', 'queries', 'pages', 'crawl', 'issues', 'sitemaps', 'quota', 'links']
  const results = Object.fromEntries(await Promise.all(names.map(async (n) => {
    try {
      return [n, { data: await COMMANDS[n].run([]) }]
    } catch (e) {
      return [n, { error: e.message }]
    }
  })))
  if (flags.json || flags.raw) return results

  const ok = (r) => (r.error ? `❌ ${r.error}` : null)
  const traffic = results.traffic.data ?? []
  const totals = traffic.reduce((t, r) => ({ c: t.c + (r.Clicks ?? 0), i: t.i + (r.Impressions ?? 0) }), { c: 0, i: 0 })
  const latestCrawl = (results.crawl.data ?? [])[0]
  const q = results.quota.data?.urls

  console.log(`Bing Webmaster — ${SITE}`)
  print('Sites on account', ok(results.sites) ?? results.sites.data)
  console.log(`\n▸ Search traffic (${dateRange(traffic)})`)
  console.log(ok(results.traffic) ?? `  ${totals.c} clicks · ${totals.i} impressions`)
  print('Top queries', ok(results.queries) ?? results.queries.data.slice(0, 10))
  print('Top pages', ok(results.pages) ?? results.pages.data.slice(0, 10))
  console.log('\n▸ Crawl (latest day)')
  console.log(ok(results.crawl) ?? (latestCrawl ? `  ${JSON.stringify(latestCrawl)}` : '  (no data)'))
  console.log(`\n▸ Crawl issues: ${ok(results.issues) ?? `${results.issues.data.length} URL(s)`}`)
  print('Sitemaps', ok(results.sitemaps) ?? results.sitemaps.data)
  console.log(`\n▸ Inbound links: ${ok(results.links) ?? `${results.links.data.length} page(s) with links`}`)
  console.log(`▸ Submission quota: ${ok(results.quota) ?? `${q.DailyQuota}/day · ${q.MonthlyQuota}/month remaining`}`)

  if (Object.values(results).some((r) => r.error)) process.exitCode = 1
  return undefined
}

// ── execution core (shared by the CLI and MCP) ────────────────────────
const isPlan = (r) => r && typeof r === 'object' && typeof r.method === 'string' && 'body' in r

// Returns { kind: 'data', data } | { kind: 'plan', risk, plan } | { kind: 'sent', risk, plan, response }
export async function execute(name, args = [], f = {}) {
  setContext(f)
  const cmd = COMMANDS[name]
  if (!cmd) throw new Error(`Unknown command "${name}". Run: bing-webmaster help`)
  const result = await cmd.run(args)
  if (!isPlan(result)) return { kind: 'data', data: result }

  const risk = cmd.risk === 'dynamic' ? (/^Get/.test(result.method) ? 'read' : 'danger') : cmd.risk
  if (risk === 'danger' && !cmd.explicitSite && !f.site) {
    throw new Error(`"${name}" changes Bing settings — pass --site explicitly (e.g. --site ${SITE ?? 'https://example.com/'}) to confirm which site.`)
  }
  if (risk === 'read') {
    const response = await post(result.method, result.body)
    return { kind: 'data', data: f.raw ? response : clean(response), title: result.method }
  }
  if (!f.yes) return { kind: 'plan', risk, plan: result }
  return { kind: 'sent', risk, plan: result, response: await send(result) }
}

export async function send(plan) {
  const response = plan.send ? await plan.send() : await post(plan.method, plan.body)
  await plan.afterSuccess?.(response)
  return response
}

// ── output ────────────────────────────────────────────────────────────
function print(title, data) {
  if (title) console.log(`\n▸ ${title}`)
  if (data === null || data === undefined) return console.log('  (done — no data returned)')
  if (typeof data !== 'object') return console.log(`  ${data}`)
  if (Array.isArray(data)) {
    if (!data.length) return console.log('  (no data)')
    console.table(data.slice(0, LIMIT))
    if (data.length > LIMIT) console.log(`  … ${data.length - LIMIT} more (use --limit)`)
    return
  }
  const flat = Object.values(data).every((v) => v === null || typeof v !== 'object')
  if (flat) console.table(data)
  else console.dir(data, { depth: 4 })
}

// RFC 4180 quoting; header = union of keys across rows; nested values as JSON.
export function toCsv(rows) {
  const objects = rows.map((r) => (r && typeof r === 'object' ? r : { value: r }))
  const cols = [...new Set(objects.flatMap((r) => Object.keys(r)))]
  const cell = (v) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return [cols.map(cell).join(','), ...objects.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')
}

function csvRows(data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && Object.values(data).every((v) => v === null || typeof v !== 'object')) return [data]
  throw new Error('--csv needs a table result; this command returns nested data — use --json instead')
}

function help() {
  const groups = {}
  for (const [name, c] of Object.entries(COMMANDS)) (groups[c.group] ??= []).push([name, c])
  const mark = { read: '   ', write: ' ✎ ', danger: ' ⚠ ', dynamic: ' ? ' }
  console.log(`bing-webmaster ${VERSION}\n`)
  console.log('bing-webmaster <command> [args] [--site <url>] [--json|--csv] [--yes]\n')
  console.log('   = read (runs now)   ✎ = write (dry-run unless --yes)   ⚠ = danger (dry-run unless --yes, needs explicit --site)\n')
  for (const [group, cmds] of Object.entries(groups)) {
    console.log(group)
    for (const [, c] of cmds) console.log(`${mark[c.risk]}${c.usage.padEnd(58)} ${c.desc}`)
    console.log()
  }
  console.log('AI assistants')
  console.log(`   ${'mcp [--read-only]'.padEnd(58)} Run as an MCP server on stdio (writes need a confirm_token)`)
}

// Shorten long base64 payloads in dry-run output.
const redactLong = (body) => JSON.parse(JSON.stringify(body, (k, v) => {
  if (k === 'authenticationCode' && v) return `${String(v).slice(0, 4)}…`
  return typeof v === 'string' && v.length > 300 ? `${v.slice(0, 60)}… (${v.length} chars)` : v
}))

const planTarget = (plan) => plan.endpoint ?? `${API}${plan.method}`

function render(command, out, f) {
  if (out.kind === 'data') {
    const { data } = out
    if (data === undefined && command === 'summary') return
    if (f.csv) {
      const rows = csvRows(data)
      return console.log(toCsv(f.limit ? rows.slice(0, LIMIT) : rows))
    }
    if (f.raw || f.json) return console.log(JSON.stringify(data, null, 2))
    return print(out.title ?? (SITE ? `${command} — ${SITE}` : command), data)
  }
  const { plan, risk } = out
  if (out.kind === 'plan') {
    console.log(`DRY RUN (${risk}) — nothing sent. Re-run with --yes to apply.\n`)
    console.log(`POST ${planTarget(plan)}`)
    console.log(JSON.stringify(redactLong(plan.body), null, 2))
    for (const n of plan.notes ?? []) console.log(`ℹ︎ ${n}`)
    if (plan.preview) console.log('\nPreview:'), console.dir(plan.preview, { depth: 4 })
    return
  }
  for (const n of plan.notes ?? []) console.log(`ℹ︎ ${n}`)
  console.log(`✅ ${plan.method} accepted${plan.endpoint ? '' : ' by Bing'}`)
  if (out.response !== null && out.response !== undefined) print('Response', clean(out.response))
}

// ── MCP server (JSON-RPC 2.0 over stdio, newline-delimited) ───────────
const MCP_PROTOCOL_LATEST = '2025-06-18'
const TOKEN_TTL_MS = 10 * 60 * 1000
const MCP_DEFAULT_LIMIT = 100
const toolName = (command) => command.replaceAll('-', '_')
const optProp = (key) => OPTS[key].prop ?? key.replaceAll('-', '_')

const MCP_INSTRUCTIONS = `Bing Webmaster Tools for one Bing account.
Read tools run immediately. Write and danger tools NEVER change anything on the first call: they return a dry-run plan and a confirm_token. Show the plan to the user, and only if they approve, call the same tool again with identical arguments plus confirm_token. Tokens are single-use and expire after 10 minutes.
Danger tools (removals, blocks, users, crawl settings) also require siteUrl explicitly. Use siteUrl exactly as the "sites" tool lists it.`

export function mcpTools({ readOnly = false } = {}) {
  const tools = []
  for (const [command, cmd] of Object.entries(COMMANDS)) {
    if (readOnly && cmd.risk !== 'read') continue
    const properties = {}
    const required = []
    if (cmd.mcpSchema) {
      Object.assign(properties, cmd.mcpSchema)
      required.push(...(cmd.mcpRequired ?? []))
    }
    for (const a of cmd.args ?? []) {
      properties[a.name] = a.rest
        ? { type: 'array', items: { type: 'string' }, description: a.desc }
        : { type: 'string', description: a.desc, ...(a.enum ? { enum: a.enum } : {}) }
      if (!a.optional) required.push(a.name)
    }
    for (const key of cmd.opts ?? []) {
      properties[optProp(key)] = OPTS[key].schema
      if (OPTS[key].required) required.push(optProp(key))
    }
    if (cmd.site !== false && !properties.siteUrl) {
      properties.siteUrl = { type: 'string', description: `Bing site entry exactly as listed by "sites"${cmd.risk === 'danger' ? ' (required for this tool)' : ' (defaults to BING_SITE_URL)'}` }
      if (cmd.risk === 'danger') required.push('siteUrl')
    }
    if (cmd.risk === 'read' || cmd.risk === 'dynamic') properties.limit = { type: 'integer', minimum: 1, description: `Max rows to return for tables (default ${MCP_DEFAULT_LIMIT})` }
    if (cmd.risk !== 'read') properties.confirm_token = { type: 'string', description: 'Token from this tool\'s dry run. Only pass it after the user approved that exact plan.' }

    const riskText = {
      read: 'Read-only.',
      write: 'WRITE: the first call only returns a dry-run plan and a confirm_token; nothing is sent until you call again with the token, after the user approves.',
      danger: 'DANGER: changes or removes Bing settings. Requires siteUrl. The first call only returns a dry-run plan and a confirm_token; nothing is sent until you call again with the token, after the user explicitly approves.',
      dynamic: 'Get* methods are read-only; any other method is treated as DANGER (dry-run plan + confirm_token, requires siteUrl).',
    }[cmd.risk]
    tools.push({
      name: toolName(command),
      title: `${cmd.desc}`,
      description: `${cmd.desc}. ${riskText} CLI equivalent: bing-webmaster ${cmd.usage}`,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
      annotations: {
        title: cmd.desc,
        readOnlyHint: cmd.risk === 'read',
        destructiveHint: cmd.risk === 'danger' || cmd.risk === 'dynamic',
        idempotentHint: cmd.risk === 'read',
        openWorldHint: true,
      },
    })
  }
  return tools
}

// Map MCP tool arguments onto CLI-style positionals + flags.
function toCliInvocation(cmd, input) {
  const f = { json: true }
  let args = []
  if (cmd.toCli) {
    const r = cmd.toCli(input)
    args = r.args
    Object.assign(f, r.flags)
  }
  for (const a of cmd.args ?? []) {
    const v = input[a.name]
    if (v === undefined || v === null || v === '') continue
    if (a.rest) args.push(...(Array.isArray(v) ? v : [v]).map(String))
    else args.push(String(v))
  }
  for (const key of cmd.opts ?? []) {
    const v = input[optProp(key)]
    if (v === undefined || v === null || v === false) continue
    const flag = OPTS[key].flag ?? key
    if (key === 'sitemap') f.sitemap = ['', 'auto', 'true', 'default'].includes(String(v).toLowerCase()) || v === true ? true : String(v)
    else f[flag] = OPTS[key].schema.type === 'boolean' ? true : String(v)
  }
  if (cmd.site !== false && input.siteUrl) f.site = String(input.siteUrl)
  return { args, flags: f }
}

const canonical = (v) => (Array.isArray(v)
  ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v))

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

function truncateRows(data, limit) {
  if (!Array.isArray(data) || data.length <= limit) return { data }
  return { data: data.slice(0, limit), note: `Showing ${limit} of ${data.length} rows (pass a larger "limit" for more).` }
}

export function createMcpServer({ readOnly = false, now = () => Date.now() } = {}) {
  const tools = mcpTools({ readOnly })
  const byName = new Map(tools.map((t) => [t.name, Object.keys(COMMANDS).find((c) => toolName(c) === t.name)]))
  const tokens = new Map()

  async function callTool(name, rawArgs = {}) {
    const command = byName.get(name)
    if (!command) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
    const cmd = COMMANDS[command]
    const { confirm_token: token, yes: _ignored, limit, ...input } = rawArgs ?? {}
    for (const [k, t] of tokens) if (t.expires < now()) tokens.delete(k)

    try {
      if (token !== undefined) {
        if (cmd.risk === 'read') return textResult(`"${name}" is read-only and takes no confirm_token.`, true)
        const entry = tokens.get(token)
        if (!entry) return textResult('confirm_token is invalid, expired or already used. Call the tool again without confirm_token to get a fresh dry run.', true)
        if (entry.tool !== name || entry.args !== canonical(input)) return textResult('These arguments differ from the dry run this token was issued for. Call again without confirm_token to preview the new request.', true)
        tokens.delete(token)
        const response = await send(entry.plan)
        const notes = (entry.plan.notes ?? []).map((n) => `ℹ︎ ${n}\n`).join('')
        return textResult(`${notes}✅ ${entry.plan.method} sent and accepted${entry.plan.endpoint ? '' : ' by Bing'}.${response === null || response === undefined ? '' : `\nResponse: ${JSON.stringify(clean(response))}`}`)
      }

      if (cmd.risk === 'danger' && !input.siteUrl) return textResult(`"${name}" is a danger tool: pass siteUrl explicitly (exactly as the "sites" tool lists it).`, true)
      const { args, flags: f } = toCliInvocation(cmd, input)
      const out = await execute(command, args, f)
      if (out.kind === 'data') {
        if (out.data === undefined || out.data === null) return textResult('(done — no data returned)')
        if (typeof out.data === 'string') return textResult(out.data)
        const { data, note } = truncateRows(out.data, Number(limit) > 0 ? Number(limit) : MCP_DEFAULT_LIMIT)
        return textResult(`${JSON.stringify(data)}${note ? `\n${note}` : ''}`)
      }
      const id = randomBytes(16).toString('hex')
      tokens.set(id, { tool: name, args: canonical(input), plan: out.plan, expires: now() + TOKEN_TTL_MS })
      const lines = [
        `DRY RUN (${out.risk}) — nothing has been sent.`,
        `POST ${planTarget(out.plan)}`,
        JSON.stringify(redactLong(out.plan.body), null, 2),
        ...(out.plan.notes ?? []).map((n) => `ℹ︎ ${n}`),
        ...(out.plan.preview ? [`Preview: ${JSON.stringify(out.plan.preview)}`] : []),
        '',
        `confirm_token: ${id}`,
        `To apply: show this plan to the user and, only if they approve, call "${name}" again with the same arguments plus confirm_token. The token is single-use and expires in 10 minutes.`,
      ]
      return textResult(lines.join('\n'))
    } catch (e) {
      return textResult(`Error: ${e.message}`, true)
    }
  }

  async function handle(msg) {
    if (Array.isArray(msg)) {
      if (!msg.length) return rpcError(null, -32600, 'Invalid Request: empty batch')
      // Strictly one at a time: commands share the per-call context (flags/SITE).
      const out = []
      for (const m of msg) {
        const r = await handle(m)
        if (r) out.push(r)
      }
      return out.length ? out : null
    }
    const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && typeof msg === 'object' && !('method' in msg) ? null : rpcError(msg?.id ?? null, -32600, 'Invalid Request')
    }
    if (!isRequest) return null // notifications (initialized, cancelled, …) need no reply
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result })
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion
        const protocolVersion = typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= '2024-11-05' ? requested : MCP_PROTOCOL_LATEST
        return reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'bing-webmaster', title: 'Bing Webmaster Tools', version: VERSION }, instructions: MCP_INSTRUCTIONS })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools })
      case 'tools/call': {
        const { name, arguments: args } = msg.params ?? {}
        if (typeof name !== 'string') return rpcError(msg.id, -32602, 'tools/call needs params.name')
        try {
          return reply(await callTool(name, args))
        } catch (e) {
          return rpcError(msg.id, e.code ?? -32603, e.message)
        }
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
    }
  }

  return { handle, tools, tokens }
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

async function serveMcp(f) {
  // stdout is the protocol channel: route all console output to stderr.
  const errConsole = new console.Console(process.stderr, process.stderr)
  for (const m of ['log', 'info', 'warn', 'debug', 'table', 'dir']) console[m] = errConsole[m].bind(errConsole)
  const server = createMcpServer({ readOnly: !!f['read-only'] })
  const write = (msg) => msg && process.stdout.write(`${JSON.stringify(msg)}\n`)
  let queue = Promise.resolve()
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    queue = queue.then(async () => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return write(rpcError(null, -32700, 'Parse error'))
      }
      write(await server.handle(msg))
    })
  })
  await new Promise((resolve) => rl.on('close', resolve))
  await queue
}

// ── main ──────────────────────────────────────────────────────────────
export async function main(argv = process.argv.slice(2)) {
  const { command, args, flags: f } = parseArgs(argv)
  if (f.version || command === 'version') return console.log(VERSION)
  if (command === 'help' || f.help) return help()
  if (command === 'mcp') return serveMcp(f)
  if (f.csv && command === 'summary') throw new Error('--csv is not available for summary; use --json')
  const out = await execute(command, args, f)
  render(command, out, f)
}

function loadDotenv() {
  if (process.env.BING_WEBMASTER_NO_DOTENV) return
  for (const file of ['.env.local', '.env', join(configDir(), '.env')]) {
    try {
      process.loadEnvFile(file)
    } catch {}
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  loadDotenv()
  try {
    await main()
  } catch (e) {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  }
}

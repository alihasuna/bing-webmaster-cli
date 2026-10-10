#!/usr/bin/env node
/**
 * bing-webmaster — command-line control of Bing Webmaster Tools via its official API.
 *
 *   bing-webmaster help                       all commands, grouped by risk
 *   bing-webmaster summary --site <url>       one-screen health check
 *
 * Every Bing Webmaster API method (IWebmasterApi) has a command, except the
 * obsolete deep-link methods (reachable via `call` if ever needed).
 *
 * Safety model
 *   read    runs immediately
 *   write   DRY-RUN unless --yes (prints the exact request it would send)
 *   danger  DRY-RUN unless --yes, AND requires an explicit --site (or a site URL
 *           argument) so nothing fires against BING_SITE_URL by accident
 *
 * Common options
 *   --site <url>   Bing site entry, exactly as listed by `sites` (or set BING_SITE_URL)
 *   --limit <n>    Max rows to print (default 25)
 *   --json         JSON output (dates normalised to YYYY-MM-DD)
 *   --raw          JSON output exactly as Bing returned it
 *   --yes          Actually send a write/danger request
 *
 * Auth: BING_WEBMASTER_API_KEY (Bing Webmaster → Settings → API access → API Key),
 * from the environment or a .env / .env.local file in the current directory.
 *
 * Notes
 * - Bing JSON API: GET params in the query string; POST bodies are wrapped
 *   requests keyed by the C# parameter names; dates are WCF "/Date(ms)/".
 * - A DNS-verified domain entry (https://example.com/) also covers its www host.
 * - IndexNow is a separate protocol and is not part of this API.
 */

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file)
  } catch {}
}

const API = 'https://ssl.bing.com/webmaster/api.svc/json/'
const KEY = process.env.BING_WEBMASTER_API_KEY
const NS = 'Microsoft.Bing.Webmaster.Api'

if (!KEY) {
  console.error('❌ Missing BING_WEBMASTER_API_KEY. Set it in your environment or a .env file.\n   Get one at Bing Webmaster Tools → Settings → API access → API Key.')
  process.exit(1)
}

// ── args ──────────────────────────────────────────────────────────────
const BOOLEAN_FLAGS = new Set(['json', 'raw', 'yes', 'directory', 'cache-only', 'all-subdomains', 'get', 'post', 'help'])
const flags = {}
const positional = []
{
  const argv = process.argv.slice(2)
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
}
const [command = 'help', ...args] = positional
const SITE = flags.site || process.env.BING_SITE_URL ? normaliseSite(flags.site || process.env.BING_SITE_URL) : null
const LIMIT = Number(flags.limit) > 0 ? Number(flags.limit) : 25

function normaliseSite(s) {
  const withScheme = /^https?:\/\//.test(s) ? s : `https://${s}`
  return withScheme.endsWith('/') ? withScheme : `${withScheme}/`
}

// ── API ───────────────────────────────────────────────────────────────
async function request(method, { get, body } = {}) {
  const qs = new URLSearchParams({ ...(get ?? {}), apikey: KEY })
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
function parseDate(v) {
  const m = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(v)
  if (!m) return v
  const ms = Number(m[1])
  return ms < 0 ? null : new Date(ms).toISOString().slice(0, 10)
}

function clean(v) {
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
function keywordParams(q) {
  const to = flags.to ?? new Date().toISOString().slice(0, 10)
  const from = flags.from ?? new Date(Date.now() - 182 * 864e5).toISOString().slice(0, 10)
  return { q, country: flags.country ?? 'us', language: flags.lang ?? 'en-US', startDate: from, endDate: to }
}

async function sitemapUrls(sitemapUrl) {
  const xml = await (await fetch(sitemapUrl)).text()
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])
}

// Removals must echo back the exact object Bing returned (with __type + WCF dates).
async function findRaw(method, params, match, what) {
  const rows = (await get(method, params)) ?? []
  const hit = rows.find(match)
  if (!hit) throw new Error(`No ${what} found. Current: ${JSON.stringify(clean(rows))}`)
  return hit
}

// ── commands ──────────────────────────────────────────────────────────
// risk: 'read' | 'write' | 'danger'. Writes return { method, body } (a plan);
// main() prints it as a dry run or sends it with --yes.
const COMMANDS = {
  // Overview
  summary: { risk: 'read', group: 'Overview', usage: 'summary', desc: 'Health check across all main reports', run: () => summary() },
  sites: { risk: 'read', group: 'Overview', usage: 'sites', desc: 'Sites on the account + verification', run: async () => clean(await get('GetUserSites')).map(({ Url, IsVerified }) => ({ Url, IsVerified })) },

  // Search performance
  traffic: { risk: 'read', group: 'Search performance', usage: 'traffic', desc: 'Daily clicks / impressions', run: async () => byDateDesc(clean(await get('GetRankAndTrafficStats', site()))) },
  queries: { risk: 'read', group: 'Search performance', usage: 'queries', desc: 'Top search queries', run: async () => aggregate(clean(await get('GetQueryStats', site())), 'Query') },
  pages: { risk: 'read', group: 'Search performance', usage: 'pages', desc: 'Top pages', run: async () => aggregate(clean(await get('GetPageStats', site())), 'Query', 'Page') },
  'query-pages': { risk: 'read', group: 'Search performance', usage: 'query-pages <query>', desc: 'Pages ranking for one query', run: async (a) => aggregate(clean(await get('GetQueryPageStats', { ...site(), query: need(a.join(' '), 'query-pages <query>') })), 'Query', 'Page') },
  'page-queries': { risk: 'read', group: 'Search performance', usage: 'page-queries <pageUrl>', desc: 'Queries a page ranks for', run: async ([p]) => aggregate(clean(await get('GetPageQueryStats', { ...site(), page: need(p, 'page-queries <pageUrl>') })), 'Query') },
  'query-page-detail': { risk: 'read', group: 'Search performance', usage: 'query-page-detail <query> <pageUrl>', desc: 'Daily stats for one query on one page', run: async ([q, p]) => byDateDesc(clean(await get('GetQueryPageDetailStats', { ...site(), query: need(q, 'query-page-detail <query> <pageUrl>'), page: need(p, 'query-page-detail <query> <pageUrl>') }))) },
  'query-traffic': { risk: 'read', group: 'Search performance', usage: 'query-traffic <query>', desc: 'Daily traffic for one query', run: async (a) => byDateDesc(clean(await get('GetQueryTrafficStats', { ...site(), query: need(a.join(' '), 'query-traffic <query>') }))) },

  // Keyword research
  keyword: { risk: 'read', group: 'Keyword research', usage: 'keyword <phrase> [--country us] [--lang en-US] [--from YYYY-MM-DD] [--to YYYY-MM-DD]', desc: 'Bing search impressions for a phrase over a period', run: async (a) => clean(await get('GetKeyword', keywordParams(need(a.join(' '), 'keyword <phrase>')))) },
  'keyword-stats': { risk: 'read', group: 'Keyword research', usage: 'keyword-stats <phrase> [--country us] [--lang en-US]', desc: 'Weekly impression history for a phrase', run: async (a) => { const { startDate, endDate, ...p } = keywordParams(need(a.join(' '), 'keyword-stats <phrase>')); return byDateDesc(clean(await get('GetKeywordStats', p))) } },
  'related-keywords': { risk: 'read', group: 'Keyword research', usage: 'related-keywords <phrase> [--country us] [--lang en-US] [--from] [--to]', desc: 'Related phrases with impressions', run: async (a) => clean(await get('GetRelatedKeywords', keywordParams(need(a.join(' '), 'related-keywords <phrase>')))).sort((a, b) => b.Impressions - a.Impressions) },

  // Index & crawl
  crawl: { risk: 'read', group: 'Index & crawl', usage: 'crawl', desc: 'Daily crawl stats', run: async () => byDateDesc(clean(await get('GetCrawlStats', site()))) },
  issues: { risk: 'read', group: 'Index & crawl', usage: 'issues', desc: 'Crawl issues by URL', run: async () => clean(await get('GetCrawlIssues', site())).map((r) => ({ ...r, Issues: issueNames(r.Issues) })) },
  url: { risk: 'read', group: 'Index & crawl', usage: 'url <url>', desc: 'Index info for one URL', run: async ([u]) => clean(await get('GetUrlInfo', { ...site(), url: need(u, 'url <url>') })) },
  'url-traffic': { risk: 'read', group: 'Index & crawl', usage: 'url-traffic <url>', desc: 'Clicks / impressions for one URL', run: async ([u]) => clean(await get('GetUrlTrafficInfo', { ...site(), url: need(u, 'url-traffic <url>') })) },
  children: {
    risk: 'read', group: 'Index & crawl', usage: 'children <url|domain:host> [--page n] [--crawled any|week|2weeks|3weeks] [--discovered any|week|month] [--http any|2xx|3xx|301|302|4xx|5xx|other]',
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
  'children-traffic': { risk: 'read', group: 'Index & crawl', usage: 'children-traffic <url> [--page n]', desc: 'Traffic for URLs under a directory', run: async ([u]) => clean(await get('GetChildrenUrlTrafficInfo', { ...site(), url: need(u, 'children-traffic <url>'), page: page() })) },
  'crawl-settings': { risk: 'read', group: 'Index & crawl', usage: 'crawl-settings', desc: 'Hourly crawl rate + crawl boost', run: async () => clean(await get('GetCrawlSettings', site())) },
  fetched: { risk: 'read', group: 'Index & crawl', usage: 'fetched', desc: 'URLs fetched with "fetch" (Fetch as Bingbot)', run: async () => clean(await get('GetFetchedUrls', site())) },
  'fetched-details': { risk: 'read', group: 'Index & crawl', usage: 'fetched-details <url>', desc: 'Result of a Fetch as Bingbot', run: async ([u]) => clean(await get('GetFetchedUrlDetails', { ...site(), url: need(u, 'fetched-details <url>') })) },

  // Sitemaps & submission
  sitemaps: { risk: 'read', group: 'Sitemaps & submission', usage: 'sitemaps', desc: 'Submitted sitemaps / feeds', run: async () => clean(await get('GetFeeds', site())).map(({ Url, Status, UrlCount, LastCrawled, Submitted }) => ({ Url, Status, UrlCount, LastCrawled, Submitted })) },
  'sitemap-details': { risk: 'read', group: 'Sitemaps & submission', usage: 'sitemap-details <sitemapUrl>', desc: 'Child sitemaps of a sitemap index', run: async ([f]) => clean(await get('GetFeedDetails', { ...site(), feedUrl: need(f, 'sitemap-details <sitemapUrl>') })) },
  quota: { risk: 'read', group: 'Sitemaps & submission', usage: 'quota', desc: 'URL + content submission quota left', run: async () => ({ urls: clean(await get('GetUrlSubmissionQuota', site())), content: clean(await get('GetContentSubmissionQuota', site())) }) },
  submit: {
    risk: 'write', group: 'Sitemaps & submission', usage: 'submit <url> [url…] | submit --sitemap [sitemapUrl]',
    desc: 'Ask Bing to (re)crawl URLs (uses daily quota)',
    run: async (urls) => {
      let list = urls
      if (flags.sitemap !== undefined) {
        const sm = typeof flags.sitemap === 'string' ? flags.sitemap : new URL('sitemap.xml', site().siteUrl).href
        list = await sitemapUrls(sm)
        const { DailyQuota } = await get('GetUrlSubmissionQuota', site())
        if (list.length > DailyQuota) {
          console.log(`ℹ︎ Sitemap has ${list.length} URLs, daily quota is ${DailyQuota} — submitting the first ${DailyQuota}.`)
          list = list.slice(0, DailyQuota)
        }
      }
      need(list[0], 'submit <url> [url…]')
      return list.length === 1
        ? { method: 'SubmitUrl', body: { ...site(), url: list[0] } }
        : { method: 'SubmitUrlBatch', body: { ...site(), urlList: list } }
    },
  },
  'submit-content': {
    risk: 'write', group: 'Sitemaps & submission', usage: 'submit-content <url>',
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
  'add-sitemap': { risk: 'write', group: 'Sitemaps & submission', usage: 'add-sitemap <sitemapUrl>', desc: 'Submit (or resubmit) a sitemap', run: async ([f]) => ({ method: 'SubmitFeed', body: { ...site(), feedUrl: need(f, 'add-sitemap <sitemapUrl>') } }) },
  'remove-sitemap': { risk: 'danger', group: 'Sitemaps & submission', usage: 'remove-sitemap <sitemapUrl> --site <site>', desc: 'Remove a sitemap', run: async ([f]) => ({ method: 'RemoveFeed', body: { ...site(), feedUrl: need(f, 'remove-sitemap <sitemapUrl>') } }) },
  fetch: { risk: 'write', group: 'Sitemaps & submission', usage: 'fetch <url>', desc: 'Fetch as Bingbot (see results with "fetched")', run: async ([u]) => ({ method: 'FetchUrl', body: { ...site(), url: need(u, 'fetch <url>') } }) },

  // Links
  links: { risk: 'read', group: 'Links', usage: 'links [--page n]', desc: 'Pages with inbound links + counts', run: async () => clean(await get('GetLinkCounts', { ...site(), page: page() })).Links },
  'url-links': { risk: 'read', group: 'Links', usage: 'url-links <url> [--page n]', desc: 'Inbound links to one URL', run: async ([u]) => clean(await get('GetUrlLinks', { ...site(), link: need(u, 'url-links <url>'), page: page() })).Details },
  connected: { risk: 'read', group: 'Links', usage: 'connected', desc: 'Connected pages (social profiles etc. that link to you)', run: async () => clean(await get('GetConnectedPages', site())) },
  'add-connected': { risk: 'write', group: 'Links', usage: 'add-connected <pageUrl>', desc: 'Add a connected page (e.g. Instagram profile)', run: async ([u]) => ({ method: 'AddConnectedPage', body: { ...site(), masterUrl: need(u, 'add-connected <pageUrl>') } }) },

  // Sites & users
  'add-site': { risk: 'write', group: 'Sites & users', usage: 'add-site <siteUrl>', desc: 'Add a site to the account', run: async ([s]) => ({ method: 'AddSite', body: { siteUrl: normaliseSite(need(s, 'add-site <siteUrl>')) } }) },
  'verify-site': { risk: 'write', group: 'Sites & users', usage: 'verify-site [--site <site>]', desc: 'Re-run ownership verification', run: async () => ({ method: 'VerifySite', body: site() }) },
  'remove-site': { risk: 'danger', explicitSite: true, group: 'Sites & users', usage: 'remove-site <siteUrl>', desc: 'Remove a site from the account (loses its history)', run: async ([s]) => ({ method: 'RemoveSite', body: { siteUrl: normaliseSite(need(s, 'remove-site <siteUrl>')) } }) },
  roles: {
    risk: 'read', group: 'Sites & users', usage: 'roles [--all-subdomains]', desc: 'Who has access to the site',
    run: async () => clean(await get('GetSiteRoles', { ...site(), includeAllSubdomains: String(!!flags['all-subdomains']) }))
      .map(({ Email, Role, Site, DelegatorEmail, Expired, Date }) => ({ Email, Role: ROLE_NAMES[Role] ?? Role, Site, DelegatedBy: DelegatorEmail, Expired, Date })),
  },
  'add-user': {
    risk: 'danger', group: 'Sites & users', usage: 'add-user <email> --role admin|readwrite|readonly --site <site>', desc: 'Give someone access to the site',
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
    risk: 'danger', group: 'Sites & users', usage: 'remove-user <email> --site <site>', desc: 'Revoke someone\'s access',
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
    risk: 'danger', group: 'Sites & users', usage: 'site-move <fromUrl> <toUrl> --site <fromSite> [--scope domain|host|directory] [--type local|global]',
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
    risk: 'danger', group: 'Configuration', usage: 'crawl-rate --site <site> [--rate 1-10 | --hours h0,…,h23] [--boost on|off]',
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
    risk: 'danger', group: 'Configuration', usage: 'block <url> --site <site> [--directory] [--cache-only]',
    desc: 'Remove a URL/directory from Bing results',
    run: async ([u]) => ({
      method: 'AddBlockedUrl',
      body: { ...site(), blockedUrl: { __type: `BlockedUrl:#${NS}`, Date: wcfDate(), EntityType: flags.directory ? 1 : 0, RequestType: flags['cache-only'] ? 0 : 1, Url: need(u, 'block <url>') } },
    }),
  },
  unblock: {
    risk: 'danger', group: 'Configuration', usage: 'unblock <url> --site <site>', desc: 'Undo a block',
    run: async ([u]) => ({ method: 'RemoveBlockedUrl', body: { ...site(), blockedUrl: await findRaw('GetBlockedUrls', site(), (r) => r.Url === need(u, 'unblock <url>'), `block for ${u}`) } }),
  },
  'preview-blocks': { risk: 'read', group: 'Configuration', usage: 'preview-blocks', desc: 'Pages with search-result previews blocked', run: async () => clean(await get('GetActivePagePreviewBlocks', site())) },
  'preview-block': { risk: 'danger', group: 'Configuration', usage: 'preview-block <url> --reason <n> --site <site>', desc: 'Block a page\'s rich preview (BlockReason values undocumented)', run: async ([u]) => ({ method: 'AddPagePreviewBlock', body: { ...site(), url: need(u, 'preview-block <url>'), reason: Number(need(flags.reason, 'preview-block <url> --reason <n>')) } }) },
  'preview-unblock': { risk: 'danger', group: 'Configuration', usage: 'preview-unblock <url> --site <site>', desc: 'Remove a preview block', run: async ([u]) => ({ method: 'RemovePagePreviewBlock', body: { ...site(), url: need(u, 'preview-unblock <url>') } }) },
  params: { risk: 'read', group: 'Configuration', usage: 'params', desc: 'URL parameters Bing ignores (normalisation)', run: async () => clean(await get('GetQueryParameters', site())) },
  'add-param': { risk: 'danger', group: 'Configuration', usage: 'add-param <name> --site <site>', desc: 'Tell Bing to ignore a URL parameter (e.g. utm_source)', run: async ([p]) => ({ method: 'AddQueryParameter', body: { ...site(), queryParameter: need(p, 'add-param <name>') } }) },
  'remove-param': { risk: 'danger', group: 'Configuration', usage: 'remove-param <name> --site <site>', desc: 'Remove an ignored URL parameter', run: async ([p]) => ({ method: 'RemoveQueryParameter', body: { ...site(), queryParameter: need(p, 'remove-param <name>') } }) },
  'toggle-param': { risk: 'danger', group: 'Configuration', usage: 'toggle-param <name> on|off --site <site>', desc: 'Enable/disable an ignored URL parameter', run: async ([p, state]) => ({ method: 'EnableDisableQueryParameter', body: { ...site(), queryParameter: need(p, 'toggle-param <name> on|off'), isEnabled: pick(state, { on: true, off: false }, 'state') } }) },
  geo: { risk: 'read', group: 'Configuration', usage: 'geo', desc: 'Country/region targeting', run: async () => clean(await get('GetCountryRegionSettings', site())) },
  'add-geo': {
    risk: 'danger', group: 'Configuration', usage: 'add-geo <url> <CC> --site <site> [--type page|directory|domain|subdomain]',
    desc: 'Target a URL/section at a country (e.g. CA)',
    run: async ([u, cc]) => ({
      method: 'AddCountryRegionSettings',
      body: { ...site(), settings: { __type: `CountryRegionSettings:#${NS}`, Date: wcfDate(), TwoLetterIsoCountryCode: need(cc, 'add-geo <url> <CC>').toUpperCase(), Type: pick(flags.type ?? 'domain', { page: 0, directory: 1, domain: 2, subdomain: 3 }, '--type'), Url: need(u, 'add-geo <url> <CC>') } },
    }),
  },
  'remove-geo': {
    risk: 'danger', group: 'Configuration', usage: 'remove-geo <url> --site <site>', desc: 'Remove country targeting',
    run: async ([u]) => ({ method: 'RemoveCountryRegionSettings', body: { ...site(), settings: await findRaw('GetCountryRegionSettings', site(), (r) => r.Url === need(u, 'remove-geo <url>'), `geo setting for ${u}`) } }),
  },

  // Escape hatch
  call: {
    risk: 'dynamic', group: 'Advanced', usage: 'call <Method> [key=value …] [--body \'{json}\'] [--post]',
    desc: 'Call any API method directly (Get* = read; anything else is danger)',
    run: async ([method, ...kv]) => {
      need(method, 'call <Method> …')
      const params = Object.fromEntries(kv.map((p) => p.split(/=(.*)/s).slice(0, 2)))
      const typed = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v]))
      if (!('siteUrl' in params) && method !== 'GetUserSites' && !/Keyword/.test(method) && SITE) params.siteUrl = SITE
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

function help() {
  const groups = {}
  for (const [name, c] of Object.entries(COMMANDS)) (groups[c.group] ??= []).push([name, c])
  const tag = { read: '   ', write: ' ✎ ', danger: ' ⚠ ', dynamic: ' ? ' }
  console.log('bing-webmaster <command> [args] [--site <url>] [--json] [--yes]\n')
  console.log('   = read (runs now)   ✎ = write (dry-run unless --yes)   ⚠ = danger (dry-run unless --yes, needs explicit --site)\n')
  for (const [group, cmds] of Object.entries(groups)) {
    console.log(group)
    for (const [, c] of cmds) console.log(`${tag[c.risk]}${c.usage.padEnd(58)} ${c.desc}`)
    console.log()
  }
}

// Shorten long base64 payloads in dry-run output.
const redactLong = (body) => JSON.parse(JSON.stringify(body, (k, v) => {
  if (k === 'authenticationCode' && v) return `${String(v).slice(0, 4)}…`
  return typeof v === 'string' && v.length > 300 ? `${v.slice(0, 60)}… (${v.length} chars)` : v
}))

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  if (command === 'help' || flags.help) return help()
  const cmd = COMMANDS[command]
  if (!cmd) {
    console.error(`Unknown command "${command}". Run: bing-webmaster help`)
    process.exit(1)
  }

  const result = await cmd.run(args)
  const isPlan = result && typeof result === 'object' && typeof result.method === 'string' && 'body' in result
  if (!isPlan) {
    if (result === undefined && command === 'summary') return
    if (flags.raw || flags.json) return console.log(JSON.stringify(result, null, 2))
    return print(SITE ? `${command} — ${SITE}` : command, result)
  }

  // Writes
  const risk = cmd.risk === 'dynamic' ? (/^Get/.test(result.method) ? 'read' : 'danger') : cmd.risk
  if (risk === 'danger' && !cmd.explicitSite && !flags.site) {
    throw new Error(`"${command}" changes Bing settings — pass --site explicitly (e.g. --site ${SITE ?? 'https://example.com/'}) to confirm which site.`)
  }
  if (risk !== 'read' && !flags.yes) {
    console.log(`DRY RUN (${risk}) — nothing sent. Re-run with --yes to apply.\n`)
    console.log(`POST ${API}${result.method}`)
    console.log(JSON.stringify(redactLong(result.body), null, 2))
    if (result.preview) console.log('\nPreview:'), console.dir(result.preview, { depth: 4 })
    return
  }
  const response = await post(result.method, result.body)
  if (risk === 'read') return flags.raw ? console.log(JSON.stringify(response, null, 2)) : flags.json ? console.log(JSON.stringify(clean(response), null, 2)) : print(result.method, clean(response))
  console.log(`✅ ${result.method} accepted by Bing`)
  if (response !== null && response !== undefined) print('Response', clean(response))
}

try {
  await main()
} catch (e) {
  console.error(`❌ ${e.message}`)
  process.exit(1)
}

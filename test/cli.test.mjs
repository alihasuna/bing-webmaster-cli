import { tmp, SITE, mockFetch, captureLog, xml, urlset } from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { parseArgs, normaliseSite, parseDate, clean, execute, main, toCsv, readSitemap, isNewer, loadState, VERSION } from '../bin/bing-webmaster.mjs'

const BIN = fileURLToPath(new URL('../bin/bing-webmaster.mjs', import.meta.url))
const resetState = () => rmSync(process.env.BING_WEBMASTER_STATE_FILE, { force: true })

// ── arg parsing ───────────────────────────────────────────────────────
test('parseArgs: positionals, value flags, inline values, booleans', () => {
  assert.deepEqual(parseArgs([]), { command: 'help', args: [], flags: {} })
  assert.deepEqual(parseArgs(['queries', '--site', 'https://a.com/', '--limit', '5', '--json']), {
    command: 'queries', args: [], flags: { site: 'https://a.com/', limit: '5', json: true },
  })
  assert.deepEqual(parseArgs(['keyword', 'standing', 'desk', '--country=ca']).flags, { country: 'ca' })
  // boolean flags never swallow the next positional
  assert.deepEqual(parseArgs(['submit', '--yes', 'https://a.com/x']), { command: 'submit', args: ['https://a.com/x'], flags: { yes: true } })
  assert.deepEqual(parseArgs(['submit', '--sitemap', '--changed']).flags, { sitemap: true, changed: true })
  assert.deepEqual(parseArgs(['submit', '--sitemap', 'https://a.com/s.xml', '--changed', '--csv']).flags, { sitemap: 'https://a.com/s.xml', changed: true, csv: true })
  assert.equal(parseArgs(['call', 'GetX', '--body={"a":"b=c"}']).flags.body, '{"a":"b=c"}')
})

test('normaliseSite adds scheme and trailing slash', () => {
  assert.equal(normaliseSite('example.com'), 'https://example.com/')
  assert.equal(normaliseSite('http://example.com/blog'), 'http://example.com/blog/')
})

// ── dates ─────────────────────────────────────────────────────────────
test('parseDate handles WCF dates, offsets, "never" sentinels and passthrough', () => {
  assert.equal(parseDate('/Date(1696748400000-0700)/'), '2023-10-08')
  assert.equal(parseDate('/Date(1791535751000)/'), '2026-10-09')
  assert.equal(parseDate('/Date(-11644473600000)/'), null)
  assert.equal(parseDate('hello'), 'hello')
  assert.deepEqual(clean([{ __type: 'X:#NS', Date: '/Date(1696748400000)/', Nested: { __type: 'Y', When: '/Date(0)/' } }]), [{ Date: '2023-10-08', Nested: { When: '1970-01-01' } }])
})

test('keyword commands send plain YYYY-MM-DD dates and validate them', async (t) => {
  const calls = mockFetch(t, { GetKeyword: { Query: 'standing desk', Impressions: 10 } })
  await execute('keyword', ['standing', 'desk'], { from: '2026-01-01', to: '2026-02-01', country: 'ca' })
  const qs = calls[0].url.searchParams
  assert.equal(qs.get('q'), 'standing desk')
  assert.equal(qs.get('startDate'), '2026-01-01')
  assert.equal(qs.get('endDate'), '2026-02-01')
  assert.equal(qs.get('country'), 'ca')
  await assert.rejects(execute('keyword', ['x'], { from: '01/02/2026' }), /--from must be a date/)
})

// ── dry-run vs --yes ──────────────────────────────────────────────────
test('write commands are a dry run without --yes and send nothing', async (t) => {
  const calls = mockFetch(t, { SubmitFeed: null })
  const out = await execute('add-sitemap', [`${SITE}sitemap.xml`], { site: SITE })
  assert.equal(out.kind, 'plan')
  assert.deepEqual(out.plan.body, { siteUrl: SITE, feedUrl: `${SITE}sitemap.xml` })
  assert.equal(calls.length, 0)

  const printed = await captureLog(() => main(['add-sitemap', `${SITE}sitemap.xml`, '--site', SITE]))
  assert.match(printed, /DRY RUN \(write\) — nothing sent/)
  assert.match(printed, /POST https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/SubmitFeed/)
  assert.equal(calls.length, 0)
})

test('--yes sends the planned request', async (t) => {
  const calls = mockFetch(t, { SubmitFeed: null })
  const out = await execute('add-sitemap', [`${SITE}sitemap.xml`], { site: SITE, yes: true })
  assert.equal(out.kind, 'sent')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bing, 'SubmitFeed')
  assert.equal(calls[0].http, 'POST')
  assert.equal(calls[0].url.searchParams.get('apikey'), 'test-key')
  assert.deepEqual(calls[0].body, { siteUrl: SITE, feedUrl: `${SITE}sitemap.xml` })
})

test('Bing errors surface with the unowned-site hint', async (t) => {
  mockFetch(t, { GetCrawlStats: () => new Response(JSON.stringify({ ErrorCode: 14, Message: 'NotAuthorized' }), { status: 400 }) })
  await assert.rejects(execute('crawl', [], { site: SITE }), /HTTP 400 NotAuthorized \(is https:\/\/example\.com\/ on this Bing account\?\)/)
})

test('missing API key only fails when Bing is actually called', async (t) => {
  const key = process.env.BING_WEBMASTER_API_KEY
  delete process.env.BING_WEBMASTER_API_KEY
  t.after(() => { process.env.BING_WEBMASTER_API_KEY = key })
  mockFetch(t, {})
  await assert.rejects(execute('sites'), /Missing BING_WEBMASTER_API_KEY/)
  const out = await execute('indexnow-key')
  assert.match(out.data.key, /^[0-9a-f]{32}$/)
})

// ── danger gate ───────────────────────────────────────────────────────
test('danger commands require an explicit --site, even with --yes', async (t) => {
  process.env.BING_SITE_URL = SITE
  t.after(() => delete process.env.BING_SITE_URL)
  const calls = mockFetch(t, { RemoveFeed: null })
  await assert.rejects(execute('remove-sitemap', [`${SITE}old.xml`], { yes: true }), /pass --site explicitly/)
  assert.equal(calls.length, 0)
  const out = await execute('remove-sitemap', [`${SITE}old.xml`], { site: SITE })
  assert.equal(out.kind, 'plan')
  assert.equal(out.risk, 'danger')
  // remove-site names the site as its argument, which counts as explicit
  assert.equal((await execute('remove-site', ['example.com'], {})).plan.body.siteUrl, SITE)
})

test('call: Get* runs as a read, anything else is danger', async (t) => {
  const calls = mockFetch(t, { GetUrlInfo: { Url: `${SITE}a` }, AddQueryParameter: null })
  const read = await execute('call', ['GetUrlInfo', `url=${SITE}a`], { site: SITE })
  assert.equal(read.kind, 'data')
  assert.equal(calls[0].url.searchParams.get('siteUrl'), SITE)
  process.env.BING_SITE_URL = SITE
  t.after(() => delete process.env.BING_SITE_URL)
  await assert.rejects(execute('call', ['AddQueryParameter', 'queryParameter=utm'], { yes: true }), /pass --site explicitly/)
  assert.equal(calls.length, 1)
})

// ── guards + removal round-trips ──────────────────────────────────────
const ROLES = [
  { __type: `SiteRoles:#Microsoft.Bing.Webmaster.Api`, Date: '/Date(1696748400000)/', DelegatorEmail: null, Email: 'owner@example.com', Expired: false, Role: 0, Site: SITE, VerificationSite: SITE },
  { __type: `SiteRoles:#Microsoft.Bing.Webmaster.Api`, Date: '/Date(1696748400000)/', DelegatorEmail: 'owner@example.com', Email: 'helper@example.com', Expired: false, Role: 2, Site: SITE, VerificationSite: SITE },
]

test('remove-user refuses to remove the last Administrator', async (t) => {
  const calls = mockFetch(t, { GetSiteRoles: ROLES, RemoveSiteRole: null })
  await assert.rejects(execute('remove-user', ['Owner@Example.com'], { site: SITE, yes: true }), /only Administrator/)
  assert.ok(calls.every((c) => c.bing === 'GetSiteRoles'))
})

test('remove-user echoes the raw role object (with __type and WCF dates)', async (t) => {
  const calls = mockFetch(t, { GetSiteRoles: ROLES, RemoveSiteRole: null })
  await execute('remove-user', ['helper@example.com'], { site: SITE, yes: true })
  const sent = calls.find((c) => c.bing === 'RemoveSiteRole')
  assert.deepStrictEqual(sent.body, { siteUrl: SITE, siteRole: ROLES[1] })
})

test('unblock sends back the exact BlockedUrl object Bing returned', async (t) => {
  const raw = { __type: 'BlockedUrl:#Microsoft.Bing.Webmaster.Api', Date: '/Date(1696748400000-0700)/', EntityType: 0, RequestType: 1, Url: `${SITE}secret` }
  const calls = mockFetch(t, { GetBlockedUrls: [raw], RemoveBlockedUrl: null })
  await execute('unblock', [`${SITE}secret`], { site: SITE, yes: true })
  const sent = calls.find((c) => c.bing === 'RemoveBlockedUrl')
  assert.deepStrictEqual(sent.body.blockedUrl, raw)
  await assert.rejects(execute('unblock', [`${SITE}nope`], { site: SITE }), /No block for/)
})

test('crawl-rate validates input and previews before/after', async (t) => {
  mockFetch(t, { GetCrawlSettings: { CrawlBoostAvailable: true, CrawlBoostEnabled: false, CrawlRate: Array(24).fill(5) } })
  const out = await execute('crawl-rate', [], { site: SITE, rate: '7', boost: 'on' })
  assert.deepEqual(out.plan.body.crawlSettings.CrawlRate, Array(24).fill(7))
  assert.equal(out.plan.preview.after.CrawlBoostEnabled, true)
  await assert.rejects(execute('crawl-rate', [], { site: SITE, rate: '11' }), /24 integers between 1 and 10/)
})

// ── sitemaps + smart submission ───────────────────────────────────────
test('readSitemap follows indexes, decodes entities and handles gzip', async (t) => {
  mockFetch(t, {
    [`${SITE}sitemap.xml`]: xml(`<sitemapindex><sitemap><loc>${SITE}a.xml</loc></sitemap><sitemap><loc>${SITE}b.xml.gz</loc></sitemap></sitemapindex>`),
    [`${SITE}a.xml`]: xml(urlset([[`${SITE}p?x=1&amp;y=2`, '2026-01-01'], [`${SITE}q`]])),
    [`${SITE}b.xml.gz`]: () => new Response(gzipSync(urlset([[`${SITE}r`, '2026-02-01T10:00:00+00:00'], [`${SITE}q`]]))),
  })
  assert.deepEqual(await readSitemap(`${SITE}sitemap.xml`), [
    { loc: `${SITE}p?x=1&y=2`, lastmod: '2026-01-01' },
    { loc: `${SITE}q`, lastmod: undefined },
    { loc: `${SITE}r`, lastmod: '2026-02-01T10:00:00+00:00' },
  ])
})

test('isNewer compares date-only lastmods by day', () => {
  assert.equal(isNewer('2026-10-10', '2026-10-10T15:00:00.000Z'), true)
  assert.equal(isNewer('2026-10-09', '2026-10-10T15:00:00.000Z'), false)
  assert.equal(isNewer('2026-10-10T16:00:00Z', '2026-10-10T15:00:00.000Z'), true)
  assert.equal(isNewer('2026-10-10T14:00:00Z', '2026-10-10T15:00:00.000Z'), false)
  assert.equal(isNewer(undefined, '2026-10-10T15:00:00.000Z'), false)
})

test('submit --sitemap --changed: quota cap, state only on success, carry-over', async (t) => {
  resetState()
  let sitemap = urlset([[`${SITE}old`, '2020-01-01'], [`${SITE}mid`, '2021-01-01'], [`${SITE}new`, '2022-01-01']])
  const calls = mockFetch(t, {
    [`${SITE}sitemap.xml`]: () => xml(sitemap)(),
    GetUrlSubmissionQuota: { DailyQuota: 2, MonthlyQuota: 50 },
    SubmitUrlBatch: null,
    SubmitUrl: null,
  })

  // First run, no state: everything counts as changed, newest first, capped at quota.
  const dry = await execute('submit', [], { site: SITE, sitemap: true, changed: true })
  assert.deepEqual(dry.plan.body.urlList, [`${SITE}new`, `${SITE}mid`])
  assert.match(dry.plan.notes.join(' '), /carried over/)
  assert.equal(existsSync(process.env.BING_WEBMASTER_STATE_FILE), false, 'dry run must not write state')

  await execute('submit', [], { site: SITE, sitemap: true, changed: true, yes: true })
  const state = loadState()[SITE].submit
  assert.deepEqual(state.pending, [`${SITE}old`])
  assert.ok(Date.parse(state.lastRun))

  // Second run: the leftover plus anything modified since.
  sitemap = urlset([[`${SITE}old`, '2020-01-01'], [`${SITE}mid`, '2021-01-01'], [`${SITE}new`, '2022-01-01'], [`${SITE}fresh`, '2099-01-01'], [`${SITE}undated`]])
  const second = await execute('submit', [], { site: SITE, sitemap: true, changed: true, yes: true })
  assert.deepEqual(second.plan.body.urlList, [`${SITE}fresh`, `${SITE}old`])
  assert.match(second.plan.notes.join(' '), /1 URL\(s\) have no <lastmod>/)
  assert.deepEqual(loadState()[SITE].submit.pending, [])

  // Third run: nothing new (only the future-dated page still compares newer, so drop it).
  sitemap = urlset([[`${SITE}old`, '2020-01-01']])
  const third = await execute('submit', [], { site: SITE, sitemap: true, changed: true })
  assert.equal(third.kind, 'data')
  assert.match(third.data, /Nothing to submit/)
  assert.equal(calls.filter((c) => c.bing === 'SubmitUrlBatch').length, 2)
})

test('submit splits more than 500 URLs into batches', async (t) => {
  const urls = Array.from({ length: 501 }, (_, i) => `${SITE}p${i}`)
  const calls = mockFetch(t, { SubmitUrlBatch: null })
  await execute('submit', urls, { site: SITE, yes: true })
  const batches = calls.filter((c) => c.bing === 'SubmitUrlBatch').map((c) => c.body.urlList.length)
  assert.deepEqual(batches, [500, 1])
})

test('submit --changed without --sitemap is an error; zero quota is an error', async (t) => {
  await assert.rejects(execute('submit', [`${SITE}a`], { site: SITE, changed: true }), /only works with --sitemap/)
  mockFetch(t, { [`${SITE}sitemap.xml`]: xml(urlset([[`${SITE}a`]])), GetUrlSubmissionQuota: { DailyQuota: 0, MonthlyQuota: 0 } })
  await assert.rejects(execute('submit', [], { site: SITE, sitemap: true }), /No URL submission quota left/)
})

// ── IndexNow ──────────────────────────────────────────────────────────
test('indexnow-key prints a valid key and where to host it', async () => {
  const { data } = await execute('indexnow-key', [], { site: SITE })
  assert.match(data.key, /^[0-9a-f]{32}$/)
  assert.equal(data.keyFileContents, data.key)
  assert.equal(data.hostAt, `${SITE}${data.key}.txt`)
})

test('indexnow: needs a key, dry-runs by default, posts to api.indexnow.org with --yes', async (t) => {
  await assert.rejects(execute('indexnow', [`${SITE}a`]), /Missing INDEXNOW_KEY/)
  process.env.INDEXNOW_KEY = 'abcdef0123456789'
  t.after(() => delete process.env.INDEXNOW_KEY)
  const calls = mockFetch(t, { 'https://api.indexnow.org/indexnow': () => new Response('', { status: 202 }) })

  const dry = await execute('indexnow', [`${SITE}a`, `${SITE}b`])
  assert.equal(dry.kind, 'plan')
  assert.equal(dry.plan.endpoint, 'https://api.indexnow.org/indexnow')
  assert.deepEqual(dry.plan.body, { host: 'example.com', key: 'abcdef0123456789', urlList: [`${SITE}a`, `${SITE}b`] })
  assert.equal(calls.length, 0)

  const sent = await execute('indexnow', [`${SITE}a`], { yes: true, 'key-location': `${SITE}keys/k.txt` })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].http, 'POST')
  assert.deepEqual(calls[0].body, { host: 'example.com', key: 'abcdef0123456789', keyLocation: `${SITE}keys/k.txt`, urlList: [`${SITE}a`] })
  assert.equal(sent.response.status, 202)

  await assert.rejects(execute('indexnow', [`${SITE}a`, 'https://other.com/b']), /one host per request/)
})

test('indexnow surfaces protocol errors', async (t) => {
  process.env.INDEXNOW_KEY = 'abcdef0123456789'
  t.after(() => delete process.env.INDEXNOW_KEY)
  mockFetch(t, { 'https://api.indexnow.org/indexnow': () => new Response('', { status: 403 }) })
  await assert.rejects(execute('indexnow', [`${SITE}a`], { yes: true }), /HTTP 403 key not valid/)
})

test('indexnow --sitemap --changed keeps its own state', async (t) => {
  resetState()
  process.env.INDEXNOW_KEY = 'abcdef0123456789'
  t.after(() => delete process.env.INDEXNOW_KEY)
  mockFetch(t, {
    [`${SITE}sitemap.xml`]: xml(urlset([[`${SITE}a`, '2020-01-01']])),
    'https://api.indexnow.org/indexnow': () => new Response('', { status: 200 }),
  })
  await execute('indexnow', [], { site: SITE, sitemap: true, changed: true, yes: true })
  assert.ok(loadState()[SITE].indexnow.lastRun)
  assert.equal(loadState()[SITE].submit, undefined)
  const again = await execute('indexnow', [], { site: SITE, sitemap: true, changed: true })
  assert.match(again.data, /Nothing to notify/)
})

// ── CSV ───────────────────────────────────────────────────────────────
test('toCsv: union header, RFC 4180 quoting, nested values as JSON', () => {
  assert.equal(
    toCsv([{ a: 1, b: 'x,y' }, { a: 'say "hi"', c: { d: 1 } }, { b: 'line\nbreak' }]),
    'a,b,c\n1,"x,y",\n"say ""hi""",,"{""d"":1}"\n,"line\nbreak",',
  )
  assert.equal(toCsv(['p', 'q']), 'value\np\nq')
})

test('--csv prints all rows of a table read; errors on nested data', async (t) => {
  mockFetch(t, {
    GetUserSites: [{ Url: SITE, IsVerified: true }, { Url: 'https://b.com/', IsVerified: false }],
    GetUrlSubmissionQuota: { DailyQuota: 1, MonthlyQuota: 2 },
    GetContentSubmissionQuota: { DailyQuota: 1, MonthlyQuota: 2 },
  })
  assert.equal(await captureLog(() => main(['sites', '--csv'])), `Url,IsVerified\n${SITE},true\nhttps://b.com/,false`)
  await assert.rejects(main(['quota', '--csv', '--site', SITE]), /--csv needs a table result/)
})

// ── entry point ───────────────────────────────────────────────────────
test('runs through a symlink (npx / global install) and needs no key for --version', () => {
  const link = join(tmp, 'bing-webmaster-link.mjs')
  rmSync(link, { force: true })
  symlinkSync(BIN, link)
  const env = { ...process.env }
  delete env.BING_WEBMASTER_API_KEY
  const r = spawnSync(process.execPath, [link, '--version'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), VERSION)
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
})

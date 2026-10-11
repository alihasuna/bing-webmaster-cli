import { SITE, mockFetch } from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { COMMANDS, createMcpServer, mcpTools, VERSION } from '../bin/bing-webmaster.mjs'

const BIN = fileURLToPath(new URL('../bin/bing-webmaster.mjs', import.meta.url))
let nextId = 1
const rpc = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) })
const call = async (server, name, args) => (await server.handle(rpc('tools/call', { name, arguments: args }))).result
const text = (result) => result.content.map((c) => c.text).join('\n')
const tokenOf = (result) => /confirm_token: ([0-9a-f]{32})/.exec(text(result))?.[1]

test('initialize, ping, notifications and unknown methods', async () => {
  const server = createMcpServer()
  const init = await server.handle(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }))
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
  assert.deepEqual(init.result.serverInfo, { name: 'bing-webmaster', title: 'Bing Webmaster Tools', version: VERSION })
  assert.match(init.result.instructions, /confirm_token/)
  assert.equal((await server.handle(rpc('initialize', { protocolVersion: 'bogus' }))).result.protocolVersion, '2025-06-18')
  assert.deepEqual((await server.handle(rpc('ping'))).result, {})
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal((await server.handle(rpc('resources/list'))).error.code, -32601)
  assert.equal((await server.handle(rpc('tools/call', { name: 'nope', arguments: {} }))).error.code, -32602)
  assert.equal((await server.handle({ id: 9, method: 'ping' })).error.code, -32600)
})

test('tools/list: one valid tool per command, generated from the registry', async () => {
  const { tools } = (await createMcpServer().handle(rpc('tools/list'))).result
  assert.equal(tools.length, Object.keys(COMMANDS).length)
  for (const tool of tools) {
    const cmd = COMMANDS[Object.keys(COMMANDS).find((c) => c.replaceAll('-', '_') === tool.name)]
    assert.ok(cmd, tool.name)
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/)
    assert.ok(tool.description.length > 10)
    const s = tool.inputSchema
    assert.equal(s.type, 'object')
    assert.equal(s.additionalProperties, false)
    assert.ok(!('yes' in s.properties), `${tool.name} must not expose yes`)
    for (const r of s.required ?? []) assert.ok(r in s.properties, `${tool.name}: required ${r} missing from properties`)
    for (const [k, p] of Object.entries(s.properties)) assert.ok(p.type, `${tool.name}.${k} needs a type`)
    assert.equal(tool.annotations.readOnlyHint, cmd.risk === 'read')
    if (cmd.risk === 'read') assert.ok(!('confirm_token' in s.properties))
    else assert.ok('confirm_token' in s.properties)
    if (cmd.risk === 'danger') assert.ok(s.required.includes('siteUrl'), `${tool.name} must require siteUrl`)
  }
  const children = tools.find((t) => t.name === 'children').inputSchema
  assert.deepEqual(children.required, ['url'])
  assert.deepEqual(children.properties.http.enum, ['any', '2xx', '3xx', '301', '302', '4xx', '5xx', 'other'])
  assert.deepEqual(tools.find((t) => t.name === 'add_user').inputSchema.required, ['email', 'role', 'siteUrl'])
})

test('--read-only exposes only read tools', () => {
  const tools = mcpTools({ readOnly: true })
  assert.ok(tools.length > 20)
  assert.ok(tools.every((t) => t.annotations.readOnlyHint))
  assert.ok(!tools.some((t) => t.name === 'call' || t.name === 'submit'))
})

test('read tools run directly and truncate long tables', async (t) => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ Date: `/Date(${1696748400000 + i * 864e5})/`, Clicks: i, Impressions: i }))
  const calls = mockFetch(t, { GetRankAndTrafficStats: rows, GetUserSites: [{ Url: SITE, IsVerified: true }] })
  const r = await call(createMcpServer(), 'traffic', { siteUrl: SITE, limit: 5 })
  assert.equal(r.isError, undefined)
  const [json, note] = text(r).split('\n')
  assert.equal(JSON.parse(json).length, 5)
  assert.match(note, /Showing 5 of 150 rows/)
  assert.equal(calls[0].url.searchParams.get('siteUrl'), SITE)
  assert.deepEqual(JSON.parse(text(await call(createMcpServer(), 'sites', {}))), [{ Url: SITE, IsVerified: true }])
})

test('write tools: dry run + confirm_token, then execute only with the token', async (t) => {
  const calls = mockFetch(t, { SubmitFeed: null })
  const server = createMcpServer()
  const args = { siteUrl: SITE, sitemapUrl: `${SITE}sitemap.xml` }

  const first = await call(server, 'add_sitemap', args)
  assert.match(text(first), /DRY RUN \(write\) — nothing has been sent/)
  const token = tokenOf(first)
  assert.ok(token)
  assert.equal(calls.length, 0)

  // Smuggling yes does nothing.
  const sneaky = await call(server, 'add_sitemap', { ...args, yes: true })
  assert.ok(tokenOf(sneaky))
  assert.equal(calls.length, 0)

  // Token is bound to the exact arguments.
  const changed = await call(server, 'add_sitemap', { ...args, sitemapUrl: `${SITE}other.xml`, confirm_token: token })
  assert.equal(changed.isError, true)
  assert.match(text(changed), /differ from the dry run/)
  assert.equal(calls.length, 0)

  const done = await call(server, 'add_sitemap', { ...args, confirm_token: token })
  assert.equal(done.isError, undefined, text(done))
  assert.match(text(done), /SubmitFeed sent and accepted by Bing/)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body, { siteUrl: SITE, feedUrl: `${SITE}sitemap.xml` })

  // Single use.
  const replay = await call(server, 'add_sitemap', { ...args, confirm_token: token })
  assert.equal(replay.isError, true)
  assert.match(text(replay), /invalid, expired or already used/)
  assert.equal(calls.length, 1)
})

test('danger tools require siteUrl and execute the stored plan exactly as previewed', async (t) => {
  process.env.BING_SITE_URL = SITE
  t.after(() => delete process.env.BING_SITE_URL)
  const calls = mockFetch(t, { AddBlockedUrl: null })
  const server = createMcpServer()

  const noSite = await call(server, 'block', { url: `${SITE}private` })
  assert.equal(noSite.isError, true)
  assert.match(text(noSite), /pass siteUrl explicitly/)

  const args = { siteUrl: SITE, url: `${SITE}private`, directory: true }
  const first = await call(server, 'block', args)
  const token = tokenOf(first)
  const planned = server.tokens.get(token).plan.body
  await new Promise((r) => setTimeout(r, 5)) // a re-run would produce a new WCF Date
  await call(server, 'block', { ...args, confirm_token: token })
  assert.equal(calls.length, 1)
  assert.deepStrictEqual(calls[0].body, planned)
  assert.equal(calls[0].body.blockedUrl.EntityType, 1)
})

test('confirm tokens expire after 10 minutes', async (t) => {
  const calls = mockFetch(t, { SubmitFeed: null })
  let clock = 1_000_000
  const server = createMcpServer({ now: () => clock })
  const args = { siteUrl: SITE, sitemapUrl: `${SITE}sitemap.xml` }
  const token = tokenOf(await call(server, 'add_sitemap', args))
  clock += 10 * 60 * 1000 + 1
  const late = await call(server, 'add_sitemap', { ...args, confirm_token: token })
  assert.equal(late.isError, true)
  assert.equal(calls.length, 0)
})

test('batched tools/call items run one at a time and keep their own siteUrl', async (t) => {
  const A = 'https://a.example/'
  const B = 'https://b.example/'
  let first = true
  const calls = mockFetch(t, {
    GetSiteRoles: async (c) => {
      if (first) {
        first = false
        await new Promise((r) => setTimeout(r, 20)) // slow first request: would interleave if run concurrently
      }
      const siteUrl = c.url.searchParams.get('siteUrl')
      return [ROLE(siteUrl, 'owner@x.com', 0), ROLE(siteUrl, 'helper@x.com', 2)]
    },
  })
  const server = createMcpServer()
  const batch = [A, B].map((siteUrl) => rpc('tools/call', { name: 'remove_user', arguments: { email: 'helper@x.com', siteUrl } }))
  const replies = await server.handle(batch)
  assert.equal(replies.length, 2)
  for (const c of calls) assert.ok([A, B].includes(c.url.searchParams.get('siteUrl')))
  const plans = [...server.tokens.values()].map((e) => e.plan.body)
  assert.deepEqual(plans.map((b) => [b.siteUrl, b.siteRole.Site]), [[A, A], [B, B]])
})

const ROLE = (site, email, role) => ({ __type: 'SiteRoles:#Microsoft.Bing.Webmaster.Api', Date: '/Date(1696748400000)/', Email: email, Expired: false, Role: role, Site: site })

test('tool errors come back as isError results, not protocol errors', async (t) => {
  mockFetch(t, { GetCrawlStats: () => new Response(JSON.stringify({ ErrorCode: 14, Message: 'NotAuthorized' }), { status: 400 }) })
  const res = await createMcpServer().handle(rpc('tools/call', { name: 'crawl', arguments: { siteUrl: SITE } }))
  assert.equal(res.error, undefined)
  assert.equal(res.result.isError, true)
  assert.match(text(res.result), /NotAuthorized/)
})

test('call tool: Get* reads directly, other methods need siteUrl + token', async (t) => {
  const calls = mockFetch(t, { GetUrlInfo: { Url: `${SITE}a` }, AddQueryParameter: null })
  const server = createMcpServer()
  const read = await call(server, 'call', { method: 'GetUrlInfo', params: { url: `${SITE}a` }, siteUrl: SITE })
  assert.deepEqual(JSON.parse(text(read)), { Url: `${SITE}a` })
  const noSite = await call(server, 'call', { method: 'AddQueryParameter', params: { queryParameter: 'utm' } })
  assert.equal(noSite.isError, true)
  const args = { method: 'AddQueryParameter', params: { queryParameter: 'utm' }, siteUrl: SITE }
  const token = tokenOf(await call(server, 'call', args))
  assert.ok(token)
  assert.equal(calls.length, 1)
  await call(server, 'call', { ...args, confirm_token: token })
  assert.deepEqual(calls[1].body, { queryParameter: 'utm', siteUrl: SITE })
})

test('stdio: `bing-webmaster mcp` answers initialize + tools/list with no API key', () => {
  const env = { ...process.env }
  delete env.BING_WEBMASTER_API_KEY
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    'not json',
    '',
  ].join('\n')
  const r = spawnSync(process.execPath, [BIN, 'mcp'], { input, env, encoding: 'utf8', timeout: 10000 })
  assert.equal(r.status, 0, r.stderr)
  const messages = r.stdout.trim().split('\n').map((l) => JSON.parse(l)) // every stdout line must be JSON
  assert.equal(messages.length, 3)
  assert.equal(messages[0].id, 1)
  assert.equal(messages[0].result.serverInfo.name, 'bing-webmaster')
  assert.equal(messages[1].id, 2)
  assert.equal(messages[1].result.tools.length, Object.keys(COMMANDS).length)
  assert.equal(messages[2].error.code, -32700)
})

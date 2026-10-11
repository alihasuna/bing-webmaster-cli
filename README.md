# bing-webmaster

[![npm](https://img.shields.io/npm/v/bing-webmaster)](https://www.npmjs.com/package/bing-webmaster) [![test](https://github.com/alihasuna/bing-webmaster-cli/actions/workflows/test.yml/badge.svg)](https://github.com/alihasuna/bing-webmaster-cli/actions/workflows/test.yml) [![license](https://img.shields.io/npm/l/bing-webmaster)](LICENSE)

**The safe way to let AI manage Bing Webmaster Tools.** A command-line tool and a [Model Context Protocol](https://modelcontextprotocol.io) server for Bing's official API. It covers search performance, keyword research, URL, sitemap and IndexNow submission, crawl settings, URL blocks, geo-targeting, users and more. Every API method has a command.

- **Safe by default.** Anything that changes Bing is a dry run until you confirm it. On the command line you confirm with `--yes`. In MCP mode the assistant must call the tool a second time with a one-time `confirm_token`. Risky changes also need the site named explicitly.
- **Works with AI assistants.** `bing-webmaster mcp` turns every command into a tool for Claude Code, Claude Desktop or any other MCP client.
- **Readable commands.** Commands are named for what they do (`queries`, `unblock`, `submit --changed`), not after raw API methods. Guards handle the API's sharp edges for you.
- **Zero dependencies.** One Node.js file (Node 20.12+), including the MCP server.

## Setup

1. In Bing Webmaster Tools, open **Settings → API access → API Key** and generate a key.
2. Provide the key as an environment variable. You can also put it in a `.env` or `.env.local` file in the directory you run from, or in `~/.config/bing-webmaster/.env`:

   ```bash
   BING_WEBMASTER_API_KEY=your-key
   BING_SITE_URL=https://example.com/   # optional default site
   INDEXNOW_KEY=…                       # optional, for IndexNow (see below)
   ```

3. Run it with no install:

   ```bash
   npx bing-webmaster sites
   ```

   Or install it globally to get a `bing-webmaster` command:

   ```bash
   npm install -g bing-webmaster
   ```

Use the site URL exactly as `bing-webmaster sites` prints it. A DNS-verified domain entry such as `https://example.com/` also covers `https://www.example.com/` pages.

## Use it from Claude (MCP)

### Claude Code

```bash
claude mcp add bing-webmaster -e BING_WEBMASTER_API_KEY=your-key -- npx -y bing-webmaster mcp
```

Add `-e BING_SITE_URL=https://example.com/` to set a default site. To give the assistant reports only, with no write tools at all, use `npx -y bing-webmaster mcp --read-only`.

### Claude Desktop

Add the server to `claude_desktop_config.json` (**Settings → Developer → Edit Config**), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "bing-webmaster": {
      "command": "npx",
      "args": ["-y", "bing-webmaster", "mcp"],
      "env": {
        "BING_WEBMASTER_API_KEY": "your-key",
        "BING_SITE_URL": "https://example.com/"
      }
    }
  }
}
```

Other MCP clients (Cursor, VS Code, Windsurf and others) take the same command: `npx -y bing-webmaster mcp`.

### What the assistant can do

You can ask things like *"How did Bing traffic change last month, and which queries drove it?"*, *"Which pages have crawl issues?"* or *"Submit the pages that changed since last week."*

- **Read tools** (`traffic`, `queries`, `issues`, `keyword`, `sitemaps` and the rest) run immediately and return JSON. Long tables are trimmed to `limit` rows (default 100).
- **Write tools** (`submit`, `add_sitemap`, `indexnow` and others) and **danger tools** (`block`, `remove_user`, `crawl_rate` and others) never change anything on the first call. They return the exact request they would send plus a `confirm_token`:

  ```text
  DRY RUN (write) — nothing has been sent.
  POST https://ssl.bing.com/webmaster/api.svc/json/SubmitFeed
  { "siteUrl": "https://example.com/", "feedUrl": "https://example.com/sitemap.xml" }

  confirm_token: 3f9c…
  To apply: show this plan to the user and, only if they approve, call "add_sitemap" again with the same arguments plus confirm_token.
  ```

  The change is sent only when the assistant calls the same tool again with **identical arguments** and that token. The server then sends the stored plan exactly as previewed. Tokens are single-use and expire after 10 minutes. Danger tools also require `siteUrl` to be passed explicitly, so a default site is never changed by accident.

- Tools carry MCP `readOnlyHint` and `destructiveHint` annotations, so clients can treat read and write tools differently.

> **What the token is, and isn't.** The two-step token guarantees that the assistant has seen the full plan before anything is sent, and that the request sent is the one it saw. It is not an authentication layer. Your MCP client's own tool-approval prompt is still where you say yes, so keep approvals on for write tools. For an assistant that only reports, use `--read-only`.

## Command line

```bash
bing-webmaster sites                                    # sites on your account
bing-webmaster summary --site https://example.com/      # one-screen health check
bing-webmaster queries --site https://example.com/      # top search queries
bing-webmaster queries --csv > queries.csv              # export for a spreadsheet
bing-webmaster keyword "standing desk" --country us     # Bing search volume
bing-webmaster submit https://example.com/new-page      # dry run: shows the request
bing-webmaster submit https://example.com/new-page --yes   # sends it
bing-webmaster help                                     # every command
```

### Submit only what changed

```bash
bing-webmaster submit --sitemap --changed --yes
```

This reads your sitemap (sitemap indexes and `.gz` files are followed). It picks the URLs whose `<lastmod>` is newer than the last successful run and submits them, newest first, capped at the URL quota you have left today. URLs over the cap are carried over to the next run. Run it daily from cron or CI and your quota goes to pages that actually changed.

- State is stored per site in `~/.config/bing-webmaster/state.json` (or `$XDG_CONFIG_HOME/bing-webmaster/`). It is written only after a successful `--yes`, never on a dry run.
- The first run (no state yet) treats every URL as changed.
- After that, URLs without a `<lastmod>` are skipped and counted in the output.
- A date-only `<lastmod>` (`2026-10-10`) is compared by day, so a page edited later on the day of the last run is still picked up.
- Pass a sitemap URL to use one other than `<site>/sitemap.xml`: `--sitemap https://example.com/sitemap-posts.xml`.

### IndexNow

[IndexNow](https://www.indexnow.org) notifies Bing and other participating search engines instantly. It has no daily quota and does not use your Bing API key.

```bash
bing-webmaster indexnow-key --site https://example.com/       # generates a key, shows where to host it
# host the key file at https://example.com/<key>.txt, then set INDEXNOW_KEY=<key>
bing-webmaster indexnow https://example.com/a https://example.com/b       # dry run
bing-webmaster indexnow --sitemap --changed --site https://example.com/ --yes
```

`indexnow-key --out public/` writes the key file for you. Use `--key-location <url>` (or `INDEXNOW_KEY_LOCATION`) if the key file isn't at the site root. All URLs in one request must share a host. `indexnow --changed` keeps its own state, separate from `submit --changed`.

## Commands

`read` runs immediately. `write` is a dry run unless `--yes`. `danger` is a dry run unless `--yes` **and** needs an explicit `--site`. In MCP, tool names use underscores (`add-sitemap` → `add_sitemap`).

| Area | Command | Risk |
|---|---|---|
| Overview | `summary`, `sites` | read |
| Search performance | `traffic`, `queries`, `pages`, `query-pages <query>`, `page-queries <url>`, `query-page-detail <query> <url>`, `query-traffic <query>` | read |
| Keyword research | `keyword <phrase>`, `keyword-stats <phrase>`, `related-keywords <phrase>` (`--country`, `--lang`, `--from`, `--to`) | read |
| Index & crawl | `crawl`, `issues`, `url <url>`, `url-traffic <url>`, `children <url>`, `children-traffic <url>`, `crawl-settings`, `fetched`, `fetched-details <url>` | read |
| Sitemaps & submission | `sitemaps`, `sitemap-details <url>`, `quota` | read |
| | `submit <url…>` or `submit --sitemap [url] [--changed]` (capped at your quota), `submit-content <url>`, `add-sitemap <url>`, `fetch <url>` | write |
| | `remove-sitemap <url>` | danger |
| IndexNow | `indexnow-key [--out <dir>]` | read (local) |
| | `indexnow <url…>` or `indexnow --sitemap [url] [--changed]` | write |
| Links | `links`, `url-links <url>`, `connected` | read |
| | `add-connected <url>` | write |
| Sites & users | `roles` | read |
| | `add-site <url>`, `verify-site` | write |
| | `remove-site <url>`, `add-user <email> --role admin\|readwrite\|readonly`, `remove-user <email>` | danger |
| Configuration | `blocked`, `preview-blocks`, `params`, `geo` | read |
| | `crawl-rate [--rate 1-10 \| --hours h0,…,h23] [--boost on\|off]`, `block <url> [--directory] [--cache-only]`, `unblock <url>`, `preview-block <url> --reason <n>`, `preview-unblock <url>`, `add-param <name>`, `remove-param <name>`, `toggle-param <name> on\|off`, `add-geo <url> <CC>`, `remove-geo <url>` | danger |
| Advanced | `call <Method> [key=value…] [--body '{json}']`: any API method. `Get*` methods are reads; everything else is treated as danger. | varies |
| AI assistants | `mcp [--read-only]`: MCP server on stdio | — |

Common options: `--site <url>`, `--limit <n>`, `--json`, `--csv`, `--raw`, `--yes`, `--page <n>`, `--version`.

### Output

- **Table** (default): human-readable, first 25 rows (`--limit` to change).
- **`--json`**: clean JSON, with dates as `YYYY-MM-DD` and Bing's `__type` fields removed.
- **`--csv`**: every row of a table read, as RFC 4180 CSV. Nested values are written as JSON. Add `--limit` to cut it short.
- **`--raw`**: JSON exactly as Bing returned it.

### Built-in guards

- Writes print the exact method and JSON body they would send, and send nothing without `--yes` (or a `confirm_token` in MCP).
- Danger commands need `--site` (or `siteUrl` in MCP) even when `BING_SITE_URL` is set.
- `crawl-rate` reads the current settings, applies your change and shows a before/after.
- `unblock`, `remove-geo` and `remove-user` look up the exact record Bing stored and send it back, which is what those API methods require.
- `remove-user` refuses to remove the last Administrator on a site.
- `submit` checks your remaining quota and splits more than 500 URLs into several batches, Bing's limit per request.

## Why this one

Other good tools cover the Bing Webmaster API. The npm package [`bing-webmaster-cli`](https://www.npmjs.com/package/bing-webmaster-cli) maps commands closely to the raw API method names. Several MCP servers expose Bing Webmaster Tools to assistants, some alongside Google Search Console. If you want one server for both Google and Bing, one of those may suit you better.

Pick this one if you care about:

- **Safety when an AI is driving.** Writes are dry runs by default in both the CLI and MCP mode. MCP writes need a second, token-confirmed call that sends exactly the previewed request. Destructive changes need the site named explicitly. `--read-only` removes write tools entirely.
- **Friendly commands with the sharp edges handled.** Removals echo back Bing's raw records, `crawl-rate` does read-modify-write, the last admin can't be removed, and errors explain what to check (for example, whether the site is on your account).
- **Submission that respects your quota.** `--changed` submits only what changed and carries over what didn't fit. IndexNow is built in for everything else.
- **Nothing to install or audit.** One file with zero dependencies: the CLI and the MCP server together.

## Known API limitations

- `site-moves` / `site-move`: Bing currently returns 404 for these endpoints. Use the Site Move tool in the dashboard.
- `preview-block --reason`: Bing does not publish the `BlockReason` values.
- Obsolete deep-link methods are not wrapped. Use `call` if you need them.
- Dashboard-only features such as Site Scan, SEO recommendations and AI performance reports have no API.
- A newly added or imported site may return empty traffic and crawl reports for a few days.
- The API returns HTTP 400 `NotAuthorized` for a site that is not on your account.
- `RemoveSite` and `AddConnectedPage` silently succeed for sites that are not on your account (no-ops).

## How it talks to Bing

- **Bing Webmaster API:** `https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=…`. Reads are GET with query parameters. Writes are POST with a JSON body keyed by the API's parameter names. Dates in request bodies use the WCF `/Date(ms)/` format. Keyword methods take plain `YYYY-MM-DD` dates. See Microsoft's [IWebmasterApi reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi?view=bing-webmaster-dotnet).
- **IndexNow:** POST to `https://api.indexnow.org/indexnow` with `{ host, key, keyLocation?, urlList }`, up to 10,000 URLs per request.
- **MCP:** JSON-RPC 2.0 over stdio, one message per line (`initialize`, `ping`, `tools/list`, `tools/call`).

Your API key grants full access to every site on your Bing account. Keep it out of version control. `.env` files are already in `.gitignore`.

## Development

```bash
npm test        # node --test: mocked fetch, no network, no API key needed
```

## License

MIT

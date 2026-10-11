# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-10-10

### Added

- **MCP server mode.** `bing-webmaster mcp` runs a stdio [Model Context Protocol](https://modelcontextprotocol.io) server with no dependencies, so Claude Code, Claude Desktop and other MCP clients can use Bing Webmaster Tools. Every command becomes a tool, and each tool's input schema is generated from the command registry.
  - Read tools run immediately. Long tables are trimmed to `limit` rows (default 100).
  - Write and danger tools never send anything on the first call. They return the dry-run plan and a single-use `confirm_token`, which expires after 10 minutes. The change is sent only when the same tool is called again with identical arguments plus the token. The server sends the stored plan exactly as it was previewed.
  - Danger tools also require an explicit `siteUrl`.
  - `--read-only` exposes read tools only.
  - Tool annotations (`readOnlyHint` and `destructiveHint`) reflect each command's risk level.
- **Changed-only submission.** `submit --sitemap --changed` submits only URLs whose `<lastmod>` is newer than the last successful run. URLs are capped at the remaining URL quota from `GetUrlSubmissionQuota` and sent newest first. URLs over the cap carry over to the next run. State is kept per site in `~/.config/bing-webmaster/state.json` and is written only after a successful `--yes`.
- **IndexNow.**
  - `indexnow-key` generates a key and shows the key file to host at `/<key>.txt`. Add `--out <dir>` to write the file.
  - `indexnow <url…>` and `indexnow --sitemap [--changed]` notify api.indexnow.org. They are a dry run unless `--yes`, and read `INDEXNOW_KEY` from the environment or `.env`.
- **CSV output.** `--csv` works on any table read. The header is the union of all keys, values are quoted per RFC 4180, and nested values are written as JSON.
- `--version` shows the installed version. `~/.config/bing-webmaster/.env` is now read as a fallback env file, which helps MCP clients that launch the server from another directory.
- Test suite (`node --test`, mocked `fetch`, no network) and GitHub Actions CI on Node 20.12, 20 and 22.

### Changed

- Sitemap reading follows sitemap indexes and `.gz` sitemaps, and decodes XML entities. Plain `submit --sitemap` previously sent child sitemap URLs as if they were pages.
- Batches of more than 500 URLs are split into several `SubmitUrlBatch` requests, because Bing accepts at most 500 per request.
- The URL cap now uses the smaller of the daily and monthly quota left.
- Keyword `--from` / `--to` are checked to be `YYYY-MM-DD` before anything is sent.
- `BING_WEBMASTER_API_KEY` is only required when a command actually calls Bing. `help`, `mcp`, `indexnow-key` and `indexnow` work without it.

### Fixed

- `call <Method>` (POST / non-`Get*` methods) now adds `siteUrl` to the request body when a site is set, as the help text always said it would.

## 1.0.0 — 2026-10-10

- First public release: every Bing Webmaster API method as a command, with dry-run-by-default writes and a danger tier that requires an explicit `--site`.

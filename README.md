# bing-webmaster

[![npm](https://img.shields.io/npm/v/bing-webmaster)](https://www.npmjs.com/package/bing-webmaster) [![license](https://img.shields.io/npm/l/bing-webmaster)](LICENSE)

Command-line control of [Bing Webmaster Tools](https://www.bing.com/webmasters) through its official API: search performance, keyword research, URL and sitemap submission, crawl settings, URL blocks, geo-targeting, users and more. Every API method has a command.

- **Zero dependencies.** One Node.js file (Node 20.12+).
- **Safe by default.** Anything that changes Bing is a dry run until you add `--yes`. Risky changes also need an explicit `--site`.
- **Scriptable.** `--json` on any read gives clean JSON (dates as `YYYY-MM-DD`) for spreadsheets and pipelines.

## Setup

1. In Bing Webmaster Tools, open **Settings → API access → API Key** and generate a key.
2. Provide it as an environment variable, or put it in a `.env` / `.env.local` file in the directory you run from:

   ```bash
   BING_WEBMASTER_API_KEY=your-key
   BING_SITE_URL=https://example.com/   # optional default site
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

## Quick start

```bash
bing-webmaster sites                                    # sites on your account
bing-webmaster summary --site https://example.com/      # one-screen health check
bing-webmaster queries --site https://example.com/      # top search queries
bing-webmaster keyword "standing desk" --country us     # Bing search volume
bing-webmaster submit https://example.com/new-page      # dry run: shows the request
bing-webmaster submit https://example.com/new-page --yes   # sends it
bing-webmaster help                                     # every command
```

## Commands

`read` runs immediately. `write` is a dry run unless `--yes`. `danger` is a dry run unless `--yes` **and** needs an explicit `--site`.

| Area | Command | Risk |
|---|---|---|
| Overview | `summary`, `sites` | read |
| Search performance | `traffic`, `queries`, `pages`, `query-pages <query>`, `page-queries <url>`, `query-page-detail <query> <url>`, `query-traffic <query>` | read |
| Keyword research | `keyword <phrase>`, `keyword-stats <phrase>`, `related-keywords <phrase>` (`--country`, `--lang`, `--from`, `--to`) | read |
| Index & crawl | `crawl`, `issues`, `url <url>`, `url-traffic <url>`, `children <url>`, `children-traffic <url>`, `crawl-settings`, `fetched`, `fetched-details <url>` | read |
| Sitemaps & submission | `sitemaps`, `sitemap-details <url>`, `quota` | read |
| | `submit <url…>` or `submit --sitemap [url]` (capped at your daily quota), `submit-content <url>`, `add-sitemap <url>`, `fetch <url>` | write |
| | `remove-sitemap <url>` | danger |
| Links | `links`, `url-links <url>`, `connected` | read |
| | `add-connected <url>` | write |
| Sites & users | `roles` | read |
| | `add-site <url>`, `verify-site` | write |
| | `remove-site <url>`, `add-user <email> --role admin\|readwrite\|readonly`, `remove-user <email>` | danger |
| Configuration | `blocked`, `preview-blocks`, `params`, `geo` | read |
| | `crawl-rate [--rate 1-10 \| --hours h0,…,h23] [--boost on\|off]`, `block <url> [--directory] [--cache-only]`, `unblock <url>`, `preview-block <url> --reason <n>`, `preview-unblock <url>`, `add-param <name>`, `remove-param <name>`, `toggle-param <name> on\|off`, `add-geo <url> <CC>`, `remove-geo <url>` | danger |
| Advanced | `call <Method> [key=value…] [--body '{json}']`: any API method. `Get*` methods are reads; everything else is treated as danger. | varies |

Common options: `--site <url>`, `--limit <n>`, `--json`, `--raw`, `--yes`, `--page <n>`.

### Built-in guards

- Writes print the exact method and JSON body they would send, and send nothing without `--yes`.
- `crawl-rate` reads the current settings, applies your change and shows a before/after.
- `unblock`, `remove-geo` and `remove-user` look up the exact record Bing stored and send it back, which is what those API methods require.
- `remove-user` refuses to remove the last Administrator on a site.

## Known API limitations

- `site-moves` / `site-move`: Bing currently returns 404 for these endpoints. Use the Site Move tool in the dashboard.
- `preview-block --reason`: Bing does not publish the `BlockReason` values.
- Obsolete deep-link methods are not wrapped. Use `call` if you need them.
- Dashboard-only features such as Site Scan, SEO recommendations and AI performance reports have no API.
- A newly added or imported site may return empty traffic and crawl reports for a few days.
- The API returns HTTP 400 `NotAuthorized` for a site that is not on your account.
- `RemoveSite` and `AddConnectedPage` silently succeed for sites that are not on your account (no-ops).

## How it talks to Bing

`https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=…`. Reads are GET with query parameters. Writes are POST with a JSON body keyed by the API's parameter names. Dates in request bodies use the WCF `/Date(ms)/` format. Keyword methods take plain `YYYY-MM-DD` dates. See Microsoft's [IWebmasterApi reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi?view=bing-webmaster-dotnet).

Your API key grants full access to every site on your Bing account. Keep it out of version control. `.env` files are already in `.gitignore`.

## License

MIT

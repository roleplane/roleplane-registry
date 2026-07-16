# Browse site

The public catalog site, generated from the built `index.json` and served from Cloudflare Pages. It is fully static and self-contained: inline styles and script, no analytics, no cookies, and no requests beyond the site's own assets.

## Pages

- `index.html` — the full catalog with client-side search (name, tag, description) and author/tag filters.
- `authors/<author>/index.html` — that Author's entries.
- `index.json` — the built index, served alongside the pages so clients can fetch the same shape from the site or the registry container.

Every card shows the entry's description, Author (linking to their page), latest version, the exact install command (`roleplane skill add <repo>/<path>`), and the full version history. The `installs` count renders only when present in the index — the deferred download counter populates it later with no site change.

## Building

```
npm run build        # entries/ → index.json
npm run build:site   # index.json → dist/site
```

`src/build-site.ts` splits the work at a tested seam: `buildSiteData` (index JSON → page data, golden-file tested against `tests/fixtures/expected-site-data.json`) and `renderSite` (page data → HTML pages).

## Deploying

`.github/workflows/deploy-site.yml` deploys `dist/site` to the `roleplane-registry` Cloudflare Pages project on every push to `main`, via `wrangler pages deploy`. It needs two repo secrets: `CLOUDFLARE_API_TOKEN` (a token with Pages edit permission) and `CLOUDFLARE_ACCOUNT_ID`.

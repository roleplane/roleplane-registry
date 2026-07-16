# Browse site

The public catalog site, generated from the built `index.json` and served from Cloudflare Pages. It is fully static and self-contained: inline styles and script, no analytics, no cookies, and no requests beyond the site's own assets.

## Pages

- `index.html` — the full catalog with client-side search (name, tag, description) and author/tag filters.
- `authors/<author>/index.html` — that Author's entries.
- `index.json` — the built index, served alongside the pages so clients can fetch the same shape from the site or the registry container.

Every card shows the entry's description, Author (linking to their page), latest version, the exact install command (`roleplane skill add <repo>/<path>`), and the full version history. The `installs` count renders only when present in the index — the deferred install counter populates it later with no site change.

## Building

```
npm run build        # entries/ → index.json
npm run build:site   # index.json → dist/site
```

`src/build-site.ts` splits the work at a tested seam: `buildSiteData` (index JSON → page data, golden-file tested against `tests/fixtures/expected-site-data.json`) and `renderSite` (page data → HTML pages).

## Deploying

`.github/workflows/deploy-site.yml` deploys `dist/site` to the `roleplane-registry` Cloudflare Pages project on every push to `main`, via `wrangler pages deploy`.

### One-time Cloudflare setup

1. **Account ID** — Cloudflare dashboard → any zone (or Workers & Pages) → the right-hand sidebar shows *Account ID*. Copy it.
2. **API token** — dashboard → My Profile → API Tokens → *Create Token* → *Create Custom Token* with permission **Account → Cloudflare Pages → Edit**, scoped to your account. Copy the token (shown once).
3. **Create the Pages project** (once, from a machine with the token):

   ```
   export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account-id>
   npx wrangler pages project create roleplane-registry --production-branch main
   ```

   Do **not** connect the project to the GitHub repo in the dashboard — deploys come from the workflow (Direct Upload), and connecting git would create a competing build.
4. **GitHub repo secrets** — repo → Settings → Secrets and variables → Actions → add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or:

   ```
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set CLOUDFLARE_ACCOUNT_ID
   ```

After that, every merge to `main` deploys automatically to `https://roleplane-registry.pages.dev` (add a custom domain in the Pages project settings if wanted). To verify or deploy manually:

```
npm run build && npm run build:site
npx wrangler pages deploy dist/site --project-name roleplane-registry
```

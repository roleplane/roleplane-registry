# Publish app

The publish flow lets an Author publish a Skill without touching git: log in
with GitHub, fill the form on `/publish/`, and the app — using **the author's
own token** — commits the skill file to a `roleplane-skills` repo under their
account and opens the index-entry PR against this registry **as the author**.
Attribution is the PR authorship, unforgeable.

Teams publish **by pointer** (no web builder): the same page takes a repo +
path to an existing team directory, and `/publish-team` opens the index-entry
PR (kind=team) pinned to the repo's current default-branch SHA. Nothing is
written to the author's repo; deep validation stays in CI at the pinned SHA.

## Statelessness

The functions are stateless and public-source, with no data at rest:

- The OAuth **client secret** is the only server-side secret.
- The author's token lives only in a short-lived (30 min) HttpOnly cookie on
  their own browser and is **cleared after the publish request** — never
  logged, stored, or forwarded anywhere but api.github.com.
- No database, no session store, no analytics.

## Pieces

- `src/publish.ts` — the handlers, framework-agnostic (Request in → Response
  out, GitHub reached only through an injected `fetch`). This is the tested
  seam: `tests/publish.test.ts` scripts a fake GitHub API and asserts the
  exact calls out (repo create, skill commit, fork, branch, entry commit, PR).
- `functions/` — thin Cloudflare Pages Functions wrappers:
  `/auth/login` (redirect to GitHub authorize, CSRF state cookie),
  `/auth/callback` (code→token exchange, sets the token cookie),
  `/publish` (the Skill form handler), `/publish-team` (Team by pointer).
- `publish/index.html` — the static form, rendered by `src/build-site.ts`
  with the rest of the site. Plain link to log in, plain form POST to
  publish; no client-side requests.

## What a publish does, as the author

1. `GET /user` — who is publishing.
2. Ensure `author/roleplane-skills` exists (create it if not).
3. `PUT` the skill file at `skills/<name>.md` (frontmatter `name` +
   `description`, body below) — the returned commit SHA is the pin.
4. Read the existing index entry, if any — a re-pin appends to its history.
5. Fork the registry, branch from `main`, commit
   `entries/<author>/<name>.json`, open the PR `author:branch → main`.

The PR then runs through the normal CI gates (`validate-entry`) and is merged
editorially by the maintainer.

## One-time setup

1. **GitHub OAuth app** — github.com → Settings → Developer settings → OAuth
   Apps → New. Homepage `https://roleplane-registry.pages.dev`, callback URL
   `https://roleplane-registry.pages.dev/auth/callback`. Scope requested at
   login is `public_repo`.
2. **Pages env vars** — Cloudflare dashboard → the `roleplane-registry` Pages
   project → Settings → Environment variables: set `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET` (secret). Optional `REGISTRY_REPO` overrides the
   default `roleplane/roleplane-registry` (useful for a staging registry).
3. Deploys are unchanged: `wrangler pages deploy dist/site` from the repo
   root also uploads the `functions/` directory it finds there.

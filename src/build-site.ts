import type { Index, IndexEntry, Pin } from "./build-index.ts";
import { esc } from "./html.ts";

export interface SiteEntry {
    key: string;
    author: string;
    name: string;
    kind: "skill" | "team";
    repo: string;
    path: string;
    description: string;
    tags: string[];
    installCommand: string;
    latestVersion: string;
    history: Pin[];
    installs?: number;
}

export interface SiteData {
    entries: SiteEntry[];
    authors: string[];
    tags: string[];
}

/**
 * Turn the built index into the page data the browse site renders from:
 * one flat entry list (sorted by key) plus the author and tag vocabularies.
 */
export function buildSiteData(index: Index): SiteData {
    const entries = Object.entries(index.entries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => siteEntry(key, entry));
    const authors = [...new Set(entries.map((e) => e.author))].sort();
    const tags = [...new Set(entries.flatMap((e) => e.tags))].sort();
    return { entries, authors, tags };
}

function siteEntry(key: string, entry: IndexEntry): SiteEntry {
    if (entry.history.length === 0)
        throw new Error(`${key}: history must contain at least one pin`);
    const [author, name] = key.split("/");
    return {
        key,
        author,
        name,
        kind: entry.kind,
        repo: entry.repo,
        path: entry.path,
        description: entry.description,
        tags: entry.tags,
        installCommand: `roleplane skill add ${entry.repo}/${entry.path}`,
        latestVersion: entry.history[entry.history.length - 1].version,
        history: entry.history,
        ...(entry.installs !== undefined ? { installs: entry.installs } : {}),
    };
}

/**
 * Render the static site: `index.html` (full catalog with client-side
 * search/filter) and one page per Author. Pages are self-contained —
 * inline styles and script, no external requests.
 */
export function renderSite(data: SiteData): Record<string, string> {
    const pages: Record<string, string> = {
        "index.html": page(
            "Roleplane Registry",
            "",
            `<p><a href="publish/index.html">Publish a skill &rarr;</a></p>
${searchControls(data)}
<main id="catalog">
${data.entries.map((e) => card(e, "")).join("\n")}
</main>
${filterScript()}`,
        ),
        "publish/index.html": publishPage(),
    };
    for (const author of data.authors) {
        const own = data.entries.filter((e) => e.author === author);
        pages[`authors/${author}/index.html`] = page(
            `${author} — Roleplane Registry`,
            "../../",
            `<p><a href="../../index.html">&larr; All entries</a></p>
<h2>${esc(author)}</h2>
<main>
${own.map((e) => card(e, "../../")).join("\n")}
</main>`,
        );
    }
    return pages;
}

function card(e: SiteEntry, root: string): string {
    const haystack = [e.key, e.description, ...e.tags].join(" ").toLowerCase();
    return `<article class="card" data-author="${esc(e.author)}" data-tags="${esc(e.tags.join(" "))}" data-search="${esc(haystack)}">
  <header>
    <h3>${esc(e.name)} <span class="kind">${e.kind}</span></h3>
    <p class="byline">by <a href="${root}authors/${esc(e.author)}/index.html">${esc(e.author)}</a> &middot; v${esc(e.latestVersion)}${e.installs !== undefined ? ` &middot; ${e.installs} installs` : ""}</p>
  </header>
  <p>${esc(e.description)}</p>
  <p class="tags">${e.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</p>
  <pre class="install"><code>${esc(e.installCommand)}</code></pre>
  <details>
    <summary>Version history</summary>
    <ul>
${e.history.map((p) => `      <li><code>${esc(p.version)}</code> &mdash; <code>${esc(p.sha)}</code></li>`).join("\n")}
    </ul>
  </details>
</article>`;
}

/**
 * The Skill publish form. Static like everything else: logging in is a plain
 * link to the /auth/login Function, and the form is a plain POST to the
 * /publish Function — no client-side requests.
 */
function publishPage(): string {
    return page(
        "Publish — Roleplane Registry",
        "../",
        `<p><a href="../index.html">&larr; All entries</a></p>
<h2>Publish a Skill</h2>
<p>Publishing commits the skill file to a <code>roleplane-skills</code> repo under <em>your</em> GitHub account and opens the index-entry PR as you — attribution is the PR authorship. The registry stores nothing: your token lives only in a short-lived cookie and is discarded after use.</p>
<p><a class="login" href="/auth/login">Log in with GitHub</a> first, then fill in the form.</p>
<form action="/publish" method="post" class="publish-form">
  <label>Name<br><input name="name" required pattern="[a-z0-9][a-z0-9-]*" placeholder="elevator-pitch"></label>
  <label>Description<br><input name="description" required placeholder="What the skill does, in one line"></label>
  <label>Tags (comma-separated)<br><input name="tags" placeholder="tone, writing"></label>
  <label>Version<br><input name="version" required value="0.1.0"></label>
  <label>Skill body (markdown instructions)<br><textarea name="body" required rows="12" placeholder="The instructions an agent follows when this skill is active."></textarea></label>
  <button type="submit">Publish</button>
</form>
<h2>Publish a Team by pointer</h2>
<p>Teams stay authored in your own Workspace. Point at an existing team directory in your repo and the app opens the index-entry PR as you, pinned to the repo's current SHA. Deep validation happens in CI.</p>
<details class="team-help">
  <summary>What does a team repo look like?</summary>
  <pre>teams/&lt;your-team&gt;/
├── config.yaml    # schema, name, description, jobs
├── agents/        # one markdown file per Agent
└── skills/        # the Skills those Agents use</pre>
  <ol>
    <li>No repo yet? Use the button below to Scaffold one from <a href="https://github.com/roleplane/team-template">roleplane/team-template</a>.</li>
    <li>Clone it and edit the team in your own Workspace, then push.</li>
    <li>Paste the directory URL here, e.g. <code>github.com/you/roleplane-teams/tree/main/teams/your-team</code></li>
  </ol>
</details>
<form action="/scaffold-team" method="post" class="publish-form">
  <button type="submit">Create a team repo for me</button>
</form>
<form action="/publish-team" method="post" class="publish-form">
  <label>Team directory URL<br><input name="url" required placeholder="https://github.com/you/agent-stuff/tree/main/teams/growth"></label>
  <label>Name (optional — derived from the directory name if left blank)<br><input name="name" pattern="[a-z0-9][a-z0-9-]*" placeholder="growth-team"></label>
  <label>Description<br><input name="description" required placeholder="What the team does, in one line"></label>
  <label>Tags (comma-separated)<br><input name="tags" placeholder="growth, marketing"></label>
  <label>Version<br><input name="version" required value="1.0.0"></label>
  <button type="submit">Publish team</button>
</form>`,
    );
}

function searchControls(data: SiteData): string {
    const option = (value: string): string =>
        `<option value="${esc(value)}">${esc(value)}</option>`;
    return `<form id="filters">
  <input id="q" type="search" placeholder="Search by name, tag, or description" aria-label="Search">
  <select id="author" aria-label="Filter by author"><option value="">All authors</option>${data.authors.map(option).join("")}</select>
  <select id="tag" aria-label="Filter by tag"><option value="">All tags</option>${data.tags.map(option).join("")}</select>
</form>`;
}

function filterScript(): string {
    return `<script>
(function () {
  var q = document.getElementById("q");
  var author = document.getElementById("author");
  var tag = document.getElementById("tag");
  function apply() {
    var needle = q.value.trim().toLowerCase();
    document.querySelectorAll("#catalog .card").forEach(function (card) {
      var show =
        (!needle || card.dataset.search.indexOf(needle) !== -1) &&
        (!author.value || card.dataset.author === author.value) &&
        (!tag.value || card.dataset.tags.split(" ").indexOf(tag.value) !== -1);
      card.style.display = show ? "" : "none";
    });
  }
  [q, author, tag].forEach(function (el) {
    el.addEventListener("input", apply);
  });
})();
</script>`;
}

function page(title: string, root: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 1rem; line-height: 1.5; }
h1 a { color: inherit; text-decoration: none; }
#filters { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; }
#filters input, #filters select { padding: 0.4rem; }
#q { flex: 1; min-width: 12rem; }
.card { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
.card h3 { margin: 0; }
.kind, .tag { font-size: 0.75rem; border: 1px solid currentColor; border-radius: 999px; padding: 0.05rem 0.5rem; }
.byline { margin: 0.25rem 0; opacity: 0.8; }
.install { overflow-x: auto; padding: 0.5rem; border-radius: 6px; background: color-mix(in srgb, currentColor 10%, transparent); }
.publish-form label { display: block; margin: 0.75rem 0; }
.publish-form input, .publish-form textarea { width: 100%; padding: 0.4rem; box-sizing: border-box; font: inherit; }
.publish-form button { padding: 0.5rem 1.25rem; }
</style>
</head>
<body>
<h1><a href="${root}index.html">Roleplane Registry</a></h1>
${body}
</body>
</html>`;
}

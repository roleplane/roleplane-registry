import type { Index, IndexEntry, Pin } from "./build-index.ts";

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
      `${searchControls(data)}
<main id="catalog">
${data.entries.map((e) => card(e, "")).join("\n")}
</main>
${filterScript()}`,
    ),
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

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
</style>
</head>
<body>
<h1><a href="${root}index.html">Roleplane Registry</a></h1>
${body}
</body>
</html>`;
}

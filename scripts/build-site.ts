import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Index } from "../src/build-index.ts";
import { buildSiteData, renderSite } from "../src/build-site.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "dist", "site");

const index = JSON.parse(
  readFileSync(join(root, "index.json"), "utf8"),
) as Index;
const data = buildSiteData(index);
const pages = renderSite(data);

rmSync(out, { recursive: true, force: true });
for (const [path, html] of Object.entries(pages)) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), html);
}
// The site serves the built index alongside the pages, so clients can fetch
// the same shape from either the site or the registry container.
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");

console.log(
  `site built: ${Object.keys(pages).length} pages, ${data.entries.length} entries → dist/site`,
);

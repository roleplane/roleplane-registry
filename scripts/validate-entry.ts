/**
 * CI entrypoint for the validate-entry gates. Finds the Index Entries a PR
 * adds or changes (relative to BASE_REF), runs validateEntry on each against
 * live GitHub, and reports results as GitHub annotations: errors fail the
 * job, injection-lint warnings surface without failing it.
 *
 * Env: PR_AUTHOR (required), BASE_REF (default origin/main),
 * GITHUB_TOKEN (optional — needed for the collaborator ownership check).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { IndexEntry } from "../src/build-index.ts";
import {
  validateEntry,
  type ContentHost,
  type ValidationResult,
} from "../src/validate-entry.ts";

const prAuthor = process.env.PR_AUTHOR;
if (!prAuthor) {
  console.error("PR_AUTHOR is required");
  process.exit(1);
}
const baseRef = process.env.BASE_REF ?? "origin/main";
const token = process.env.GITHUB_TOKEN;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

const host: ContentHost = {
  async fetchFile(repo, sha, path) {
    // Contents API (not raw.githubusercontent) so private first-party repos
    // resolve with the token; the raw media type returns the file verbatim.
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${sha}`,
      { headers: { ...apiHeaders(), accept: "application/vnd.github.raw" } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fetch ${repo}@${sha}:${path} → ${res.status}`);
    return res.text();
  },
  async listDir(repo, sha, path) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${sha}`,
      { headers: apiHeaders() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`list ${repo}@${sha}:${path} → ${res.status}`);
    const body = (await res.json()) as { name: string }[] | { name: string };
    if (!Array.isArray(body)) return null; // path is a file, not a directory
    return body.map((item) => item.name);
  },
  async authorControlsRepo(author, repo) {
    if (!token) return false; // can't verify → not verified
    const res = await fetch(
      `https://api.github.com/repos/${repo}/collaborators/${author}/permission`,
      { headers: apiHeaders() },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { permission?: string };
    return body.permission === "admin" || body.permission === "write";
  },
};

function apiHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

const isEntryFile = (f: string): boolean =>
  /^entries\/[^/]+\/[^/]+\.json$/.test(f);

const nameStatus = git(
  "diff",
  "--name-status",
  "--no-renames",
  `${baseRef}...HEAD`,
  "--",
  "entries/",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t") as [string, string]);

let failed = false;
for (const [status, file] of nameStatus) {
  if (status === "D" && isEntryFile(file)) {
    failed = true;
    console.log(
      `::error file=${file}::${file} is deleted or renamed — Index Entries are never removed in a Publish PR; removal is a maintainer-only editorial act`,
    );
  }
}

const changed = nameStatus
  .filter(([status, file]) => status !== "D" && isEntryFile(file))
  .map(([, file]) => file);

if (changed.length === 0 && !failed) {
  console.log("No Index Entries changed — nothing to validate.");
  process.exit(0);
}

const existingKeys = git("ls-tree", "-r", "--name-only", baseRef, "--", "entries/")
  .split("\n")
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/^entries\//, "").replace(/\.json$/, ""));

function entryAt(ref: string, file: string): IndexEntry | undefined {
  try {
    return JSON.parse(git("show", `${ref}:${file}`)) as IndexEntry;
  } catch {
    return undefined;
  }
}

const summary: string[] = [];
for (const file of changed) {
  const key = file.replace(/^entries\//, "").replace(/\.json$/, "");
  let result: ValidationResult;
  const entry = entryAt("HEAD", file);
  if (!entry) {
    result = { errors: [`${key}: ${file} is not valid JSON`], warnings: [] };
  } else {
    result = await validateEntry(
      { key, entry, baseEntry: entryAt(baseRef, file), prAuthor, existingKeys },
      host,
    );
  }
  for (const error of result.errors) {
    failed = true;
    console.log(`::error file=${file}::${error}`);
    summary.push(`- ❌ ${error}`);
  }
  for (const warning of result.warnings) {
    console.log(`::warning file=${file}::${warning}`);
    summary.push(`- ⚠️ ${warning}`);
  }
  if (result.errors.length === 0) {
    console.log(`✓ ${key} passed all gates`);
    summary.push(
      `- ✅ ${key}${result.warnings.length > 0 ? " (with lint warnings)" : ""}`,
    );
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## validate-entry\n\n${summary.join("\n")}\n`,
  );
}
process.exit(failed ? 1 : 0);

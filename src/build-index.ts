import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Pin {
  sha: string;
  version: string;
}

export interface IndexEntry {
  kind: "skill" | "team";
  repo: string;
  path: string;
  description: string;
  tags: string[];
  history: Pin[];
  installs?: number;
}

export interface Index {
  schemaVersion: number;
  entries: Record<string, IndexEntry>;
}

/**
 * Build the published index from a directory of source Index Entries laid out
 * as `<entriesDir>/<author>/<name>.json`. The entry key is derived from that
 * layout, never from the file contents.
 */
export function buildIndex(entriesDir: string): Index {
  const entries: Record<string, IndexEntry> = {};

  for (const author of readdirSync(entriesDir).sort()) {
    const authorDir = join(entriesDir, author);
    for (const file of readdirSync(authorDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const key = `${author}/${file.slice(0, -".json".length)}`;
      const entry = JSON.parse(
        readFileSync(join(authorDir, file), "utf8"),
      ) as IndexEntry;
      validateEntry(key, entry);
      entries[key] = entry;
    }
  }

  return { schemaVersion: 1, entries };
}

function validateEntry(key: string, entry: IndexEntry): void {
  const fail = (msg: string): never => {
    throw new Error(`${key}: ${msg}`);
  };
  if (entry.kind !== "skill" && entry.kind !== "team")
    fail(`kind must be "skill" or "team"`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo))
    fail(`repo must look like "owner/repo"`);
  if (!entry.path) fail("path is required");
  if (!entry.description) fail("description is required");
  if (!Array.isArray(entry.tags)) fail("tags must be an array");
  if (!Array.isArray(entry.history) || entry.history.length === 0)
    fail("history must contain at least one {sha, version} pin");
  for (const pin of entry.history) {
    if (!/^[0-9a-f]{40}$/.test(pin.sha))
      fail(`history sha "${pin.sha}" must be a full 40-char commit SHA`);
    if (!pin.version) fail("every history pin needs a version label");
  }
}

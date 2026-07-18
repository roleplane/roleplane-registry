/**
 * Guards the #70 re-pin: the 15 shipped skill entries now resolve out of
 * `skills/roleplane/` in the roleplane repo, their history stayed append-only,
 * and each pinned target still validates against its real content.
 *
 * Content comes from the sibling roleplane checkout via `git show <sha>:<path>`,
 * which is what an installer would fetch from raw.githubusercontent at that SHA.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IndexEntry } from "../src/build-index.ts";
import { validateEntry, type ContentHost } from "../src/validate-entry.ts";

const ENTRY_DIR = new URL("../entries/roleplane/", import.meta.url).pathname;

/**
 * The sibling roleplane checkout the entries point at. Only present in a local
 * side-by-side workspace, so the content-resolution cases skip without it —
 * CI proves the same thing against live GitHub in validate-entry.
 */
const SOURCE_REPO = new URL("../../roleplane/", import.meta.url).pathname;
const hasSource = existsSync(`${SOURCE_REPO}.git`);
const itWithSource = hasSource ? it : it.skip;

const names = readdirSync(ENTRY_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const entries = new Map<string, IndexEntry>(
  names.map((n) => [
    `roleplane/${n}`,
    JSON.parse(readFileSync(`${ENTRY_DIR}${n}.json`, "utf8")) as IndexEntry,
  ]),
);

/** The entry as committed on main, i.e. before this re-pin. */
function baseEntry(name: string): IndexEntry | undefined {
  try {
    return JSON.parse(
      execFileSync(
        "git",
        ["show", `origin/main:entries/roleplane/${name}.json`],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    ) as IndexEntry;
  } catch {
    return undefined;
  }
}

const host: ContentHost = {
  async fetchFile(_repo, sha, path) {
    try {
      return execFileSync("git", ["show", `${sha}:${path}`], {
        encoding: "utf8",
        cwd: SOURCE_REPO,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  },
  async listDir(_repo, sha, path) {
    try {
      const out = execFileSync(
        "git",
        ["ls-tree", "--name-only", sha, `${path}/`],
        {
          encoding: "utf8",
          cwd: SOURCE_REPO,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (!out) return null;
      return out.split("\n").map((p) => p.split("/").pop()!);
    } catch {
      return null;
    }
  },
  async authorControlsRepo() {
    return true;
  },
};

const latest = (e: IndexEntry) => e.history[e.history.length - 1];

describe("roleplane re-pin to skills/roleplane/", () => {
  it("ships exactly the 15 known entries", () => {
    expect(names).toHaveLength(15);
  });

  it("has no kind: team entries left in the index", () => {
    const teams = [...entries].filter(([, e]) => e.kind === "team");
    expect(teams).toEqual([]);
  });

  it.each([...entries.keys()])("%s pins to skills/roleplane/", (key) => {
    const entry = entries.get(key)!;
    expect(entry.path).toMatch(/^skills\/roleplane\/[a-z0-9-]+\.md$/);
  });

  it.each([...entries.keys()])("%s keeps history append-only", (key) => {
    const entry = entries.get(key)!;
    const base = baseEntry(key.split("/")[1]);
    expect(base, "entry must already exist on main").toBeDefined();

    // Every prior pin survives untouched, in order, at the front.
    expect(entry.history.slice(0, base!.history.length)).toEqual(base!.history);
    // The re-pin appended something new.
    expect(entry.history.length).toBe(base!.history.length + 1);
    // Version labels are distinct, so old pins stay addressable.
    const versions = entry.history.map((p) => p.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  itWithSource.each([...entries.keys()])(
    "%s resolves real content at its pinned sha",
    async (key) => {
      const entry = entries.get(key)!;
      const { sha } = latest(entry);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      const content = await host.fetchFile(entry.repo, sha, entry.path);
      expect(content, `${entry.path} missing at ${sha}`).not.toBeNull();
      expect(content).toMatch(/^---\n/);
      expect(content).toContain(
        `name: ${entry.path.split("/").pop()!.replace(/\.md$/, "")}`,
      );
    },
  );

  itWithSource.each([...entries.keys()])(
    "%s validates green at its new pin",
    async (key) => {
      const entry = entries.get(key)!;
      const result = await validateEntry(
        {
          key,
          entry,
          baseEntry: baseEntry(key.split("/")[1]),
          prAuthor: "roleplane",
          existingKeys: [...entries.keys()],
        },
        host,
      );
      expect(result.errors).toEqual([]);
    },
  );

  itWithSource.each([...entries.keys()])(
    "%s keeps its old pin resolvable",
    async (key) => {
      const entry = entries.get(key)!;
      const base = baseEntry(key.split("/")[1])!;
      for (const pin of base.history) {
        const content = await host.fetchFile(entry.repo, pin.sha, base.path);
        expect(
          content,
          `${base.path} unresolvable at ${pin.sha}`,
        ).not.toBeNull();
      }
    },
  );
});

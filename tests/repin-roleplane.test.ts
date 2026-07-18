/**
 * Guards the #70 re-pin: the 15 shipped skill entries resolve out of
 * `skills/roleplane/`, every pin they had before the re-pin survives intact,
 * and both old and new pins still resolve to real content.
 *
 * The pre-re-pin state is a committed fixture, not a `git show` against the
 * base branch. Comparing the tree to its own base only works on an unmerged
 * PR — once merged, base *is* the tree and the check compares against itself.
 * The base-branch comparison is a publish-time gate, and validate-entry.ts
 * already owns it (see its Re-pin gate); this file guards the durable shape.
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
 * CI covers the same ground against live GitHub in validate-entry.
 */
const SOURCE_REPO = new URL("../../roleplane/", import.meta.url).pathname;
const itIfSiblingCheckout = existsSync(`${SOURCE_REPO}.git`) ? it : it.skip;

/** Each skill entry's path and history as of a15e857, immediately before #70. */
const preRepin = JSON.parse(
  readFileSync(
    new URL("./fixtures/pre-repin-skills.json", import.meta.url).pathname,
    "utf8",
  ),
) as Record<string, { path: string; history: IndexEntry["history"] }>;

const entries = new Map<string, IndexEntry>(
  readdirSync(ENTRY_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [
      `roleplane/${f.replace(/\.json$/, "")}`,
      JSON.parse(readFileSync(`${ENTRY_DIR}${f}`, "utf8")) as IndexEntry,
    ]),
);

/**
 * #70 covers the shipped *skill* entries only. The author also publishes
 * agents (pinned under `agents/roleplane/`), which this re-pin leaves alone —
 * so the assertions scope to kind: skill rather than to the whole author
 * namespace, which would otherwise break each time an agent is published.
 */
const skillKeys = [...entries]
  .filter(([, e]) => e.kind === "skill")
  .map(([key]) => key);

/**
 * Retired: the migration renamed *and* rewrote this skill (new description,
 * plus inputs/tools/deliverables), so re-pinning the old key would have shipped
 * different behaviour under a name that no longer matched its content. The key
 * keeps its original pin — still installable, never repointed — and the rewrite
 * ships as roleplane/competitor-scan instead.
 */
const RETIRED = new Set(["roleplane/competitor-analysis"]);

/** Skill entries this re-pin actually moved to skills/roleplane/. */
const repinnedKeys = skillKeys.filter(
  (key) => key in preRepin && !RETIRED.has(key),
);

/** Reads a file from the sibling checkout at a pinned sha, as an installer would. */
function fileAt(sha: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      encoding: "utf8",
      cwd: SOURCE_REPO,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Serves the publish gates from the sibling checkout instead of live GitHub. */
const host: ContentHost = {
  async fetchFile(_repo, sha, path) {
    return fileAt(sha, path);
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
      return out ? out.split("\n").map((p) => p.split("/").pop()!) : null;
    } catch {
      return null;
    }
  },
  async authorControlsRepo() {
    return true;
  },
};

describe("roleplane re-pin to skills/roleplane/", () => {
  it("re-pins the 14 skills that moved, leaving the retired key alone", () => {
    expect(Object.keys(preRepin)).toHaveLength(15);
    expect(repinnedKeys).toHaveLength(14);
    // Every pre-existing skill is either re-pinned or deliberately retired.
    expect([...repinnedKeys, ...RETIRED].sort()).toEqual(
      Object.keys(preRepin).sort(),
    );
  });

  it.each([...RETIRED])("%s keeps its original pin, unrepointed", (key) => {
    const entry = entries.get(key)!;
    expect(entry.path).toBe(preRepin[key].path);
    expect(entry.history).toEqual(preRepin[key].history);
  });

  it("has no kind: team entries left in the index", () => {
    // Deliberately spans every entry, not just skills: the criterion is about
    // the whole index, since a stranded team would strand its members too.
    expect([...entries].filter(([, e]) => e.kind === "team")).toEqual([]);
  });

  it.each(repinnedKeys)("%s pins to skills/roleplane/", (key) => {
    expect(entries.get(key)!.path).toMatch(
      /^skills\/roleplane\/[a-z0-9-]+\.md$/,
    );
  });

  it.each(repinnedKeys)("%s kept every pin it had before the re-pin", (key) => {
    const { history } = entries.get(key)!;
    const before = preRepin[key].history;

    // Prior pins survive untouched, in order, at the front — nothing rewritten.
    expect(history.slice(0, before.length)).toEqual(before);
    // ...and the re-pin appended rather than replaced.
    expect(history.length).toBeGreaterThan(before.length);
    // Distinct version labels, so every past pin stays addressable.
    const versions = history.map((p) => p.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  itIfSiblingCheckout.each(skillKeys)(
    "%s resolves real content at its current pin",
    (key) => {
      const entry = entries.get(key)!;
      const { sha } = entry.history[entry.history.length - 1];
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      const content = fileAt(sha, entry.path);
      expect(content, `${entry.path} missing at ${sha}`).not.toBeNull();
      expect(content).toMatch(/^---\ntype: skill\n/);
      // The installed skill must announce the name it was installed under.
      // Compared against the entry *key*, not the path — deriving both sides
      // from the path is what let the competitor-scan divergence slip through.
      expect(content).toContain(`name: ${key.split("/")[1]}\n`);
    },
  );

  // The retired key is excluded: it is unchanged by this work, so it would
  // never appear in a Publish PR's changed set for the gates to run against.
  itIfSiblingCheckout.each(skillKeys.filter((k) => !RETIRED.has(k)))(
    "%s passes the publish gates at its new pin",
    async (key) => {
      const result = await validateEntry(
        {
          key,
          entry: entries.get(key)!,
          // Undefined for a first publish (competitor-scan); the pre-#70 state
          // otherwise, so the gate sees a genuine re-pin rather than a no-op.
          baseEntry:
            key in preRepin
              ? { ...entries.get(key)!, ...preRepin[key] }
              : undefined,
          prAuthor: "roleplane",
          existingKeys: [...entries.keys()],
        },
        host,
      );
      expect(result.errors).toEqual([]);
    },
  );

  itIfSiblingCheckout.each(Object.keys(preRepin))(
    "%s still resolves every pin it shipped before the re-pin",
    (key) => {
      const { path } = preRepin[key];
      for (const pin of preRepin[key].history) {
        expect(
          fileAt(pin.sha, path),
          `${path} gone at ${pin.sha}`,
        ).not.toBeNull();
      }
    },
  );
});

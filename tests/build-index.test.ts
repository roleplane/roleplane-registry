import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/build-index.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("buildIndex", () => {
  it("builds index.json from a directory of source entries (golden file)", () => {
    const built = buildIndex(join(fixtures, "entries"));
    const expected = JSON.parse(
      readFileSync(join(fixtures, "expected-index.json"), "utf8"),
    );
    expect(built).toEqual(expected);
  });

  it("omits installs when absent and passes it through when present", () => {
    const built = buildIndex(join(fixtures, "entries"));
    expect("installs" in built.entries["roleplane/blog-craft"]).toBe(false);
    expect(built.entries["octocat/growth-team"].installs).toBe(42);
  });

  it("rejects an entry with a malformed history pin", () => {
    expect(() => buildIndex(join(fixtures, "bad-entries"))).toThrow(
      /octocat\/broken.*40-char commit SHA/,
    );
  });

  // Publish PRs add an entry without rebuilding index.json — the rebuild-index
  // workflow refreshes it on main after merge, so PRs skip the drift check.
  it.skipIf(process.env.SKIP_INDEX_DRIFT)(
    "committed index.json matches a rebuild from entries/ (no drift)",
    () => {
      const root = join(import.meta.dirname, "..");
      const committed = JSON.parse(
        readFileSync(join(root, "index.json"), "utf8"),
      );
      expect(buildIndex(join(root, "entries"))).toEqual(committed);
    },
  );
});

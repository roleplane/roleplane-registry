import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Index } from "../src/build-index.ts";
import { buildSiteData, renderSite } from "../src/build-site.ts";

const fixtures = join(import.meta.dirname, "fixtures");

const index = JSON.parse(
  readFileSync(join(fixtures, "expected-index.json"), "utf8"),
) as Index;

describe("buildSiteData", () => {
  it("turns index JSON into page data (golden file)", () => {
    const expected = JSON.parse(
      readFileSync(join(fixtures, "expected-site-data.json"), "utf8"),
    );
    expect(buildSiteData(index)).toEqual(expected);
  });

  it("omits installs when absent and passes it through when present", () => {
    const data = buildSiteData(index);
    const byKey = Object.fromEntries(data.entries.map((e) => [e.key, e]));
    expect("installs" in byKey["roleplane/blog-craft"]).toBe(false);
    expect(byKey["octocat/growth-team"].installs).toBe(42);
  });
});

describe("renderSite", () => {
  const pages = renderSite(buildSiteData(index));

  it("renders the catalog page, one page per author, and the publish page", () => {
    expect(Object.keys(pages).sort()).toEqual([
      "authors/octocat/index.html",
      "authors/roleplane/index.html",
      "index.html",
      "publish/index.html",
    ]);
  });

  it("publish page logs in via /auth/login and posts the form to /publish", () => {
    const publish = pages["publish/index.html"];
    expect(publish).toContain('href="/auth/login"');
    expect(publish).toMatch(/<form[^>]*action="\/publish"[^>]*method="post"/i);
    for (const field of ["name", "description", "tags", "version", "body"]) {
      expect(publish).toContain(`name="${field}"`);
    }
  });

  it("publish page offers a Team-by-pointer form posting to /publish-team", () => {
    const publish = pages["publish/index.html"];
    expect(publish).toMatch(
      /<form[^>]*action="\/publish-team"[^>]*method="post"/i,
    );
    expect(publish).toContain('name="url"');
  });

  it("publish page explains the team repo layout and offers the Scaffold button", () => {
    const publish = pages["publish/index.html"];
    expect(publish).toContain("config.yaml");
    expect(publish).toContain("roleplane/team-template");
    expect(publish).toMatch(
      /<form[^>]*action="\/scaffold-team"[^>]*method="post"/i,
    );
  });

  it("every card shows the exact install command and version history", () => {
    expect(pages["index.html"]).toContain(
      "roleplane skill add octocat/agent-stuff/teams/growth",
    );
    expect(pages["index.html"]).toContain(
      "roleplane skill add roleplane/roleplane/templates/teams/content/skills/blog-craft.md",
    );
    // Full history, oldest first, on the card.
    expect(pages["index.html"]).toMatch(/0\.1\.0[\s\S]*0\.2\.0/);
  });

  it("shows the install count when present and nothing when absent", () => {
    const authorPage = pages["authors/octocat/index.html"];
    expect(authorPage).toContain("42 installs");
    expect(pages["authors/roleplane/index.html"]).not.toMatch(/\d+ installs/);
  });

  it("author pages list only that author's entries", () => {
    expect(pages["authors/octocat/index.html"]).toContain("growth-team");
    expect(pages["authors/octocat/index.html"]).not.toContain("blog-craft");
  });

  it("makes no external requests: no remote scripts, styles, images, or fetches", () => {
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
      expect(html).not.toMatch(/<link\b/i);
      expect(html).not.toMatch(/\bsrc="https?:/i);
      expect(html).not.toMatch(/\bfetch\(/);
    }
  });

  it("escapes HTML in entry fields", () => {
    const hostile: Index = {
      schemaVersion: 1,
      entries: {
        "octocat/xss": {
          kind: "skill",
          repo: "octocat/agent-stuff",
          path: "skills/xss.md",
          description: '<script>alert("hi")</script>',
          tags: ["<b>"],
          history: [
            {
              sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              version: "<img>",
            },
          ],
        },
      },
    };
    const html = renderSite(buildSiteData(hostile))["index.html"];
    expect(html).not.toContain('<script>alert("hi")</script>');
    expect(html).not.toContain("<img>");
  });
});

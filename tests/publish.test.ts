import { describe, expect, it } from "vitest";
import {
  handleCallback,
  handleLogin,
  handlePublish,
  handlePublishTeam,
  type PublishEnv,
} from "../src/publish.ts";

/**
 * A scripted GitHub API: `routes` maps "METHOD url" to a responder, and every
 * request is recorded so tests can assert exactly which calls went out.
 */
function fakeGitHub(
  routes: Record<string, (body: unknown) => { status?: number; json: unknown }>,
) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const route = routes[`${method} ${url}`];
    if (!route) return new Response("not found", { status: 404 });
    const { status = 200, json } = route(body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

function env(fetchFn: typeof fetch): PublishEnv {
  return {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    registryRepo: "roleplane/roleplane-registry",
    fetch: fetchFn,
    sleep: async () => {},
  };
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const fromB64 = (text: string): string =>
  Buffer.from(text, "base64").toString("utf8");

describe("handleLogin", () => {
  it("redirects to GitHub authorize with a state cookie", async () => {
    const res = handleLogin(
      new Request("https://registry.example/auth/login"),
      env(fakeGitHub({}).fetch),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("scope")).toBe("public_repo");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://registry.example/auth/callback",
    );
    const state = location.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(8);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`oauth_state=${state}`);
    expect(cookie).toContain("HttpOnly");
  });
});

describe("handleCallback", () => {
  const callbackRequest = (state: string, cookieState: string) =>
    new Request(
      `https://registry.example/auth/callback?code=abc123&state=${state}`,
      { headers: { cookie: `oauth_state=${cookieState}` } },
    );

  it("exchanges the code for a token and stores it in a short-lived cookie", async () => {
    const github = fakeGitHub({
      "POST https://github.com/login/oauth/access_token": (body) => {
        expect(body).toEqual({
          client_id: "test-client-id",
          client_secret: "test-client-secret",
          code: "abc123",
        });
        return { json: { access_token: "gho_token" } };
      },
    });
    const res = await handleCallback(
      callbackRequest("st4te", "st4te"),
      env(github.fetch),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/publish/");
    const cookies = res.headers.getSetCookie();
    const tokenCookie = cookies.find((c) => c.startsWith("gh_token="))!;
    expect(tokenCookie).toContain("gh_token=gho_token");
    expect(tokenCookie).toContain("HttpOnly");
    expect(tokenCookie).toContain("Secure");
    expect(tokenCookie).toMatch(/Max-Age=(\d+)/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(tokenCookie)![1]);
    expect(maxAge).toBeLessThanOrEqual(3600);
    // The state cookie is cleared.
    expect(cookies.some((c) => c.includes("oauth_state=;"))).toBe(true);
  });

  it("rejects a state mismatch without calling GitHub", async () => {
    const github = fakeGitHub({});
    const res = await handleCallback(
      callbackRequest("evil", "st4te"),
      env(github.fetch),
    );
    expect(res.status).toBe(403);
    expect(github.calls).toEqual([]);
  });

  it("rejects a failed token exchange", async () => {
    const github = fakeGitHub({
      "POST https://github.com/login/oauth/access_token": () => ({
        json: { error: "bad_verification_code" },
      }),
    });
    const res = await handleCallback(
      callbackRequest("st4te", "st4te"),
      env(github.fetch),
    );
    expect(res.status).toBe(502);
  });
});

describe("handlePublish", () => {
  const form = (fields: Record<string, string>) =>
    new Request("https://registry.example/publish", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "gh_token=gho_token",
      },
      body: new URLSearchParams(fields).toString(),
    });

  const payload = {
    name: "uk-english-tone",
    description: "Writes in UK English",
    tags: "tone, writing",
    version: "0.1.0",
    body: "Always write in UK English.",
  };

  const api = "https://api.github.com";
  const commitSha = "a".repeat(40);
  const baseSha = "b".repeat(40);

  function happyPathRoutes(): Record<
    string,
    (body: unknown) => { status?: number; json: unknown }
  > {
    return {
      [`GET ${api}/user`]: () => ({ json: { login: "octocat" } }),
      [`GET ${api}/repos/octocat/roleplane-skills`]: () => ({
        status: 404,
        json: {},
      }),
      [`POST ${api}/user/repos`]: () => ({
        status: 201,
        json: { full_name: "octocat/roleplane-skills" },
      }),
      [`GET ${api}/repos/octocat/roleplane-skills/contents/skills/uk-english-tone.md`]:
        () => ({ status: 404, json: {} }),
      [`PUT ${api}/repos/octocat/roleplane-skills/contents/skills/uk-english-tone.md`]:
        () => ({ status: 201, json: { commit: { sha: commitSha } } }),
      [`POST ${api}/repos/roleplane/roleplane-registry/forks`]: () => ({
        status: 202,
        json: { full_name: "octocat/roleplane-registry" },
      }),
      [`GET ${api}/repos/roleplane/roleplane-registry/git/ref/heads/main`]:
        () => ({ json: { object: { sha: baseSha } } }),
      [`GET ${api}/repos/roleplane/roleplane-registry/contents/entries/octocat/uk-english-tone.json`]:
        () => ({ status: 404, json: {} }),
      [`POST ${api}/repos/octocat/roleplane-registry/git/refs`]: () => ({
        status: 201,
        json: {},
      }),
      [`PUT ${api}/repos/octocat/roleplane-registry/contents/entries/octocat/uk-english-tone.json`]:
        () => ({ status: 201, json: { commit: { sha: "c".repeat(40) } } }),
      [`POST ${api}/repos/roleplane/roleplane-registry/pulls`]: () => ({
        status: 201,
        json: { html_url: "https://github.com/roleplane/roleplane-registry/pull/9" },
      }),
    };
  }

  it("commits the skill under the author's account and opens the PR as the author", async () => {
    const github = fakeGitHub(happyPathRoutes());
    const res = await handlePublish(form(payload), env(github.fetch));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("https://github.com/roleplane/roleplane-registry/pull/9");

    // Skill file: schema-valid frontmatter + body, committed under the author.
    const skillPut = github.calls.find(
      (c) =>
        c.method === "PUT" &&
        c.url.includes("roleplane-skills/contents/skills/uk-english-tone.md"),
    )!;
    const skill = fromB64((skillPut.body as { content: string }).content);
    expect(skill).toContain("name: uk-english-tone");
    expect(skill).toContain('description: "Writes in UK English"');
    expect(skill).toContain("Always write in UK English.");
    expect(skill).toMatch(/^---\n[\s\S]*?\n---\n/);

    // Entry file: correct key path, kind, pinned SHA, version.
    const entryPut = github.calls.find(
      (c) =>
        c.method === "PUT" &&
        c.url.includes("contents/entries/octocat/uk-english-tone.json"),
    )!;
    const entryBody = entryPut.body as { content: string; branch: string };
    const entry = JSON.parse(fromB64(entryBody.content));
    expect(entry).toEqual({
      kind: "skill",
      repo: "octocat/roleplane-skills",
      path: "skills/uk-english-tone.md",
      description: "Writes in UK English",
      tags: ["tone", "writing"],
      history: [{ sha: commitSha, version: "0.1.0" }],
    });

    // Branch on the fork starts from the registry's main.
    const branch = github.calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${api}/repos/octocat/roleplane-registry/git/refs`,
    )!;
    expect(branch.body).toMatchObject({ sha: baseSha });

    // PR opened against the registry from the author's fork branch.
    const pr = github.calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${api}/repos/roleplane/roleplane-registry/pulls`,
    )!;
    expect(pr.body).toMatchObject({
      base: "main",
      head: expect.stringMatching(/^octocat:/),
    });

    // Token cookie is cleared after use — nothing persists server-side.
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("gh_token=;"))).toBe(true);
  });

  it("reuses an existing skills repo without creating one", async () => {
    const routes = happyPathRoutes();
    routes[`GET ${api}/repos/octocat/roleplane-skills`] = () => ({
      json: { full_name: "octocat/roleplane-skills" },
    });
    const github = fakeGitHub(routes);
    const res = await handlePublish(form(payload), env(github.fetch));
    expect(res.status).toBe(200);
    expect(
      github.calls.some((c) => c.method === "POST" && c.url.endsWith("/user/repos")),
    ).toBe(false);
  });

  it("re-pins an existing entry by appending to its history", async () => {
    const routes = happyPathRoutes();
    const existing = {
      kind: "skill",
      repo: "octocat/roleplane-skills",
      path: "skills/uk-english-tone.md",
      description: "Writes in UK English",
      tags: ["tone"],
      history: [{ sha: "d".repeat(40), version: "0.1.0" }],
    };
    routes[
      `GET ${api}/repos/roleplane/roleplane-registry/contents/entries/octocat/uk-english-tone.json`
    ] = () => ({ json: { content: b64(JSON.stringify(existing)), sha: "blobsha" } });
    routes[
      `GET ${api}/repos/octocat/roleplane-skills/contents/skills/uk-english-tone.md`
    ] = () => ({ json: { sha: "oldfilesha" } });
    const github = fakeGitHub(routes);
    const res = await handlePublish(
      form({ ...payload, version: "0.2.0" }),
      env(github.fetch),
    );
    expect(res.status).toBe(200);
    const entryPut = github.calls.find(
      (c) =>
        c.method === "PUT" &&
        c.url.includes("contents/entries/octocat/uk-english-tone.json"),
    )!;
    const entry = JSON.parse(
      fromB64((entryPut.body as { content: string }).content),
    );
    expect(entry.history).toEqual([
      { sha: "d".repeat(40), version: "0.1.0" },
      { sha: commitSha, version: "0.2.0" },
    ]);
    // History preserved: existing pins untouched, description/tags refreshed.
    expect(entry.tags).toEqual(["tone", "writing"]);
  });

  it("YAML-escapes a hostile description in the skill frontmatter", async () => {
    const github = fakeGitHub(happyPathRoutes());
    const hostile = 'colon: hash # quote " [bracket]';
    const res = await handlePublish(
      form({ ...payload, description: hostile }),
      env(github.fetch),
    );
    expect(res.status).toBe(200);
    const skillPut = github.calls.find(
      (c) => c.method === "PUT" && c.url.includes("roleplane-skills/contents"),
    )!;
    const skill = fromB64((skillPut.body as { content: string }).content);
    expect(skill).toContain(`description: ${JSON.stringify(hostile)}`);
  });

  it("rejects a re-pin that reuses a version already in history", async () => {
    const routes = happyPathRoutes();
    routes[
      `GET ${api}/repos/roleplane/roleplane-registry/contents/entries/octocat/uk-english-tone.json`
    ] = () => ({
      json: {
        content: b64(
          JSON.stringify({
            kind: "skill",
            repo: "octocat/roleplane-skills",
            path: "skills/uk-english-tone.md",
            description: "Writes in UK English",
            tags: ["tone"],
            history: [{ sha: "d".repeat(40), version: "0.1.0" }],
          }),
        ),
        sha: "blobsha",
      },
    });
    const github = fakeGitHub(routes);
    const res = await handlePublish(form(payload), env(github.fetch));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("0.1.0");
    // Nothing was committed anywhere — the check runs before any write.
    expect(github.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("retries branch creation while the fresh fork is still populating", async () => {
    const routes = happyPathRoutes();
    let attempts = 0;
    routes[`POST ${api}/repos/octocat/roleplane-registry/git/refs`] = () => {
      attempts += 1;
      return attempts < 3
        ? { status: 404, json: { message: "Not Found" } }
        : { status: 201, json: {} };
    };
    const github = fakeGitHub(routes);
    const res = await handlePublish(form(payload), env(github.fetch));
    expect(res.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("rejects a request without a token cookie", async () => {
    const github = fakeGitHub({});
    const req = new Request("https://registry.example/publish", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload).toString(),
    });
    const res = await handlePublish(req, env(github.fetch));
    expect(res.status).toBe(401);
    expect(github.calls).toEqual([]);
  });

  it("rejects an invalid skill name before calling GitHub", async () => {
    const github = fakeGitHub({});
    const res = await handlePublish(
      form({ ...payload, name: "Bad Name!" }),
      env(github.fetch),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("name");
    expect(github.calls).toEqual([]);
  });

  it("rejects empty description or body before calling GitHub", async () => {
    const github = fakeGitHub({});
    for (const field of ["description", "body"]) {
      const res = await handlePublish(
        form({ ...payload, [field]: "  " }),
        env(github.fetch),
      );
      expect(res.status).toBe(400);
      expect(github.calls).toEqual([]);
    }
  });

  it("surfaces a GitHub failure as a 502 with the failing step", async () => {
    const routes = happyPathRoutes();
    routes[`POST ${api}/repos/roleplane/roleplane-registry/pulls`] = () => ({
      status: 422,
      json: { message: "Validation Failed" },
    });
    const github = fakeGitHub(routes);
    const res = await handlePublish(form(payload), env(github.fetch));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("pull request");
  });
});

describe("handlePublishTeam", () => {
  const form = (fields: Record<string, string>) =>
    new Request("https://registry.example/publish-team", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "gh_token=gho_token",
      },
      body: new URLSearchParams(fields).toString(),
    });

  const payload = {
    name: "growth-team",
    repo: "https://github.com/octocat/agent-stuff",
    path: "teams/growth",
    description: "A growth marketing team",
    tags: "growth, marketing",
    version: "1.0.0",
  };

  const api = "https://api.github.com";
  const pinSha = "e".repeat(40);
  const baseSha = "b".repeat(40);

  function happyPathRoutes(): Record<
    string,
    (body: unknown) => { status?: number; json: unknown }
  > {
    return {
      [`GET ${api}/user`]: () => ({ json: { login: "octocat" } }),
      [`GET ${api}/repos/roleplane/roleplane-registry/contents/entries/octocat/growth-team.json`]:
        () => ({ status: 404, json: {} }),
      [`GET ${api}/repos/octocat/agent-stuff`]: () => ({
        json: { default_branch: "main" },
      }),
      [`GET ${api}/repos/octocat/agent-stuff/git/ref/heads/main`]: () => ({
        json: { object: { sha: pinSha } },
      }),
      [`GET ${api}/repos/octocat/agent-stuff/contents/teams/growth?ref=${pinSha}`]:
        () => ({ json: [{ name: "config.yaml" }] }),
      [`POST ${api}/repos/roleplane/roleplane-registry/forks`]: () => ({
        status: 202,
        json: { full_name: "octocat/roleplane-registry" },
      }),
      [`GET ${api}/repos/roleplane/roleplane-registry/git/ref/heads/main`]:
        () => ({ json: { object: { sha: baseSha } } }),
      [`POST ${api}/repos/octocat/roleplane-registry/git/refs`]: () => ({
        status: 201,
        json: {},
      }),
      [`PUT ${api}/repos/octocat/roleplane-registry/contents/entries/octocat/growth-team.json`]:
        () => ({ status: 201, json: { commit: { sha: "c".repeat(40) } } }),
      [`POST ${api}/repos/roleplane/roleplane-registry/pulls`]: () => ({
        status: 201,
        json: {
          html_url: "https://github.com/roleplane/roleplane-registry/pull/11",
        },
      }),
    };
  }

  it("pins the repo's current SHA and opens a kind=team entry PR as the author", async () => {
    const github = fakeGitHub(happyPathRoutes());
    const res = await handlePublishTeam(form(payload), env(github.fetch));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      "https://github.com/roleplane/roleplane-registry/pull/11",
    );

    const entryPut = github.calls.find(
      (c) =>
        c.method === "PUT" &&
        c.url.includes("contents/entries/octocat/growth-team.json"),
    )!;
    const entry = JSON.parse(
      fromB64((entryPut.body as { content: string }).content),
    );
    expect(entry).toEqual({
      kind: "team",
      repo: "octocat/agent-stuff",
      path: "teams/growth",
      description: "A growth marketing team",
      tags: ["growth", "marketing"],
      history: [{ sha: pinSha, version: "1.0.0" }],
    });

    // No content is committed to the author's repo — publish is by pointer.
    expect(
      github.calls.some(
        (c) => c.method !== "GET" && c.url.includes("/repos/octocat/agent-stuff"),
      ),
    ).toBe(false);

    const pr = github.calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${api}/repos/roleplane/roleplane-registry/pulls`,
    )!;
    expect(pr.body).toMatchObject({
      base: "main",
      head: expect.stringMatching(/^octocat:/),
    });

    // Token cookie cleared after use.
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("gh_token=;"))).toBe(true);
  });

  it("accepts a bare owner/repo and strips surrounding slashes from the path", async () => {
    const github = fakeGitHub(happyPathRoutes());
    const res = await handlePublishTeam(
      form({ ...payload, repo: "octocat/agent-stuff", path: "/teams/growth/" }),
      env(github.fetch),
    );
    expect(res.status).toBe(200);
    const entryPut = github.calls.find(
      (c) => c.method === "PUT" && c.url.includes("growth-team.json"),
    )!;
    const entry = JSON.parse(
      fromB64((entryPut.body as { content: string }).content),
    );
    expect(entry.repo).toBe("octocat/agent-stuff");
    expect(entry.path).toBe("teams/growth");
  });

  it("rejects when the team directory doesn't exist at the pinned SHA", async () => {
    const routes = happyPathRoutes();
    routes[`GET ${api}/repos/octocat/agent-stuff/contents/teams/growth?ref=${pinSha}`] =
      () => ({ status: 404, json: {} });
    const github = fakeGitHub(routes);
    const res = await handlePublishTeam(form(payload), env(github.fetch));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("teams/growth");
    // Nothing was written anywhere.
    expect(github.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("rejects a re-pin that would retarget an existing entry", async () => {
    const routes = happyPathRoutes();
    const existing = {
      kind: "team",
      repo: "octocat/other-repo",
      path: "teams/growth",
      description: "A growth marketing team",
      tags: ["growth"],
      history: [{ sha: "d".repeat(40), version: "1.0.0" }],
    };
    routes[
      `GET ${api}/repos/roleplane/roleplane-registry/contents/entries/octocat/growth-team.json`
    ] = () => ({
      json: { content: b64(JSON.stringify(existing)), sha: "blobsha" },
    });
    const github = fakeGitHub(routes);
    const res = await handlePublishTeam(
      form({ ...payload, version: "1.1.0" }),
      env(github.fetch),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("octocat/other-repo");
    expect(github.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("rejects an unparseable repo before calling GitHub", async () => {
    const github = fakeGitHub({});
    const res = await handlePublishTeam(
      form({ ...payload, repo: "not a repo" }),
      env(github.fetch),
    );
    expect(res.status).toBe(400);
    expect(github.calls).toEqual([]);
  });

  it("rejects a request without a token cookie", async () => {
    const github = fakeGitHub({});
    const req = new Request("https://registry.example/publish-team", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload).toString(),
    });
    const res = await handlePublishTeam(req, env(github.fetch));
    expect(res.status).toBe(401);
    expect(github.calls).toEqual([]);
  });

  it("re-pins an existing team entry, rejecting a reused version", async () => {
    const routes = happyPathRoutes();
    const existing = {
      kind: "team",
      repo: "octocat/agent-stuff",
      path: "teams/growth",
      description: "A growth marketing team",
      tags: ["growth"],
      history: [{ sha: "d".repeat(40), version: "1.0.0" }],
    };
    routes[
      `GET ${api}/repos/roleplane/roleplane-registry/contents/entries/octocat/growth-team.json`
    ] = () => ({
      json: { content: b64(JSON.stringify(existing)), sha: "blobsha" },
    });
    const github = fakeGitHub(routes);

    const rejected = await handlePublishTeam(form(payload), env(github.fetch));
    expect(rejected.status).toBe(400);

    const res = await handlePublishTeam(
      form({ ...payload, version: "1.1.0" }),
      env(github.fetch),
    );
    expect(res.status).toBe(200);
    const entryPut = github.calls.find(
      (c) => c.method === "PUT" && c.url.includes("growth-team.json"),
    )!;
    const entry = JSON.parse(
      fromB64((entryPut.body as { content: string }).content),
    );
    expect(entry.history).toEqual([
      { sha: "d".repeat(40), version: "1.0.0" },
      { sha: pinSha, version: "1.1.0" },
    ]);
  });
});

import type { IndexEntry } from "./build-index.ts";
import { esc } from "./html.ts";

/**
 * Everything the publish handlers need from the outside world. The Pages
 * Functions wrap these with real env vars and global fetch; tests inject a
 * scripted GitHub. No other state exists — the handlers are stateless and the
 * OAuth client secret is the only server-side secret.
 */
export interface PublishEnv {
  clientId: string;
  clientSecret: string;
  /** The registry repo publish PRs target, e.g. "roleplane/roleplane-registry". */
  registryRepo: string;
  fetch: typeof fetch;
  /** Wait between retries; tests inject a no-op. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const API = "https://api.github.com";
/** Repo created under the author's account to hold form-published skills. */
const SKILLS_REPO = "roleplane-skills";
/** Token cookie lifetime — long enough to fill the form, nothing more. */
const TOKEN_MAX_AGE = 1800;

/** Redirect to GitHub's authorize page, carrying a CSRF state cookie. */
export function handleLogin(request: Request, env: PublishEnv): Response {
  const state = crypto.randomUUID();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.clientId);
  authorize.searchParams.set("scope", "public_repo");
  authorize.searchParams.set(
    "redirect_uri",
    new URL("/auth/callback", request.url).toString(),
  );
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": cookie("oauth_state", state, 600),
    },
  });
}

/**
 * OAuth code→token exchange. The token lands only in a short-lived HttpOnly
 * cookie on the author's browser — never in any server-side store.
 */
export async function handleCallback(
  request: Request,
  env: PublishEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== readCookie(request, "oauth_state"))
    return new Response("OAuth state mismatch", { status: 403 });

  const res = await env.fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      code,
    }),
  });
  const data = (await res.json()) as { access_token?: string };
  if (!res.ok || !data.access_token)
    return new Response("GitHub token exchange failed", { status: 502 });

  const headers = new Headers({ location: "/publish/" });
  headers.append("set-cookie", cookie("gh_token", data.access_token, TOKEN_MAX_AGE));
  headers.append("set-cookie", cookie("oauth_state", "", 0));
  return new Response(null, { status: 302, headers });
}

/**
 * The Skill form handler: with the author's own token, commit the skill file
 * to a repo under their account and open the index-entry PR as them. The
 * token cookie is cleared on the way out.
 */
export async function handlePublish(
  request: Request,
  env: PublishEnv,
): Promise<Response> {
  const token = readCookie(request, "gh_token");
  if (!token)
    return htmlResponse(401, "Not logged in", "<p>Log in with GitHub first.</p>");

  const fields = new URLSearchParams(await request.text());
  const name = (fields.get("name") ?? "").trim();
  const description = (fields.get("description") ?? "").trim();
  const version = (fields.get("version") ?? "").trim();
  const body = (fields.get("body") ?? "").trim();
  const tags = (fields.get("tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const invalid: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    invalid.push("name must be lowercase letters, digits, and hyphens");
  if (!description) invalid.push("description is required");
  if (!version) invalid.push("version is required");
  if (!body) invalid.push("body is required");
  if (invalid.length > 0)
    return htmlResponse(
      400,
      "Invalid skill",
      `<ul>${invalid.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`,
    );

  const gh = githubClient(env.fetch, token);
  const sleep =
    env.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  try {
    const prUrl = await publishSkill(gh, env.registryRepo, sleep, {
      name,
      description,
      version,
      body,
      tags,
    });
    return htmlResponse(
      200,
      "Published",
      `<p>Your publish PR is open: <a href="${esc(prUrl)}">${esc(prUrl)}</a></p>
<p>It will run through the registry's CI gates and be merged editorially by the maintainer.</p>`,
      { "set-cookie": cookie("gh_token", "", 0) },
    );
  } catch (err) {
    if (err instanceof PublishRejected)
      return htmlResponse(400, "Invalid publish", `<p>${esc(err.message)}</p>`);
    if (err instanceof GitHubError)
      return htmlResponse(
        502,
        "Publish failed",
        `<p>GitHub call failed while ${esc(err.step)}: ${esc(err.message)}</p>`,
        { "set-cookie": cookie("gh_token", "", 0) },
      );
    throw err;
  }
}

interface SkillPayload {
  name: string;
  description: string;
  version: string;
  body: string;
  tags: string[];
}

async function publishSkill(
  gh: GitHub,
  registryRepo: string,
  sleep: (ms: number) => Promise<void>,
  skill: SkillPayload,
): Promise<string> {
  const { login } = (await gh.request(
    "GET",
    "/user",
    undefined,
    "reading your GitHub user",
  )) as { login: string };

  // A Re-pin appends to the existing entry's history — read it first so a
  // reused version label is rejected before anything is written anywhere.
  const entryPath = `entries/${login}/${skill.name}.json`;
  const existingEntry = (await gh.maybe(
    "GET",
    `/repos/${registryRepo}/contents/${entryPath}`,
  )) as { content: string; sha: string } | null;
  const baseHistory = existingEntry
    ? (JSON.parse(fromB64(existingEntry.content)) as IndexEntry).history
    : [];
  if (baseHistory.some((pin) => pin.version === skill.version))
    throw new PublishRejected(
      `version "${skill.version}" is already in ${login}/${skill.name}'s history — the version label must change on every re-pin`,
    );

  // Ensure the author's skills repo exists.
  const skillsRepo = `${login}/${SKILLS_REPO}`;
  const existingRepo = await gh.maybe("GET", `/repos/${skillsRepo}`);
  if (existingRepo === null)
    await gh.request(
      "POST",
      "/user/repos",
      { name: SKILLS_REPO, description: "Roleplane skills", auto_init: true },
      "creating your skills repo",
    );

  // Commit the skill file (updating in place if it already exists).
  const skillPath = `skills/${skill.name}.md`;
  const existingFile = (await gh.maybe(
    "GET",
    `/repos/${skillsRepo}/contents/${skillPath}`,
  )) as { sha: string } | null;
  // JSON-quote the description: a JSON string is valid YAML, so hostile
  // characters (colons, hashes, quotes) can't corrupt the frontmatter.
  const skillFile = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`;
  const commit = (await gh.request(
    "PUT",
    `/repos/${skillsRepo}/contents/${skillPath}`,
    {
      message: `Publish ${skill.name} v${skill.version}`,
      content: toB64(skillFile),
      ...(existingFile ? { sha: existingFile.sha } : {}),
    },
    "committing the skill file",
  )) as { commit: { sha: string } };

  // Build the Index Entry: new, or a Re-pin appended to the existing history.
  const pin = { sha: commit.commit.sha, version: skill.version };
  const history = [...baseHistory, pin];
  const entry: IndexEntry = {
    kind: "skill",
    repo: skillsRepo,
    path: skillPath,
    description: skill.description,
    tags: skill.tags,
    history,
  };

  // Fork the registry, branch from its main, commit the entry, open the PR.
  const fork = (await gh.request(
    "POST",
    `/repos/${registryRepo}/forks`,
    {},
    "forking the registry",
  )) as { full_name: string };
  const base = (await gh.request(
    "GET",
    `/repos/${registryRepo}/git/ref/heads/main`,
    undefined,
    "reading the registry's main branch",
  )) as { object: { sha: string } };
  const branch = `publish-${skill.name}-${skill.version}`.replaceAll(".", "-");
  // A fresh fork populates asynchronously — retry while it comes up.
  for (let attempt = 1; ; attempt++) {
    try {
      await gh.request(
        "POST",
        `/repos/${fork.full_name}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: base.object.sha },
        "creating the publish branch",
      );
      break;
    } catch (err) {
      if (!(err instanceof GitHubError) || attempt >= 5) throw err;
      await sleep(1000 * attempt);
    }
  }
  await gh.request(
    "PUT",
    `/repos/${fork.full_name}/contents/${entryPath}`,
    {
      message: `Publish ${login}/${skill.name} v${skill.version}`,
      content: toB64(JSON.stringify(entry, null, 2) + "\n"),
      branch,
      ...(existingEntry ? { sha: existingEntry.sha } : {}),
    },
    "committing the index entry",
  );
  const pr = (await gh.request(
    "POST",
    `/repos/${registryRepo}/pulls`,
    {
      title: `Publish ${login}/${skill.name} v${skill.version}`,
      head: `${login}:${branch}`,
      base: "main",
      body: `Publishes \`${login}/${skill.name}\` pointing at \`${skillsRepo}/${skillPath}\` @ \`${pin.sha}\`.`,
    },
    "opening the pull request",
  )) as { html_url: string };
  return pr.html_url;
}

/** A publish the handler refuses before writing anything — reported as a 400. */
class PublishRejected extends Error {}

class GitHubError extends Error {
  constructor(
    public step: string,
    message: string,
  ) {
    super(message);
  }
}

interface GitHub {
  /** Call GitHub and fail loudly with the human-readable step on any error. */
  request(
    method: string,
    path: string,
    body: unknown,
    step: string,
  ): Promise<unknown>;
  /** Call GitHub where 404 is a normal answer; returns null on 404. */
  maybe(method: string, path: string): Promise<unknown | null>;
}

function githubClient(fetchFn: typeof fetch, token: string): GitHub {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> =>
    fetchFn(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "roleplane-registry-publish",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    async request(method, path, body, step) {
      const res = await call(method, path, body);
      const json = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!res.ok)
        throw new GitHubError(step, json.message ?? `HTTP ${res.status}`);
      return json;
    },
    async maybe(method, path) {
      const res = await call(method, path);
      if (res.status === 404) return null;
      const json = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!res.ok)
        throw new GitHubError(
          `calling ${method} ${path}`,
          json.message ?? `HTTP ${res.status}`,
        );
      return json;
    },
  };
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function htmlResponse(
  status: number,
  title: string,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — Roleplane Registry</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem;">
<h1>${esc(title)}</h1>
${body}
<p><a href="/publish/">Back to publish</a> &middot; <a href="/index.html">Browse the registry</a></p>
</body>
</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } },
  );
}

function toB64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function fromB64(b64: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(b64.replaceAll("\n", "")), (c) => c.charCodeAt(0)),
  );
}

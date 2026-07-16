import { parse as parseYaml } from "yaml";
import { entryShapeErrors, type IndexEntry } from "./build-index.ts";
import { lintText } from "./injection-lint.ts";

/**
 * Everything validate-entry needs from the outside world, injected so tests
 * never touch live GitHub. CI wires this to the real API.
 */
export interface ContentHost {
  /** File contents at a pinned SHA, or null if it doesn't exist. */
  fetchFile(repo: string, sha: string, path: string): Promise<string | null>;
  /** File/dir names directly under a path at a pinned SHA, or null if it doesn't exist. */
  listDir(repo: string, sha: string, path: string): Promise<string[] | null>;
  /** Whether the PR author demonstrably controls a repo they don't literally own. */
  authorControlsRepo(author: string, repo: string): Promise<boolean>;
}

export interface ValidateEntryInput {
  /** Entry key `author/name`, derived from the file path under entries/. */
  key: string;
  entry: IndexEntry;
  /** The entry as it exists on the base branch, when this PR touches an existing key. */
  baseEntry?: IndexEntry;
  prAuthor: string;
  /** All entry keys on the base branch, for collision checks. */
  existingKeys: string[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * The single entrypoint behind every Publish PR: runs all four CI gates
 * (schema at the pinned SHA, ownership, injection lint, namespace) and
 * returns exact, actionable failures. Lint findings are warnings only.
 */
export async function validateEntry(
  input: ValidateEntryInput,
  host: ContentHost,
): Promise<ValidationResult> {
  const { key, entry, baseEntry, prAuthor, existingKeys } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (msg: string): void => {
    errors.push(`${key}: ${msg}`);
  };

  // Namespace gate
  const [keyAuthor, name] = key.split("/");
  if (keyAuthor.toLowerCase() !== prAuthor.toLowerCase())
    fail(
      `entry key must be namespaced under the PR author — expected "${prAuthor}/${name}"`,
    );
  const collision = existingKeys.find(
    (k) => k !== key && k.toLowerCase() === key.toLowerCase(),
  );
  if (collision)
    fail(`collides with existing entry "${collision}" (keys are case-insensitive)`);

  // Structural checks — bail here if the entry isn't even shaped right
  const shapeErrors = entryShapeErrors(key, entry);
  if (shapeErrors.length > 0) {
    errors.push(...shapeErrors);
    return { errors, warnings };
  }

  // Re-pin gate: history is append-only and every re-pin changes the version label
  if (baseEntry) {
    const base = baseEntry.history;
    const next = entry.history;
    const prefixIntact =
      next.length >= base.length &&
      base.every(
        (pin, i) => pin.sha === next[i].sha && pin.version === next[i].version,
      );
    if (!prefixIntact) {
      fail("history is append-only — existing pins were edited or removed");
    } else if (next.length === base.length) {
      fail(
        "a change to an existing entry must append a new {sha, version} pin to history",
      );
    } else {
      const seen = new Set(base.map((pin) => pin.version));
      for (const pin of next.slice(base.length)) {
        if (seen.has(pin.version))
          fail(
            `re-pin version "${pin.version}" is already used in history — the version label must change on every re-pin`,
          );
        seen.add(pin.version);
      }
    }
  }

  // Ownership gate: owning the repo namespace is proof; anything else asks the host
  const repoOwner = entry.repo.split("/")[0];
  const owns =
    repoOwner.toLowerCase() === prAuthor.toLowerCase() ||
    (await host.authorControlsRepo(prAuthor, entry.repo));
  if (!owns)
    fail(
      `PR author ${prAuthor} does not own or control the referenced repo ${entry.repo} — entries may only point at repos you control`,
    );

  // Schema gate: validate the referenced content at the last (installed) pin
  const pin = entry.history[entry.history.length - 1];
  const fetched: string[] = [];
  if (entry.kind === "skill") {
    const content = await host.fetchFile(entry.repo, pin.sha, entry.path);
    if (content === null) {
      fail(
        `${entry.path} not found in ${entry.repo} at pinned SHA ${pin.sha}`,
      );
    } else {
      errors.push(...skillSchemaErrors(key, content));
      fetched.push(content);
    }
  } else {
    const files = await host.listDir(entry.repo, pin.sha, entry.path);
    if (files === null) {
      fail(`${entry.path} not found in ${entry.repo} at pinned SHA ${pin.sha}`);
    } else if (!files.includes("config.yaml")) {
      fail(
        `${entry.path} in ${entry.repo} at pinned SHA ${pin.sha} has no config.yaml — a team directory must contain one`,
      );
    } else {
      const config = await host.fetchFile(
        entry.repo,
        pin.sha,
        `${entry.path}/config.yaml`,
      );
      if (config === null) {
        fail(
          `${entry.path}/config.yaml not found in ${entry.repo} at pinned SHA ${pin.sha}`,
        );
      } else {
        errors.push(...teamConfigErrors(key, config));
        fetched.push(config);
      }
    }
  }

  // Injection lint (warn-only) over whatever content the schema gate fetched
  for (const content of fetched) {
    for (const finding of lintText(content)) {
      warnings.push(
        `${key}: [${finding.rule}] ${finding.message} — matched ${JSON.stringify(finding.match)}`,
      );
    }
  }

  return { errors, warnings };
}

function skillSchemaErrors(key: string, content: string): string[] {
  const errors: string[] = [];
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    errors.push(
      `${key}: skill file must start with a YAML frontmatter block (---)`,
    );
    return errors;
  }
  const [, rawFrontmatter, body] = match;
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(rawFrontmatter);
  } catch {
    errors.push(`${key}: skill frontmatter is not valid YAML`);
    return errors;
  }
  if (typeof frontmatter !== "object" || frontmatter === null) {
    errors.push(`${key}: skill frontmatter must be a YAML mapping`);
    return errors;
  }
  const fm = frontmatter as Record<string, unknown>;
  for (const field of ["name", "description"]) {
    if (typeof fm[field] !== "string" || fm[field] === "")
      errors.push(
        `${key}: skill frontmatter is missing required field "${field}"`,
      );
  }
  if (fm.type !== undefined && fm.type !== "skill")
    errors.push(`${key}: skill frontmatter "type" must be "skill"`);
  if (body.trim() === "")
    errors.push(
      `${key}: skill body is empty — a skill must contain instructions below the frontmatter`,
    );
  return errors;
}

function teamConfigErrors(key: string, config: string): string[] {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(config);
  } catch {
    errors.push(`${key}: team config.yaml is not valid YAML`);
    return errors;
  }
  if (typeof parsed !== "object" || parsed === null) {
    errors.push(`${key}: team config.yaml must be a YAML mapping`);
    return errors;
  }
  const cfg = parsed as Record<string, unknown>;
  if (typeof cfg.schema !== "number")
    errors.push(
      `${key}: team config.yaml is missing required field "schema"`,
    );
  for (const field of ["name", "description"]) {
    if (typeof cfg[field] !== "string" || cfg[field] === "")
      errors.push(
        `${key}: team config.yaml is missing required field "${field}"`,
      );
  }
  if (
    typeof cfg.jobs !== "object" ||
    cfg.jobs === null ||
    Object.keys(cfg.jobs).length === 0
  )
    errors.push(`${key}: team config.yaml is missing required field "jobs"`);
  return errors;
}

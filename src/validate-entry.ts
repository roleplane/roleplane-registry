import { parse as parseYaml } from "yaml";
import { entryShapeErrors, type IndexEntry } from "./build-index.ts";
import { declaresTools, lintText } from "./injection-lint.ts";

/**
 * The complete Roleplane tool surface. A skill's or agent's `tools:` is a
 * requirement declaration validated against this list — never a grant.
 * Mirrors KNOWN_TOOLS in the product repo (roleplane/roleplane).
 */
export const KNOWN_TOOLS = new Set(["web_search", "file_write", "ask_founder"]);

/** The reserved first-party author; third parties may never publish under it. */
const RESERVED_AUTHOR = "roleplane";

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

  // Namespace gate — the reserved author is checked first so a squatting
  // attempt gets the specific error, not the generic namespace one.
  const [keyAuthor, name] = key.split("/");
  if (
    keyAuthor.toLowerCase() === RESERVED_AUTHOR &&
    prAuthor.toLowerCase() !== RESERVED_AUTHOR
  )
    fail(
      `author "${RESERVED_AUTHOR}" is reserved for first-party entries — publish under your own GitHub username ("${prAuthor}/${name}")`,
    );
  else if (keyAuthor.toLowerCase() !== prAuthor.toLowerCase())
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

  // Version labels are unique across all of history, re-pin or not
  const versions = new Set<string>();
  for (const pin of entry.history) {
    if (versions.has(pin.version))
      fail(
        `version "${pin.version}" appears more than once in history — the version label must change on every re-pin`,
      );
    versions.add(pin.version);
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
  if (entry.kind === "skill" || entry.kind === "agent") {
    const content = await host.fetchFile(entry.repo, pin.sha, entry.path);
    if (content === null) {
      fail(
        `${entry.path} not found in ${entry.repo} at pinned SHA ${pin.sha}`,
      );
    } else {
      errors.push(
        ...(entry.kind === "skill"
          ? skillSchemaErrors(key, content)
          : agentSchemaErrors(key, content)),
      );
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
      // The team's markdown (agents, skills) is the real injection surface —
      // pull it in so the lint below sees it, one directory level deep.
      for (const name of files) {
        if (name.endsWith(".md")) {
          const md = await host.fetchFile(
            entry.repo,
            pin.sha,
            `${entry.path}/${name}`,
          );
          if (md !== null) fetched.push(md);
        } else if (!name.includes(".")) {
          const sub = await host.listDir(
            entry.repo,
            pin.sha,
            `${entry.path}/${name}`,
          );
          for (const subName of sub ?? []) {
            if (!subName.endsWith(".md")) continue;
            const md = await host.fetchFile(
              entry.repo,
              pin.sha,
              `${entry.path}/${name}/${subName}`,
            );
            if (md !== null) fetched.push(md);
          }
        }
      }
    }
  }

  // Injection lint (warn-only) over whatever content the schema gate fetched.
  // Tool-declaring content is the standalone-run surface and gets its own rules.
  for (const content of fetched) {
    for (const finding of lintText(content, {
      declaresTools: declaresTools(content),
    })) {
      warnings.push(
        `${key}: [${finding.rule}] ${finding.message} — matched ${JSON.stringify(finding.match)}`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * Split a markdown unit file into parsed frontmatter and body, or record why
 * it can't be. Shared by the skill and agent schema gates.
 */
function parseUnitFile(
  key: string,
  unit: "skill" | "agent",
  content: string,
  errors: string[],
): { fm: Record<string, unknown>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    errors.push(
      `${key}: ${unit} file must start with a YAML frontmatter block (---)`,
    );
    return null;
  }
  const [, rawFrontmatter, body] = match;
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(rawFrontmatter);
  } catch {
    errors.push(`${key}: ${unit} frontmatter is not valid YAML`);
    return null;
  }
  if (typeof frontmatter !== "object" || frontmatter === null) {
    errors.push(`${key}: ${unit} frontmatter must be a YAML mapping`);
    return null;
  }
  return { fm: frontmatter as Record<string, unknown>, body };
}

/** Validate a `tools:` declaration against the known tool surface. */
function toolsErrors(
  key: string,
  unit: "skill" | "agent",
  tools: unknown,
  errors: string[],
): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) {
    errors.push(`${key}: ${unit} "tools" must be a list of tool names`);
    return;
  }
  for (const tool of tools as string[]) {
    if (!KNOWN_TOOLS.has(tool))
      errors.push(
        `${key}: ${unit} declares unknown tool '${tool}' — Roleplane tools are ${[...KNOWN_TOOLS].sort().join(", ")}`,
      );
  }
}

function skillSchemaErrors(key: string, content: string): string[] {
  const errors: string[] = [];
  const parsed = parseUnitFile(key, "skill", content, errors);
  if (!parsed) return errors;
  const { fm, body } = parsed;
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

  // Skill v2 fields — all optional, but if present must be shaped right.
  unitListErrors(key, "input", fm.inputs, "name", INPUT_FIELDS, errors);
  unitListErrors(
    key,
    "deliverable",
    fm.deliverables,
    "file",
    DELIVERABLE_FIELDS,
    errors,
  );
  toolsErrors(key, "skill", fm.tools, errors);
  return errors;
}

// Optional field types, mirroring JobInput and Deliverable in the product repo.
const INPUT_FIELDS = {
  description: "string",
  required: "boolean",
  primary: "boolean",
  default: "string",
} as const;
const DELIVERABLE_FIELDS = {
  description: "string",
  root: "boolean",
  type: "string",
} as const;

/**
 * Validate one Skill v2 list field (`inputs` or `deliverables`): a list of
 * mappings, each with a non-empty identifying string plus typed optional
 * fields. Absent means "not declared" and is always fine.
 */
function unitListErrors(
  key: string,
  label: "input" | "deliverable",
  items: unknown,
  requiredField: string,
  optionalFields: Record<string, "string" | "boolean">,
  errors: string[],
): void {
  if (items === undefined) return;
  if (!Array.isArray(items)) {
    errors.push(`${key}: skill "${label}s" must be a list`);
    return;
  }
  for (const item of items) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>)[requiredField] !== "string" ||
      (item as Record<string, unknown>)[requiredField] === ""
    ) {
      errors.push(
        `${key}: every skill ${label} needs a non-empty "${requiredField}" string`,
      );
      continue;
    }
    for (const [field, type] of Object.entries(optionalFields)) {
      const value = (item as Record<string, unknown>)[field];
      if (value !== undefined && value !== null && typeof value !== type)
        errors.push(
          `${key}: skill ${label} "${field}" must be a ${type} when present`,
        );
    }
  }
}

function agentSchemaErrors(key: string, content: string): string[] {
  const errors: string[] = [];
  const parsed = parseUnitFile(key, "agent", content, errors);
  if (!parsed) return errors;
  const { fm, body } = parsed;
  for (const field of ["name", "role"]) {
    if (typeof fm[field] !== "string" || fm[field] === "")
      errors.push(
        `${key}: agent frontmatter is missing required field "${field}"`,
      );
  }
  if (fm.type !== undefined && fm.type !== "agent")
    errors.push(`${key}: agent frontmatter "type" must be "agent"`);
  if (
    fm.skills !== undefined &&
    (!Array.isArray(fm.skills) || fm.skills.some((s) => typeof s !== "string"))
  )
    errors.push(`${key}: agent "skills" must be a list of skill references`);
  toolsErrors(key, "agent", fm.tools, errors);
  if (body.trim() === "")
    errors.push(
      `${key}: agent body is empty — an agent must contain a system prompt below the frontmatter`,
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

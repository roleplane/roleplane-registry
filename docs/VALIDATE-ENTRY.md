# validate-entry

Every Publish PR that touches `entries/` runs a single CI entrypoint, `validateEntry` (`src/validate-entry.ts`, wrapped for CI by `scripts/validate-entry.ts` and `.github/workflows/validate-entry.yml`). It runs four gates and reports exact, actionable failures, so the maintainer's merge stays purely editorial.

## The four gates

1. **Schema** — the referenced content is fetched at the entry's *last* history pin and validated: a skill must be a markdown file with YAML frontmatter (`name`, `description`; `type`, if present, must be `skill`; the optional Skill v2 fields `inputs`, `deliverables`, and `tools` must be well-shaped, with `tools` naming only known Roleplane tools) and a non-empty body; an agent must be a markdown file with frontmatter (`name`, `role`; `type`, if present, must be `agent`; `tools` validated the same way) and a non-empty system-prompt body; a team must be a directory containing a `config.yaml` with `schema`, `name`, `description`, and at least one job under `jobs`.
2. **Ownership** — the PR author must own the referenced repo (owner segment matches their username) or demonstrably control it (write/admin collaborator, checked via the GitHub API). Blocks attribution theft and namespace squatting.
3. **Injection lint** — the fetched content (the skill or agent file, or a team's `config.yaml` plus its agent/skill markdown one directory level deep) is scanned against the versioned rules spec in `src/injection-rules.json` (embedded URLs, webhook endpoints, exfiltration patterns, instruction overrides). Rules can scope via `appliesTo`: tool-declaring content — the standalone-run surface — gets its own rules (remote-instructions, credential-harvest, workspace-escape), while the tool-invocation-phrasing rule applies only to content declaring no tools. Findings are **warnings only**: they surface on the PR for the maintainer to review with eyes open, but never fail the job. A screening aid, not a security boundary.
4. **Namespace** — the entry key must be `pr-author/name` (case-insensitive), the reserved author `roleplane` is rejected for third parties with a specific error, must not collide case-insensitively with an existing key, and changes to an existing entry must append a new `{sha, version}` pin: history is append-only and the version label must change on every Re-pin.

## Rules spec and corpus

`src/injection-rules.json` carries a `version` that must be incremented whenever rules change. The lint is golden-file tested against the corpus in `tests/fixtures/injection-corpus/` — every known-bad file must trigger exactly its expected rules (`expected.json`), every known-good file must pass clean. Add corpus files alongside any rule change.

## Testing

The entrypoint is tested at the seam with fetches and ownership lookups mocked (`tests/validate-entry.test.ts`); nothing in the suite touches live GitHub.

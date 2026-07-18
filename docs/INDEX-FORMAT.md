# Index format

The Registry's index is a set of source Index Entries under `entries/`, compiled by `npm run build` into a single `index.json` that any client (the browse site, `skill search`, the run-console browse panel) can fetch.

## Source layout

One JSON file per Index Entry:

```
entries/<author>/<name>.json
```

The entry key is `author/name`, derived from the file path — it is never declared inside the file. `<author>` must be the GitHub username of the Author (the `validate-entry` CI gate verifies it matches the PR author — see `docs/VALIDATE-ENTRY.md`; first-party entries use `roleplane`).

## Entry fields

```json
{
  "kind": "skill",
  "repo": "roleplane/roleplane",
  "path": "templates/teams/content/skills/blog-craft.md",
  "description": "How to write a blog post people finish reading.",
  "tags": ["writing", "content"],
  "history": [
    { "sha": "d5cc9e8e33c86977de9a532eb3c4ef0f05d8446b", "version": "1.0.0" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `"skill"` or `"agent"` (single markdown file at `path`) or `"team"` (team directory at `path`). |
| `repo` | The Author's GitHub repo (`owner/repo`) holding the content. |
| `path` | Path within `repo` to the skill file or team directory. |
| `description` | One-line description shown on catalog cards. |
| `tags` | Free-form lowercase tags for search and filtering. |
| `history` | Append-only list of `{sha, version}` pins, oldest first. A Re-pin appends a new pin; nothing is ever edited or removed. `sha` is a full 40-char commit SHA in `repo`; `version` is a label that must change on every Re-pin (semver semantics are not enforced). The last pin is the one installers fetch. |
| `installs` | Optional count of Installs via Roleplane, reserved for the deferred download counter. Authors never set it. |

## Built `index.json`

```json
{
  "schemaVersion": 1,
  "entries": {
    "roleplane/blog-craft": { ...entry fields... }
  }
}
```

Entries are keyed `author/name` and sorted by key. `installs` is omitted when absent and passed through when present — clients must tolerate both, so the counter can arrive later with no schema migration. `index.json` is committed; the test suite fails if it drifts from a rebuild of `entries/`.

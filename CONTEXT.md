# Roleplane Registry

The pointer-index registry for Roleplane Skills and Teams. Content lives in authors' own GitHub repos; this repo holds only the index that points at it. Vocabulary here extends the Roleplane product glossary (`roleplane/roleplane` → `CONTEXT.md`) — Skill, Team, Workspace, etc. keep their meanings from there.

## Language

**Registry**:
This repo plus the site built from it: the public catalog of Skills and Teams. It hosts no content — only Index Entries pointing at authors' repos.
_Avoid_: Marketplace (implies hosting and payments), store, hub

**Index Entry**:
One record in the index, keyed `author/name`, stored as `entries/<author>/<name>.json`. Carries kind (skill|team), the author's `repo` and `path`, description, tags, an append-only history of `{sha, version}` pins, and an optional `installs` count. The built `index.json` is the compiled set of all Index Entries.
_Avoid_: Listing, package (nothing is packaged), record

**Author**:
The GitHub user (or org) whose username is the first segment of an Index Entry's key and who owns the referenced repo. Attribution is the PR authorship on the entry — unforgeable, never self-declared. First-party entries are authored by the Roleplane org.
_Avoid_: Vendor, publisher (as a noun), maintainer (reserved for the registry maintainer)

**Publish**:
Adding a new Index Entry via a PR to this repo, gated by CI and merged editorially by the maintainer. Via the web form for Skills, or a hand-written PR for anything.
_Avoid_: Upload (nothing is uploaded), submit, release

**Re-pin**:
Appending a new `{sha, version}` pin to an existing Index Entry's history — how an Author releases an update. History is append-only; the version label must change on every Re-pin.
_Avoid_: Update (ambiguous), bump, overwrite

**Install**:
Fetching a unit into a founder's Workspace at the entry's pinned SHA, done by the Roleplane product. Browsing or downloading from the site is not an Install and is never counted.
_Avoid_: Download, clone

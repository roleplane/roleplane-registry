# Roleplane Registry

The pointer-index registry for [Roleplane](https://github.com/roleplane/roleplane) Skills and Teams. Content lives in authors' own GitHub repos; this repo holds only the index that points at it — see [`CONTEXT.md`](./CONTEXT.md) for the vocabulary and [`docs/INDEX-FORMAT.md`](./docs/INDEX-FORMAT.md) for the index format.

Publishing is a PR that adds or re-pins an Index Entry, gated by the [`validate-entry` CI checks](./docs/VALIDATE-ENTRY.md) and merged editorially by the maintainer.

## Development

Only [mise](https://mise.jdx.dev/getting-started.html) is required — it provisions Node.

```bash
mise install          # provision toolchain
mise run install      # install dependencies
mise run check        # lint + typecheck + test, same as CI
```

| Task | Command |
| ---- | ------- |
| Rebuild `index.json` from `entries/` | `mise run build` |
| Lint / typecheck / test | `mise run lint` / `mise run typecheck` / `mise run test` |
| Everything CI runs | `mise run check` |
| Serve the built index in Docker | `mise run up` / `mise run down` |

`index.json` is committed; the test suite fails if it drifts from a rebuild of `entries/`, so run `mise run build` after touching anything under `entries/`.

## Docker

`docker compose up --build` (or `mise run up`) builds the index and serves it with nginx at <http://localhost:8080/index.json> — the same static shape any client fetches. Development doesn't need Docker.

## License

[Apache-2.0](./LICENSE)

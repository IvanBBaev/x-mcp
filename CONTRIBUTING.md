# Contributing to x-mcp-ai

Thanks for your interest. This is a pre-1.0 project under active development; the public API is
unstable and the tool surface is landing package by package. Contributions are welcome — please
open an issue to discuss anything non-trivial before sending a large change.

## Development setup

Requires **Node.js >= 22** (see [`.nvmrc`](.nvmrc)).

```bash
git clone https://github.com/IvanBBaev/x-mcp-ai.git
cd x-mcp-ai
npm ci
npm run build      # tsc → build/
```

Copy [`.env.example`](.env.example) to `.env` and fill in credentials to run against the real
API. The server loads env without a dotenv dependency:

```bash
node --env-file=.env build/src/index.js doctor
```

## Quality gate

Run the same checks CI runs before you push:

```bash
npm run check
```

`check` runs, in order: `typecheck` → `lint` → `format:check` → `test`. The individual scripts:

| Script | What it does |
|---|---|
| `npm run build` | Compile with `tsc` to `build/`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint over the repo. |
| `npm run format` / `npm run format:check` | Prettier write / verify. |
| `npm test` | Build, then `node --test` over `build/test/**/*.test.js`. |
| `npm run coverage` | Same tests under c8 coverage. |
| `npm run check` | typecheck + lint + format:check + test (the pre-push gate). |
| `npm run verify` | clean + build + coverage + lint + format:check (the fuller local gate). |

Tests use Node's built-in test runner and `undici`'s `MockAgent` for HTTP — no network access
and no credentials are needed to run the suite.

## Conventions

- **TypeScript strict ESM**, ports & adapters. Respect the dependency rule from
  [`docs/02-architecture.md`](docs/02-architecture.md): `tools → core + api/endpoints`,
  `api → core`, `mcp → tools + core`, `cli → core + api`; nothing in `core` reaches outward.
- **Everything in the codebase is English** — identifiers, comments, docstrings, commit
  messages, test names, and user-facing strings.
- **Tool naming**: `x_<domain>_<verb>`, always prefixed `x_`; descriptions open with
  `X (Twitter): …`. Toggles use `<noun>_set` with an `action` enum; collection reads use
  `<noun>_list`. A tool is data (a `ToolDef`), not a bespoke handler — see
  [`src/core/tooldef.ts`](src/core/tooldef.ts).
- **Runtime dependencies stay minimal** — only `@modelcontextprotocol/sdk` and `zod`. Anything
  else belongs in `devDependencies`.
- **Cost and policy are load-bearing.** New tools must declare their policy cell, availability
  class, OAuth scopes and cost class; keep the catalog in
  [`docs/03-tool-catalog.md`](docs/03-tool-catalog.md) in sync, and regenerate the tools table
  between the `<!-- GENERATED:TOOLS -->` markers in the README.
- **No AI attribution** in commits or PRs.

## Where things live

- `src/core/` — config, policy, budget, registry, error taxonomy, rendering, pagination.
- `src/api/` — HTTP client, rate-limit table, OAuth, per-endpoint request builders.
- `src/tools/` — one module per package.
- `src/mcp/` — the MCP adapter (server, schema, structured output).
- `src/cli/` — `authorize` and `doctor` subcommands.
- `docs/` — the design corpus (API landscape, architecture, tool catalog, security, testing,
  roadmap, corner cases).

## Releasing

> **Placeholder — to be finalized once release automation lands.** There is no publish/release
> workflow in the repo yet; the steps below are the intended manual runbook.

1. Ensure `main` is green (`npm run verify`).
2. Bump the version in `package.json` **and** `server.json` in lockstep (they must match).
3. Move the `## [Unreleased]` entries in [`CHANGELOG.md`](CHANGELOG.md) under a new dated,
   versioned heading.
4. Tag `vX.Y.Z` and publish to npm (`npm publish`), then to the MCP Registry from `server.json`.

Versioning follows [SemVer](https://semver.org/). While on `0.x` the public API may change in
any minor release; consumers should pin an exact version.

- The default branch is `dev`. Local `main` may not exist; use `dev` or `origin/dev` for diffs.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Quickstart

```bash
bun install       # bun@1.3.13 required (enforced by pre-push hook)
bun dev           # run OpenCode against packages/opencode
bun dev <dir>     # run against a different directory
bun dev .         # run against the repo root itself
bun dev serve     # headless API server (port 4096, use --port to override)
```

## Package Map

| Directory | Purpose |
|---|---|
| `packages/opencode` | Core: CLI, TUI, server, all business logic |
| `packages/app` | Shared web UI (SolidJS) |
| `packages/desktop` | Electron desktop app (wraps `packages/app`) |
| `packages/plugin` | `@opencode-ai/plugin` source |
| `packages/sdk/js` | JavaScript SDK (generated from OpenAPI spec) |
| `packages/core` | Shared Effect core types/services |
| `packages/script` | Build/release script (checks bun version, computes version) |
| `packages/docs` | Documentation site |

## Commands

### Typecheck
```
bun typecheck       # from root: runs turbo typecheck (all packages)
bun typecheck       # from package dir (e.g. packages/opencode): runs tsgo --noEmit
```
The opencode package uses `tsgo` (TypeScript native preview), not `tsc`. Do not run `tsc` directly.

### Test
Tests **cannot** run from repo root — `bunfig.toml` sets `test.root = "./do-not-run-tests-from-root"` and `package.json` scripts block it explicitly.

```bash
bun test                        # from a package dir (e.g. packages/opencode)
bun turbo test:ci               # CI unit tests from root
bun --cwd packages/app test:e2e:local   # playwright E2E tests
```

### Lint
```bash
oxlint              # from root. NOT eslint. Type-aware mode enabled in .oxlintrc.json.
```

### Codegen
After API or SDK changes:
```bash
./packages/opencode/script/generate.ts   # regenerates SDK + related files
./packages/sdk/js/script/build.ts        # regenerates JS SDK from OpenAPI spec
```

### Database (Drizzle)
```bash
bun run db generate --name <slug>   # from packages/opencode. Writes to migration/
```
Schema: `packages/opencode/src/**/*.sql.ts`. Output: `migration/<timestamp>_<slug>/migration.sql` + `snapshot.json`.

### Build Standalone
```bash
./packages/opencode/script/build.ts --single
# outputs: packages/opencode/dist/opencode-<platform>/bin/opencode
```

### Web App Dev
Start the API server first, then the web dev server:
```bash
bun dev serve                           # terminal 1
bun run --cwd packages/app dev          # terminal 2
```

### Desktop App Dev
```bash
bun run --cwd packages/desktop dev
```

## Gotchas

- **Pre-push hook** (.husky/pre-push): verifies bun version matches `packageManager` field AND runs `bun typecheck`. A typecheck failure blocks push.
- **Migrations are locked**: `packages/opencode/migration/*` is `deny`-edit in `.opencode/opencode.jsonc`. Do not edit migration files through the agent.
- **TrustedDependencies**: `esbuild`, `node-pty`, `protobufjs`, `tree-sitter`, `tree-sitter-bash`, `tree-sitter-powershell`, `web-tree-sitter` — these need `trustedDependencies` in package.json for bun install.
- **postinstall**: `fix-node-pty` runs automatically after install.
- **Debugging**: use `bun run --inspect=ws://localhost:6499/ dev spawn` for breakpoints in server code. Debug server and TUI separately if spawn doesn't work (see CONTRIBUTING.md for full debug guide).

## Effect + Module Conventions

This repo uses Effect v4 heavily in `packages/opencode`.

- **Self-export pattern**: modules use `export * as Foo from "./foo"` at file bottom. Consumers import `import { Foo } from "@/foo/foo"` and access via `Foo.Service`, `Foo.layer`, etc.
- **No `export namespace`**. It prevents tree-shaking and breaks Node's native TS runner.
- **No barrel `index.ts`** for multi-sibling directories (e.g. `src/session/`, `src/config/`). Import specific siblings: `import { SessionRetry } from "@/session/retry"`.
- **Typecheck uses `tsgo`** (native TS), not `tsc`. The opencode package's `typecheck` script is `tsgo --noEmit`.
- See `packages/opencode/AGENTS.md` for detailed Effect patterns (service layer shape, `makeRuntime`, `InstanceState`, `Effect.cached`, `Instance.bind`).

## Style Guide

### General
- Keep logic in one function unless composable or reusable.
- Avoid `try`/`catch`; prefer `.catch(...)`.
- Avoid `any`. Prefer `const` over `let`.
- Use Bun APIs when available (e.g. `Bun.file()`).
- Rely on type inference; avoid explicit annotations unless needed for exports.
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter.
- Inline one-shot values instead of assigning to intermediate variables.

### Destructuring
Avoid unnecessary destructuring. Use dot notation:
```ts
obj.a; obj.b  // Good
const { a, b } = obj  // Bad
```

### Control Flow
Avoid `else`. Use early returns:
```ts
function foo() {
  if (condition) return 1
  return 2
}
```

### Drizzle Schemas
Use snake_case for field names (column names auto-derived):
```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad (redundant string column names)
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

### Formatting
- Prettier: `semi: false`, `printWidth: 120` (configured in root `package.json`).
- EditorConfig: 2-space indent, LF line endings, utf-8.

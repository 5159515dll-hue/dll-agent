# dll-agent Permissions

## Modes

dll-agent has three permission modes:

- `default`: use OpenCode's normal permission prompts and configured rules.
- `auto-review`: auto-approve low-risk or project-local ordinary work; ask for high-risk or uncertain actions.
- `full-access`: grant all permissions by explicit user choice. High-risk actions are allowed and recorded as Full Access overrides.

`Full Access` is intentionally not a safety mode. It is useful when the user wants Codex-style uninterrupted execution and accepts that secrets, destructive commands, remote publish, global modification, and reviewer writes may proceed.

## Runtime Policy

Implemented runtime checks:

- `permissionPreCheck()` runs before OpenCode ruleset evaluation when dll-agent is enabled.
- `auto-review` keeps high-risk operations as `ask`: secrets, `.env`, SSH keys, `git push`, release/publish/deploy, `sudo`, global installs, destructive deletes, and system-level modifications.
- `auto-review` allows commander/chief-engineer/executor project-local ordinary writes only when the project boundary is known.
- missing project boundary for writes records `permission.context_missing` and does not auto-allow.
- reviewer roles are read-only in normal policy checks: requirements-inspector, final-auditor, long-context-archivist, task-completion-archivist, role-cross, and multimodal-context-interpreter deny mutating tools.
- `full-access` allows all permission requests and writes `permission.full_access_override` evidence.

## Role Tool Policy

Mutating permission aliases covered by the built-in read-only role policy:

- `bash`
- `shell`
- `edit`
- `write`
- `file_write`
- `file_delete`
- `delete`
- `patch`
- `task`
- `todowrite`
- `workflow_tool_approval`

Writable roles:

- commander
- chief-engineer
- executor

Read-only roles:

- requirements-inspector
- long-context-archivist
- task-completion-archivist
- final-auditor
- role-cross
- multimodal-context-interpreter

## Doctor And Repair-safe

`dll-agent doctor` reports permission policy health, permission mode, role-tool-policy, evidence pressure, MCP residual process warnings, and quota staleness.

`dll-agent doctor --repair-safe` is constrained to safe operational repair:

- inactive session/evidence cleanup;
- managed MCP state reconciliation;
- stale Playwright MCP cleanup under its stale-age policy.

It must not touch secrets, push/release/deploy, modify system-level configuration, or delete active sessions.

`dll-agent doctor --repair-safe --dry-run` is the default hygiene inspection path before cleanup. It only reports:

- evidence session pressure;
- active/protected sessions;
- inactive session cleanup candidates;
- per-session evidence file trim candidates;
- residual Playwright MCP candidates;
- quota staleness and the refresh command.

Dry-run does not delete files, does not touch secrets, does not refresh quota, and does not kill processes.

## Status

Implemented_runtime_verified:

- mode parser and `/permissions` rendering;
- dynamic permission mode switching;
- auto-review high-risk ask behavior;
- full-access explicit override evidence;
- read-only reviewer mutating alias coverage;
- role-tool-policy doctor check;
- permission mode doctor check.
- repair-safe dry-run wrapper smoke.

Partial_runtime:

- wrapper-level `doctor --repair-safe` is Python-side operational code; TypeScript tests cover policy and doctor reporting, while wrapper safety is verified by `py_compile` and smoke usage.
- actual repair-safe cleanup still requires explicit user authorization after dry-run.

Missing:

- interactive UI explanation before each Full Access override;
- per-session permission mode separate from global mode.

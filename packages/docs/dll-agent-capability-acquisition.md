# dll-agent Autonomous Capability Acquisition

Status: `Phase B2/C/D1/D2 implemented_runtime_verified` for controlled local-fixture acquisition flow.

This system is the controlled path for autonomous skill, MCP, tool, and software acquisition. Phase A defines the schema, risk classifier, audit packet shape, evidence hooks, and doctor checks. Phase B1 adds the local fixture quarantine/sandbox/rollback substrate. Phase B2/C/D1/D2 add a static-download pipeline, mock final-auditor policy gate, fixture sandbox smoke, and MCP metadata discovery. Runtime capability planning now treats missing abilities as acquisition work: low-risk registered installs can proceed automatically through guarded project-local install/verify, unresolved gaps become explicit acquisition actions, and missing credentials request authorization instead of being silently skipped. This checkpoint still does **not** execute arbitrary downloaded content, start high-risk MCP, read GitHub tokens, activate unverified third-party code, or install globally.

## Risk Levels

| Level | Meaning | Runtime policy |
| --- | --- | --- |
| R0 | Metadata only: public docs, README, manifest, version/help text | Auto inspect, evidence only |
| R1 | Static skill/schema/docs with no executable, no secrets, no runtime access | Auto register after validation |
| R2 | Executable package/MCP in project-local sandbox, no secrets or persistent service | Requires final-auditor packet, sandbox, smoke test, rollback before auto activation |
| R3 | Browser automation, private token/repo, network service, long-running process, high-cost API, or dll-agent governance self-upgrade | Requires final-auditor and user authorization |
| R4 | Secrets/cookies/SSH/keychain, `curl | sh`, `sudo`, global install, shell rc/system mutation, destructive delete, git push/release/upload, production mutation, unknown binary, real browser profile | Hard blocked by default; auditor cannot auto-approve |

## Phase A Runtime Boundary

Implemented:

- `capability-acquisition.ts`: lifecycle records, install manifest validation, audit packet shape, evidence writer, doctor acquisition checks.
- `capability-risk-classifier.ts`: deterministic R0-R4 classifier with hard-rule precedence.
- doctor includes acquisition store/manifest checks without creating directories or mutating files.
- tests cover risk classification, manifest validation, hard blocks, evidence redaction, and doctor visibility.

Partial:

- final-auditor integration is schema-only; no live auditor call.
- quarantine/sandbox/rollback was not active at the Phase A checkpoint; Phase B1 now provides only the local fixture substrate described below.
- commands such as `/capability-install` are not wired yet.

Not implemented:

- arbitrary external software execution.
- high-risk MCP start without user authorization.
- external registry fetch with private tokens.
- full interactive `/capability-*` command layer.

## Safety Rules

- External content must enter quarantine first in later phases.
- Quarantine is never added to `PATH`.
- R2+ requires rollback before install/activation.
- R3 requires user authorization even if final-auditor approves.
- R4 remains hard-blocked by deterministic policy.
- Third-party skills are untrusted until manifest, checksum, and role allowlist pass.
- Software installs must be project-local or sandbox-local unless explicitly authorized.
- Missing skills/MCP/software must not be silently skipped: the runtime should use an existing registered capability, auto-install a low-risk project-local dependency, run local discovery for gaps, or surface an explicit authorization/acquisition action.
- Skill lookup is metadata-driven rather than alias-driven: tool-style requests such as `id:tool` are resolved through tool/capability catalog fields (`id`, `name`, `skill_ref`, triggers, descriptions, prompt index/detail) and currently installed skill metadata. Adding a new tool should require catalog/manifest metadata, not a source-code alias table.
- Capability planning is multi-capability by default: a task can select primary, support, validation, and fallback capabilities from registry metadata. The planner must not assume a single skill/MCP/software is sufficient when multiple available capabilities improve correctness or verification.

## Doctor

Doctor checks:

- acquisition store initialized or not;
- acquisition directory presence;
- install manifest parse/validation;
- missing rollback on R2+;
- R4 manifest activation attempts;
- secret access declarations.

Doctor Phase A checks are read-only and do not delete files, start processes, download packages, or touch secrets.

## Phase B1 Quarantine / Sandbox / Rollback

Implemented:

- `capability-quarantine.ts`: creates, reads, updates, rejects, and deletes quarantined candidate manifests under the acquisition quarantine root.
- `capability-sandbox.ts`: creates a fixture-only sandbox, copies local fixture files, runs non-executing smoke checks based on required file presence, and records pass/fail state.
- `capability-rollback.ts`: builds rollback plans, validates managed paths, performs rollback dry-run, and executes rollback only for managed fixture quarantine/sandbox paths.
- doctor checks orphan quarantine candidates, failed or stale sandbox directories, missing rollback plans for passed sandboxes, global install command attempts, and potential secrets leak markers.
- evidence events cover `capability.quarantined`, `capability.sandbox_created`, `capability.sandbox_smoke_started`, `capability.sandbox_smoke_passed`, `capability.sandbox_smoke_failed`, `capability.rollback_planned`, `capability.rollback_dry_run`, `capability.rollback_executed`, and `capability.rollback_failed`.

Boundary:

- no arbitrary external download;
- no global npm/pip/brew install;
- no real GitHub release fetch;
- no MCP start;
- no Playwright start;
- no live final-auditor call;
- no unverified third-party capability activation;
- no global environment mutation.

Rollback rules:

- rollback dry-run is required before execution;
- execution can only remove managed fixture quarantine/sandbox paths;
- session/evidence/cache/secrets and unmanaged paths are refused;
- missing rollback plan prevents activation in later phases.

## Phase B2 Static Download Trial

Implemented:

- `capability-download.ts`: validates http(s) URL, blocks executable extensions, blocks binary magic, enforces max size, computes sha256, writes static content under quarantine, creates rollback dry-run, and writes evidence.
- Tests use local fixture HTTP only when no user-provided GitHub raw URL is supplied.
- Static `SKILL.md`, `README.md`, `manifest.json`, and `schema.json` are treated as R0/R1 quarantine candidates only.

Boundary:

- no random GitHub repository selection;
- no private GitHub URL or token usage;
- no binary download;
- no dependency install;
- no execution;
- no activation.

## Phase C Mock Final-Auditor Policy Gate

Implemented:

- `capability-audit-runtime.ts`: builds structured audit packets and enforces mock final-auditor decisions.
- R2 can proceed to fixture sandbox only after mock auditor pass.
- R3 always requires user authorization even if mock auditor passes.
- R4 hard-block cannot be overridden.

Boundary: no live final-auditor model call in this checkpoint.

## Phase D1 Fixture Sandbox Smoke

Implemented:

- R2 fixture candidates can be copied into sandbox and checked with non-executing required-file smoke tests.
- Rollback dry-run and fixture rollback remove only managed quarantine/sandbox paths.

Boundary: no GitHub package execution, no real install, no MCP start, no activation.

## Phase D2 MCP Metadata Discovery Only

Implemented:

- `capability-discovery.ts` classifies public MCP metadata candidates without fetching private data or using tokens.
- GitHub MCP is R3 when token/private repo/issue/PR/release/repo mutation capabilities are involved.
- Playwright/browser MCP metadata is R3 and remains on-demand/user-authorized.
- `modelcontextprotocol/servers` metadata is treated as reference/community mixed; individual servers need later risk assessment.

Boundary: metadata only; no MCP install/start, no Docker, no npm install, no token read.

Next phase requires explicit authorization before any real external GitHub raw URL download or low-risk package pilot.

## Runtime Acquisition Behavior

Implemented:

- Registered low-risk missing dependencies use `auto_install` when the install strategy is project-local or otherwise policy-approved.
- Missing token/key requirements become `ask_permission`, not `skip`, because the user must be told what authorization is needed.
- Missing capabilities with no install strategy become acquisition/authorization work, not silent degrade.
- Remaining capability gaps are represented as explicit `capability-gap:*` acquisition actions and evidence, so the UI/doctor can show why the task cannot proceed automatically yet.
- When initial planning finds gaps, the orchestrator runs local discovery and replans before reporting the gap.

Boundaries:

- No install may use `sudo`, `brew`, global npm/pip, `curl | sh`, `git push`, release/upload, real browser profile, or unknown binaries.
- R3 MCP/software still requires user authorization; R4 remains hard-blocked.

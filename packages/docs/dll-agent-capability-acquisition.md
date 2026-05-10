# dll-agent Autonomous Capability Acquisition

Status: `Phase B1 implemented_runtime_verified` for local fixture quarantine/sandbox/rollback substrate.

This system is the controlled path for future autonomous skill, MCP, tool, and software acquisition. Phase A defines the schema, risk classifier, audit packet shape, evidence hooks, and doctor checks. Phase B1 adds only a local fixture quarantine/sandbox/rollback substrate. It does **not** download external software, install real packages, execute unknown binaries, start MCP, activate capabilities, or call a live model.

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

- autonomous external download/install/start.
- persistent MCP acquisition.
- external registry fetch.
- live user authorization flow for capability install.

## Safety Rules

- External content must enter quarantine first in later phases.
- Quarantine is never added to `PATH`.
- R2+ requires rollback before install/activation.
- R3 requires user authorization even if final-auditor approves.
- R4 remains hard-blocked by deterministic policy.
- Third-party skills are untrusted until manifest, checksum, and role allowlist pass.
- Software installs must be project-local or sandbox-local unless explicitly authorized.

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

- no real external download;
- no real npm/pip/brew install;
- no real GitHub release fetch;
- no MCP start;
- no Playwright start;
- no live final-auditor call;
- no capability activation;
- no global environment mutation.

Rollback rules:

- rollback dry-run is required before execution;
- execution can only remove managed fixture quarantine/sandbox paths;
- session/evidence/cache/secrets and unmanaged paths are refused;
- missing rollback plan prevents activation in later phases.

Phase B2 may consider a low-risk real download pilot only after explicit authorization and a separate checkpoint.

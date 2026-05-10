# dll-agent Autonomous Capability Acquisition

Status: `Phase A implemented_runtime_verified`.

This system is the controlled path for future autonomous skill, MCP, tool, and software acquisition. Phase A defines the schema, risk classifier, audit packet shape, evidence hooks, and doctor checks. It does **not** download, install, execute, start MCP, or call a live model.

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
- quarantine/sandbox/rollback execution is not active yet.
- commands such as `/capability-install` are not wired yet.

Not implemented:

- autonomous download/install/start.
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

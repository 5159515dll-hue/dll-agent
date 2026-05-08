# dll-agent Role Model Registry

## Overview

The Role Model Registry is a unified system for managing which LLM model each dll-agent role uses. It replaces the previous hardcoded model mappings scattered across `profile.ts`, `supervisor.ts`, `agent.ts`, and `roleCommands()`.

## Architecture

```
session override > project override > global override > built-in default
```

### Three-tier override resolution

| Tier | Path | Scope |
|------|------|-------|
| Session | `~/.dll-agent/sessions/<sessionID>/supervisor.json` (field: `role_model_overrides`) | Per-session |
| Project | `<project>/.dll-agent/role-models.jsonc` | Per-project |
| Global | `~/.dll-agent/config/role-models.jsonc` | Machine-wide |
| Built-in | Code (hardcoded defaults in `role-model-registry.ts`) | Fallback |

## Supported Roles

| Role | Default Model | On-Demand Only |
|------|--------------|----------------|
| `commander` | `deepseek/deepseek-v4-pro` | No |
| `chief-engineer` | `deepseek/deepseek-v4-pro` | No |
| `requirements-inspector` | `zai/glm-5.1` | No |
| `long-context-archivist` | `kimi/kimi-k2.6` | No |
| `task-completion-archivist` | `kimi/kimi-k2.6` | No |
| `final-auditor` | `openai/gpt-5.5-pro` | **Yes** |
| `role-cross` | `deepseek/deepseek-v4-pro` | No |
| `executor` | `deepseek/deepseek-v4-pro` | No |
| `agentic-solver` | `deepseek/deepseek-v4-pro` (disabled) | Future |
| `multimodal-reader` | `openai/gpt-5.5-pro` (disabled) | Future |
| `voice-output` | `openai/gpt-5.5-pro` (disabled) | Future |

## Slash Commands

### `/role-models`
Show all roles with their current effective models, source, provider availability, and on-demand status.

### `/role-model-set <role> <provider/model> [--scope session|project|global]`
Set a role's model. Default scope is `session`.

Examples:
```
/role-model-set requirements-inspector mimo/mimo-v2.5-pro
/role-model-set long-context-archivist kimi/kimi-k2.6 --scope global
/role-model-set role-cross openai/gpt-5.5-pro --scope session
```

### `/role-model-reset <role> [--scope session|project|global|all]`
Reset a role's model override. Default scope is `session`.

### `/role-model-test <role>`
Run a lightweight smoke test for a role's current model.

### `/role-model-fallback-add <role> <provider/model> [--scope session|project|global]`
Add a fallback model to a role's fallback chain.

### `/role-model-fallback-remove <role> <provider/model> [--scope session|project|global]`
Remove a fallback model from a role.

## Configuration Files

### Global config (`~/.dll-agent/config/role-models.jsonc`)

```jsonc
{
  "version": 1,
  "roles": {
    "commander": {
      "primary": "deepseek/deepseek-v4-pro",
      "fallback": ["mimo/mimo-v2.5-pro"],
      "enabled": true
    },
    "requirements-inspector": {
      "primary": "zai/glm-5.1",
      "fallback": ["mimo/mimo-v2.5-pro", "openai/gpt-5.5-pro"],
      "enabled": true
    },
    "long-context-archivist": {
      "primary": "kimi/kimi-k2.6",
      "fallback": ["mimo/mimo-v2.5-pro"],
      "enabled": true
    },
    "final-auditor": {
      "primary": "openai/gpt-5.5-pro",
      "fallback": ["mimo/mimo-v2.5-pro"],
      "enabled": true,
      "onDemandOnly": true
    }
  }
}
```

### Project config (`<project>/.dll-agent/role-models.jsonc`)
Same format as global config. Overrides global config for matching roles.

## Fallback Mechanism

When a role's primary model provider has no API key configured, the registry tries each fallback model in order. The first available model wins.

If all fallbacks are unavailable, the primary model is used anyway (the caller should handle the error).

## Runtime Integration

### Profile (`profile.ts`)
- `roleRoster()`: reads effective models from registry (no hardcoded models)
- `roleCommands()`: model fields intentionally omitted — runtime resolves from agent config via registry
- `systemPrompt()`: references effective models

### Supervisor (`supervisor.ts`)
- `buildSubtask()`: resolves model from registry per reviewer role, with session override support
- `buildTaskCompletionSubtask()`: resolves model from registry
- `markReviewerCompleted()`: uses registry model for result ledger

### Agent (`agent.ts`)
- Agent defaults resolved from registry at startup via `resolveRoleModel()`
- Config overrides still work via existing `cfg.agent[key].model` mechanism

### Doctor (`dll-doctor.ts`)
- `checkRoleModelHealth()`: validates all role models, checks provider keys, flags voice/TTS models on coding roles, detects config conflicts

## Safety Rules

1. Switching commander model prompts a risk warning (session scope allowed)
2. `final-auditor` remains on-demand regardless of model change
3. Voice/TTS models rejected for coding roles (commander, chief-engineer, agentic-solver)
4. Missing provider keys: config saved but model marked `unavailable`, fallback used at runtime
5. Expired/rate-limited models: fallback to next available
6. Role permissions are separate from model selection

## Extending with New Models

To add a new model provider:

1. Add the provider (e.g., MiMo, Claude, Gemini) to the provider system
2. Update role model config:
   ```jsonc
   {
     "roles": {
       "commander": {
         "primary": "mimo/mimo-v2.5-pro"
       }
     }
   }
   ```
3. No code changes needed in `supervisor.ts`, `agent.ts`, or `profile.ts`

## Status

| Capability | Status |
|------------|--------|
| Role Model Registry with built-in defaults | ✅ Implemented |
| Three-tier override (session > project > global) | ✅ Implemented |
| `/role-models` slash command template | ✅ Implemented (template, execution via commander) |
| `/role-model-set` with scope support | ✅ Implemented |
| `/role-model-reset` with scope support | ✅ Implemented |
| `/role-model-test` smoke test template | ✅ Implemented |
| `/role-model-fallback-add/remove` | ✅ Implemented |
| `profile.ts` uses registry (no hardcoded models) | ✅ Implemented |
| `roleCommands()` uses registry | ✅ Implemented (model field removed for runtime resolution) |
| `agent.ts` uses registry for defaults | ✅ Implemented |
| `supervisor.ts` modelMap replaced with registry | ✅ Implemented |
| `supervisor.ts` markReviewerCompleted fixed | ✅ Implemented |
| `supervisor.ts` buildTaskCompletionSubtask fixed | ✅ Implemented |
| `role-cross` model unified (deepseek, not zai) | ✅ Fixed |
| Doctor role model health check | ✅ Implemented |
| Evidence written on model changes | ✅ Implemented |
| Fallback chain resolution | ✅ Implemented |
| Provider availability checking | ✅ Implemented |
| Voice/TTS model guard | ✅ Implemented |
| Config conflict detection (global+project overlap) | ✅ Implemented |
| Tests (37 tests, all pass) | ✅ Implemented |
| Typecheck (4/4 pass) | ✅ Verified |
| Full test suite (569/569 pass) | ✅ Verified |
| Doctor (PASS/WARN, no FAIL) | ✅ Verified |
| Session override real-time refresh for slash commands | ⚠️ Partial — session overrides applied at supervisor auto-trigger time; slash commands use agent model loaded at startup |
| Model context limits from registry | ⚠️ Partial — `MODEL_CONTEXT_LIMITS` table still hardcoded in supervisor.ts |

## Implementation Files

| File | Change |
|------|--------|
| `src/dll-agent/role-model-registry.ts` | **New**: Core registry module |
| `src/dll-agent/interfaces.ts` | Added `role_model_overrides` to SupervisorState, new EvidenceRecordTypes |
| `src/dll-agent/profile.ts` | Refactored: roleRoster/roleCommands/systemPrompt use registry, added 6 new commands |
| `src/dll-agent/supervisor.ts` | Refactored: modelMap → registry, fixed role-cross bug, dynamic prompt templates |
| `src/agent/agent.ts` | Refactored: 7 hardcoded Provider.parseModel → registry calls |
| `src/dll-agent/dll-doctor.ts` | Added `checkRoleModelHealth()` |
| `test/dll-agent/role-model-registry.test.ts` | **New**: 37 tests |

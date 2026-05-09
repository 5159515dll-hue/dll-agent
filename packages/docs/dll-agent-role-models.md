# dll-agent Role Model Registry

## Overview

The Role Model Registry is a unified system for managing which LLM model each dll-agent role uses. It replaces the previous hardcoded model mappings scattered across `profile.ts`, `supervisor.ts`, `agent.ts`, and `roleCommands()`.

## Architecture

```
explicit session override
> session role override
> project role override
> global role override
> built-in role default
> Provider default model fallback
```

Role Model Registry is the unified entry point for dll-agent role model selection. It does not replace the OpenCode Provider system. Every effective role model must still be validated by `Provider.Service.getModel()` before use.

`role-provider-bridge.ts` is the runtime boundary that enforces this rule. The registry returns an `EffectiveRoleModel`; the bridge validates candidates through OpenCode Provider, records provider metadata, applies fallback/default decisions, and writes a provider-validated session snapshot for TUI/doctor/status surfaces.

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
显示所有角色当前配置的模型、来源（内置/全局/项目/会话）、provider 诊断 hint 及按需调用状态。该命令本地渲染状态，不触发 LLM。

### `/role-model-set <role> <provider/model> [--scope session|project|global]`
为指定角色设置当前使用模型。默认 scope 为 `global`，因为用户通常期望主执行模型切换后跨会话生效。
如果显式写入 `global` 或 `project`，当前 session 中同角色的旧 session override 会被清除，避免 UI 显示“会话覆盖”并继续压住全局配置。
该命令写入 Role Model Registry 的 override 链，并在写入前通过 Provider resolver 校验目标模型，不触发 LLM。

示例：
```
/role-model-set requirements-inspector mimo/mimo-v2.5-pro
/role-model-set long-context-archivist kimi/kimi-k2.6 --scope global
/role-model-set role-cross openai/gpt-5.5-pro --scope session
```

### Removed prompt-only commands
以下命令曾作为 prompt-only 模板存在，但没有本地 runtime handler，容易让用户误以为配置已经被可靠修改。本轮已从注册命令中移除：

- `/role-model-reset`
- `/role-model-test`
- `/role-model-fallback-add`
- `/role-model-fallback-remove`

当前 runtime-verified 入口只保留 `/role-models` 和 `/role-model-set`。

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

The registry stores fallback lists and source/scope. Runtime availability is decided by OpenCode Provider resolution, not by registry env-key checks. Registry `providerAvailable` is only a diagnostic hint for status UI.

If all role candidates fail Provider resolution, prompt/session code may use Provider default model as the final validated fallback and must write routing evidence.

## Provider Boundary

Role Model Registry owns role mapping, session/project/global overrides, fallback lists, source/scope, and user-visible role model status.

OpenCode Provider owns provider existence, model metadata, API key/baseURL, transport, request body transformation, `reasoning_effort` compatibility, tool calling, multimodal capability, quota/status, and provider errors.

The registry must not bypass `Provider.Service` or provider-specific request normalization.

## Runtime Integration

### Role Provider Bridge (`role-provider-bridge.ts`)
- `resolveRoleProvider()` resolves a role through the registry, validates primary/fallback candidates with `Provider.Service.getModel()`, and falls back to `Provider.Service.defaultModel()` only when all role candidates fail.
- `resolveRoleProviderModel()` is the small runtime adapter used by prompt/session and agent registration paths.
- `resolveRoleProviderHint()` is sync and hint-only; it is allowed for supervisor subtask metadata before the real runtime execution path provider-validates the model.
- `readRoleProviderSnapshot()` lets TUI/doctor display the latest provider-validated runtime model instead of independently deciding a different model.
- `role-model-runtime.ts` remains as a compatibility wrapper; new runtime code should call the bridge directly.

### Profile (`profile.ts`)
- `roleRoster()`: reads effective models from registry (no hardcoded models)
- `roleCommands()`: model fields intentionally omitted — runtime resolves from agent config via registry
- `systemPrompt()`: references effective models

### Supervisor (`supervisor.ts`)
- `buildSubtask()`: records a bridge hint for reviewer model metadata; actual execution is resolved by prompt/session through Provider validation
- `buildTaskCompletionSubtask()`: records a bridge hint for metadata
- `markReviewerCompleted()`: uses bridge hint for Result Ledger model attribution

### Session prompt (`prompt.ts`)
- TUI model picker selections for commander are converted into commander global overrides by default.
- `/role-model-set` writes into the same override chain; explicit `--scope session` remains available for temporary experiments.
- Prompt execution uses the effective role model resolver; it does not manually stitch together separate `input.model`, agent model, and registry paths.
- The resolved model is provider-validated before the user message is persisted.
- Runtime role model resolution now calls Role Provider Bridge.

### Agent (`agent.ts`)
- Agent defaults resolved through Role Provider Bridge and `Provider.Service.getModel()`
- Config overrides still work via existing `cfg.agent[key].model` mechanism

### Doctor (`dll-doctor.ts`)
- `checkRoleModelHealth()`: validates all role models, checks provider keys, flags voice/TTS models on coding roles, detects config conflicts
- `role-provider-bridge`: checks the active session provider-validated model snapshot when a session is active

## Safety Rules

1. Switching commander model writes global scope by default; explicit session scope remains available
2. `final-auditor` remains on-demand regardless of model change
3. Voice/TTS models rejected for coding roles (commander, chief-engineer, agentic-solver)
4. Missing provider keys: config saved but model marked `unavailable`, fallback used at runtime
5. Expired/rate-limited models: fallback to next available
6. Role permissions are separate from model selection

## Reasoning Effort Compatibility

`reasoningEffort` may come from registry config, wrapper-generated model options, agent options, or explicit variants. Before providerOptions/SDK invocation, `ProviderTransform.normalizeReasoningOptions()` applies a final provider/model-aware guard:

- supported `max` stays `max`
- OpenAI-compatible low/medium/high models map `max` to `high`
- unsupported models omit `reasoningEffort`
- snake_case `reasoning_effort` is normalized and never leaks as illegal `max`

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
| `/role-models` slash command | ✅ Implemented as local status command, no LLM call |
| `/role-model-set` with scope support | ✅ Implemented as local mutation command, no LLM call |
| `/role-model-reset` with scope support | removed_prompt_only |
| `/role-model-test` smoke test template | removed_prompt_only |
| `/role-model-fallback-add/remove` | removed_prompt_only |
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
| Provider availability checking | ✅ Provider.Service is final authority; registry hint only |
| Role Provider Bridge | ✅ Implemented runtime boundary and provider-validated snapshot |
| Voice/TTS model guard | ✅ Implemented |
| Config conflict detection (global+project overlap) | ✅ Implemented |
| Tests (37 tests, all pass) | ✅ Implemented |
| Typecheck (4/4 pass) | ✅ Verified |
| Full test suite (569/569 pass) | ✅ Verified |
| Doctor (PASS/WARN, no FAIL) | ✅ Verified |
| Session override real-time refresh for slash commands | ✅ prompt/session resolves effective role model at runtime |
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

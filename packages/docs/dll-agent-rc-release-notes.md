# dll-agent Release Candidate 说明

状态：RC candidate，不是全局 live verified。

当前全局结论必须保持 `GLOBAL-PARTIAL`。Phase 10 deterministic/local evaluation 已通过，但 manual/live 场景尚未运行，不能写成 `GLOBAL-PASS`。

## 本轮改造目标

本 RC 汇总 dll-agent 从 P0/P1 止血到 Phase 10 deterministic/local evaluation 的结果，目标是形成可检查、可回滚、可验收的候选版本。

本轮只做收尾整理：

- 统一文档口径；
- 整理能力状态矩阵；
- 审查未提交 diff；
- 汇总 release notes；
- 明确回滚方案；
- 明确下一步 live/manual 验收计划。

## 核心功能

- Goal Contract / Task State。
- Continuation Gate / Final Gate。
- Autonomous Recovery Loop。
- Result Ledger / Dedup hard-block / Stale detection。
- Correctness-aware model routing / routing evidence。
- Multi-model reviewer / reconciliation / role-cross。
- ContextHandoffPacket / Reviewer Output Normalization。
- Role Provider Bridge / Role Model Registry。
- MiMo provider status。
- Permissions / Role Tool Policy / doctor repair-safe dry-run。
- Capability Registry / MCP on-demand runtime / LSP project-main prewarm。
- multimodal-context-interpreter packet。
- UX State / Task Status / Observability。
- Regression scenario deterministic/local evaluation。
- Architecture modularization。

## 不变量

- 不改 Provider/RoleModel 边界。
- 不改 reasoning normalization。
- 不改 routing/gates/recovery/permissions/MCP/LSP/multimodal 语义。
- 不新增模型。
- 不新增 reviewer。
- 不启动 MCP。
- 不运行 live model。
- 不访问 GitHub token。
- 不自动 push。
- deterministic pass 不是 live pass。
- manual/live not_run 不能写成 passed。
- doctor failed 时不能 PASS。

## 验证结果

截至本 RC：

- `bun run --cwd packages/opencode typecheck`：通过。
- `bun test --cwd packages/opencode test/dll-agent/`：通过。
- `/Users/dailulu/.local/bin/dll-agent` py_compile：通过。
- `/Users/dailulu/.local/bin/dll-agent-quota` py_compile：通过。
- `dll-agent doctor`：warn only，无 failed。
- `dll-agent doctor --repair-safe --dry-run`：只读 dry-run，无删除、无 secrets、无 kill。
- `git diff --check`：通过。

Phase 10 deterministic/local evaluation：

| 指标 | 值 |
|---|---:|
| total | 20 |
| deterministic_pass | 20 |
| deterministic_fail | 0 |
| false_pass_risk | 0 |
| unnecessary_reviewer_scenarios | 0 |
| human_intervention_scenarios | 2 |
| external not_run | 17 |
| manual_not_run | 2 |
| live_not_run | 1 |

## Doctor Warn

当前 warn 不阻断 RC：

- runtime config API keys in memory：启动期预期 warn，不写入磁盘。
- evidence sessions nearing limit：可在用户授权后运行 `dll-agent doctor --repair-safe` 清理 inactive sessions。
- quota stale：可运行 `/Users/dailulu/.local/bin/dll-agent-quota` 刷新。

如果 doctor 出现 failed，RC 不能 PASS。

## 已知限制

- manual secrets/permission 场景未运行。
- destructive command block 场景未运行。
- live provider 最小请求未运行。
- live MiMo multimodal screenshot packet 未运行。
- Playwright MCP isolated start/stop 未运行。
- Result Ledger 仍是 session-scoped。
- 低层单个 tool-call 全局 dedup 仍是 partial；reviewer/final/continuation/recovery dispatch 层 dedup 已实现。
- architecture modularization 仍是 partial；`supervisor.ts` 和底层包路径仍保留历史兼容结构。

## 回滚方案

- 首选使用 git 回滚到最近 checkpoint commit。
- 不要手动删除 session/evidence 文件作为回滚。
- 如需清理 evidence sessions，先运行 `dll-agent doctor --repair-safe --dry-run`，确认只影响 inactive session 后再由用户授权执行实际 cleanup。
- 如 quota stale，只运行 `dll-agent-quota` 刷新，不影响代码状态。

## 下一步 live/manual 验收计划

这些项目本 RC 不执行，只作为后续验收计划：

| 验收项 | 需要用户授权 | 会产生费用 | 写 session/evidence | 外部 API | 安全风险 | Pass criteria |
|---|---|---:|---:|---:|---|---|
| live `/role-model-set commander` 切换并执行最小请求 | 是 | 可能 | 是 | 是 | 低 | resolver/source/global 生效，真实请求使用同一模型，无 reasoning_effort=max |
| live MiMo multimodal screenshot packet | 是 | 是 | 是 | 是 | 中 | 只触发 multimodal-context-interpreter，生成 packet，不替代测试/doctor |
| manual secrets/permission block | 是 | 否 | 是 | 否 | 高 | secrets 读取被 ask/block，不泄露 secret 值 |
| manual destructive command block | 是 | 否 | 是 | 否 | 高 | `rm -rf` / `sudo` / `git push` 不被 Auto-review 放行 |
| actual `doctor --repair-safe` cleanup | 是 | 否 | 是 | 否 | 中 | 只清理 inactive sessions，不触碰 secrets，不 kill active process |
| optional Playwright MCP isolated start/stop | 是 | 否 | 是 | 可能 | 中 | isolated profile，mutex 生效，healthcheck/stop 记录 evidence |
| real task: code bug -> test fail -> recovery -> verification | 是 | 可能 | 是 | 可能 | 中 | failure classified，recovery decision，修复后测试通过 |
| real task: unfinished plan -> continuation -> verified complete | 是 | 可能 | 是 | 可能 | 中 | continuation packet 生成并续接，最终 verified complete 有 evidence |

## Commit 建议

建议 checkpoint commit，但不要自动 commit，不要 push。

建议 commit message：

```text
chore(dll-agent): harden rc docs and status matrix
```

# dll-agent

dll-agent 是面向本地工程治理的智能编程代理。它面向真实工程任务，不以“多模型堆叠”为目标，而是围绕用户目标、证据、验证、权限和可恢复执行建立闭环。

## 定位

dll-agent 负责在终端中协助完成工程任务，并在执行过程中持续维护以下状态：

- 用户目标和成功标准；
- 当前计划、阻塞项和后续动作；
- 角色模型选择和实际运行模型；
- 工具权限、风险等级和安全边界；
- 测试、类型检查、doctor、diff 等验证证据；
- reviewer、仲裁、恢复、续接和最终 gate 的结论；
- quota、成本、本地估算和模型使用轨迹。

最终报告不能只依赖自然语言声称完成。只有目标满足、验证执行、Result Ledger 有结果、Evidence refs 充分、final / continuation / evidence / dedup gates 通过，并且 doctor 无 failed 时，才允许声明 verified complete。

## 核心能力

- Goal Contract：保存原始用户目标、成功标准、约束和必需验证。
- Continuation Gate：在目标未完成、验证未运行、reviewer 阻塞或 doctor failed 时阻断 final PASS。
- Autonomous Recovery：普通命令错误、测试失败、类型检查失败和 repeated failure 进入自动恢复路径。
- Result Ledger：记录可复用结果，阻止 stale、partial、failed 或缺 evidence 的结果被误用。
- Correctness-Aware Routing：按风险、失败状态、证据缺口和能力需求选择 commander 或 reviewer。
- ContextHandoffPacket：用结构化 packet 传递目标、计划、验证、证据和结果 refs，避免模型间自由文本交接丢信息。
- Role Provider Bridge：角色模型选择统一进入 provider 校验，不绕过 provider metadata、key、baseURL、request normalization 和 quota/status。
- Role Tool Policy：reviewer、final-auditor、long-context-archivist、role-cross、多模态解释器默认只读；高风险工具需要确认。
- Capability Registry：按 built-in / global / project / session 合并 skill、tool、MCP、LSP、多模态能力；重型 MCP 默认 on-demand。
- Doctor / Observability：输出 doctor next action、task trajectory、model usage、routing report 和 regression scenario 状态。

## 快速使用

```bash
bun install
bun dev
```

常用命令：

```bash
dll-agent
dll-agent doctor
dll-agent doctor --repair-safe --dry-run
dll-agent-quota
```

常用会话命令：

```text
/dll-status
/task-status
/role-models
/role-model-set
/permissions
/quality
/verify
/team-review
/model-usage
/routing-report
/doctor-next
/regression-status
```

## 权限模式

- Default：默认安全策略。
- Auto-review：自动处理低风险动作，高风险、secrets、破坏性命令、远程发布和系统级修改仍需确认。
- Full Access：用户显式信任的全权限模式；它不是安全模式，doctor 会按真实风险显示。

`DLL_AGENT_AUTO_ALLOW` 不能绕过 secrets、`rm -rf`、`sudo`、`git push`、全局安装、系统级修改或远程发布等高风险边界。

## 验证

核心验证命令：

```bash
bun typecheck
bun test
python3 -m py_compile /Users/dailulu/.local/bin/dll-agent
python3 -m py_compile /Users/dailulu/.local/bin/dll-agent-quota
dll-agent doctor
git diff --check
```

当前全局口径：

- deterministic/local evaluation 已通过；
- manual/live 场景仍需单独验收；
- 未运行的 live provider、多模态、权限破坏性场景不能写成 passed；
- 因此 release candidate 状态应保持 GLOBAL-PARTIAL，直到 live/manual 场景完成。

## 文档

重点文档位于 `packages/docs`：

- `dll-agent-architecture.md`
- `dll-agent-self-improvement.md`
- `dll-agent-role-models.md`
- `dll-agent-result-handoff.md`
- `dll-agent-continuation-gate.md`
- `dll-agent-model-routing.md`
- `dll-agent-permissions.md`
- `dll-agent-tools.md`
- `dll-agent-observability.md`
- `dll-agent-regression-scenarios.md`
- `dll-agent-rc-release-notes.md`

文档状态必须明确区分 runtime verified、deterministic verified、mock verified、config verified、partial、manual not_run、live not_run、missing 和 blocked_by_external。

## 维护原则

- 不把 provider 职责塞进 Role Model Registry。
- 不让 role registry 绕过 provider 校验。
- 不让 `reasoning_effort=max` 进入不支持该值的 provider 请求。
- 不为了省 token 跳过 correctness-required reviewer。
- 不把 summary 当 evidence。
- 不把 partial 写成 complete。
- 不让 final report 状态表误触发 continuation。
- 不自动 push。

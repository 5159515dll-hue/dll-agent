# dll-agent 文档

这里保存 dll-agent 的架构、运行状态、验证、权限、模型路由、上下文交接、doctor 和回归场景文档。

## 维护规则

- 文档必须区分已实现、部分实现、未实现、mock verified、live not_run 和 manual not_run。
- deterministic/local evaluation 不能写成 live verified。
- doctor warn 不能伪装成 ok；doctor failed 不能写 PASS。
- summary 不能替代 evidence。
- prompt-only 不能写成 runtime capability。

## 重点文档

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

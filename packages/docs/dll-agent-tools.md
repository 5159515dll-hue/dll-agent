# dll-agent Tools & MCP System

dll-agent 的全局默认 tools / skills / MCP 注册与按需加载系统。

## 设计原则

1. **默认注册 ≠ 默认启动** — 所有工具在 global manifest 中声明，但重型 MCP 标记为 `on_demand`，不自动启动。
2. **默认可用 ≠ 默认注入完整说明** — 只在 system prompt 中注入短索引（≤1200 chars），详细说明仅在触发时加载。
3. **项目隔离** — 项目级叠加清单只对当前项目和 session 生效，不污染全局清单。
4. **最小 prompt** — 全局工具索引、单个工具详细说明、每轮注入均有字符上限。
5. **留痕** — 所有 manifest 加载、merge、MCP 启动/失败/健康检查写入 evidence 且脱敏。

## 架构

```
~/.dll-agent/global/tools.jsonc ──┐
                                   ├──→ tool-overlay.ts (merge) ──→ effective manifest
<project>/.dll-agent/tools.jsonc ──┘                │
                                                     ├──→ tool-prompt.ts (prompt injection)
                                                     ├──→ mcp-manager.ts (on-demand start/mutex/healthcheck)
                                                     ├──→ toolbox.ts (doctor checks)
                                                     └──→ evidence.ts (log + redact)
```

## 模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 工具目录 | `tool-catalog.ts` | 12 个默认工具/MCP 声明（纯数据层）；schema 定义；触发关键词索引 |
| 项目叠加 | `tool-overlay.ts` | project overlay 加载；global+project merge；effective manifest 写入 session + evidence |
| Prompt 注入 | `tool-prompt.ts` | 最小 prompt index 构建（≤1200 chars）；on-demand 详细说明加载（≤1500/tool, ≤3000/round） |
| MCP 管理（桥接） | `mcp-manager.ts` | McpRegistration 类型；fromCatalogRegistration() 桥接 tool-catalog → mcp-manager |
| Doctor 检查 | `toolbox.ts:toolDoctorChecks()` | 8 项 tools/MCP 健康检查 |
| Slash 命令 | `profile.ts:roleCommands()` | /tools, /tools-reload, /tools-status, /mcp-status, /mcp-start, /mcp-stop, /mcp-health |
| 全局 manifest | `~/.dll-agent/global/tools.jsonc` | 12 个默认工具能力注册 |

## 全局默认工具清单

| id | name | kind | risk | start_policy | injection | 说明 |
|----|------|------|------|-------------|-----------|------|
| doc-docx | doc/docx | tool | low | — | on_demand | Word 文档处理 |
| pdf | pdf | tool | low | — | on_demand | PDF 文档处理 |
| ppt-pptx | ppt/pptx | tool | low | — | on_demand | 幻灯片处理 |
| xlsx | xlsx | tool | low | — | on_demand | 表格处理 |
| github | github | tool | medium | — | on_demand | GitHub 操作 |
| playwright | playwright | **mcp** | **high** | **on_demand** | on_demand | 浏览器自动化（重型） |
| engineering-test | engineering-test | tool | low | — | always | 工程测试 |
| observability | observability | command | low | — | on_demand | 监控诊断 |
| repo-doctor | repo-doctor | skill | low | — | always | 仓库健康检查 |
| security-redaction | security-redaction | skill | medium | — | always | 密钥脱敏 |
| docs-sync | docs-sync | skill | low | — | on_demand | 文档同步 |
| test-gate | test-gate | skill | medium | — | always | 测试门禁 |

## MCP 启动策略

| 策略 | 含义 | 默认应用 |
|------|------|----------|
| `disabled` | 永不启动 | — |
| `on_demand` | 仅通过 /mcp-start 或触发条件启动 | Playwright（重型 MCP） |
| `autostart_lightweight` | session 启动时自动启动（仅轻量 MCP） | 无默认轻量 MCP |

**重型 MCP（Playwright）要求：**
- 默认 isolated mode
- 同一 browser profile 不能启动两次（mutex）
- 同一 port 不能启动两次
- 不能默认接管用户真实浏览器会话
- 需用户确认才启动

## Merge 规则

优先级从高到低：

1. **内置安全 denylist** — security-redaction / test-gate 不可移除
2. **project remove** — 明确移除高于 global default
3. **project override** — 覆盖同名 MCP 配置
4. **project add** — 追加新能力
5. **global default** — 基础能力
6. **未声明能力不自动启用**

## Prompt 注入策略

| 限制 | 值 | 位置 |
|------|-----|------|
| 全局工具索引最大字符数 | 1200 | `tool-manifest.prompt.index_max_chars` |
| 单个工具详细说明最大字符数 | 1500 | `tool-manifest.prompt.tool_detail_max_chars` |
| 每轮工具说明总注入最大字符数 | 3000 | `tool-manifest.prompt.per_round_max_chars` |

**注入时机：**
- `always` 工具：索引始终在 system prompt 中
- `on_demand` 工具：仅当触发条件满足时加载详细说明

**触发来源：**
- 用户提到工具名（keyword regex match）
- 当前任务文件类型匹配（file extension）
- supervisor signals（test_failure / doctor_failure / browser_needed / github_needed）
- 测试失败 / doctor 失败
- 浏览器/端到端测试需求
- GitHub/CI/PR/issue 需求

## Doctor 检查项

`toolDoctorChecks()` 共 8 项：

1. **global-tools-manifest** — 全局 manifest 文件是否存在
2. **global-manifest-schema** — manifest schema 是否有效
3. **project-manifest-schema** — 项目 manifest schema（如存在）
4. **session-effective-manifest** — session effective manifest 是否写入
5. **mcp-state-dir** — MCP 状态文件列表
6. **mcp-\<name\>-health** — 各 MCP 运行状态（failed/degraded 报警）
7. **heavy-mcp-not-auto-started** — 重型 MCP 是否未被自动启动
8. **github-token** — token 存在性检查（不泄露 token 值）

## Slash 命令（已注册）

| 命令 | 说明 |
|------|------|
| `/tools` | 显示当前生效工具清单：global + project merge，区分 registered/available/active/running/failed/disabled/blocked |
| `/tools-reload` | 重新读取 global + project 清单并更新 session effective manifest（不启动 MCP） |
| `/tools-status` | 显示所有工具的详细状态 |
| `/mcp-status` | 显示所有 MCP server 状态：name/status/pid/health/last_check |
| `/mcp-start <name>` | 启动指定 MCP（检查注册/移除/healthcheck/确认/进程/端口/mutex） |
| `/mcp-stop <name>` | 停止指定 MCP（SIGTERM → releaseLock → markStopped → evidence） |
| `/mcp-health <name>` | 对指定 MCP 运行健康检查（进程存活 + healthUrl probe） |
| `/capability-status` | 直接渲染当前 capability registry / resolver / runtime 状态，不再只是提示词模板 |

## Artifact / Evidence 闭环

日期：2026-05-08

dll-agent 现在区分“业务源码修改”和“任务产物”。浏览器审计、E2E、UX audit 等任务生成的脚本、报告、截图、trace、log 会进入 artifact evidence，而不是被简单当成业务源码变更或自然语言声明。

| 产物 | 分类 | gate 行为 |
|------|------|-----------|
| `audit-full-browser.mjs` / `browser-test.mjs` | `generated_script` | 记录为任务审计脚本，不等同业务源码修改 |
| `files/*audit-report*.md` | `audit_report` | 解析 Total/PASS/FAIL/WARN；存在 FAIL 时不能 verified complete |
| `test-screenshots/*.png` | `screenshot` | 与 audit report 组合后算 real tool evidence |
| `.playwright-mcp/*.log` | `command_log` | 可作为浏览器/MCP 执行证据引用 |

重要规则：

- report + screenshots 证明“确实执行过浏览器审计”。
- report 中 `FAIL > 0` 证明“审计未完全通过”，只能 PARTIAL/BLOCKED，不能 PASS。
- 报告同时写 “No blocking issues found” 和 `FAIL > 0` 时，Completion Readiness Gate 会阻断 verified completion。
- 生成报告中的 password/token/API key/JWT 等敏感值会在 artifact 扫描时自动脱敏；密码表格列会写成 `REDACTED`。
- 如果旧 session 仍保留 “completion claim without verification evidence” 的历史 gate block，`session-reconciler.ts` 会在发现 artifact/result evidence 后清理或重分类该 block。
- `artifact-result-ledger.ts` 会把报告、截图、脚本补写为 `results.jsonl` 的 ResultPacket，避免 Result Ledger 断档。
- Artifact Ledger 是底层代码能力，不是 prompt-only 约束。

## 文件路径

| 层级 | 路径 | 格式 |
|------|------|------|
| 全局默认清单 | `~/.dll-agent/global/tools.jsonc` | JSONC |
| 项目叠加清单 | `<project>/.dll-agent/tools.jsonc` | JSONC |
| 项目叠加清单（备选） | `<project>/dll-agent.tools.jsonc` | JSONC |
| Session effective | `~/.dll-agent/sessions/<id>/effective-tools.json` | JSON (redacted) |
| MCP 状态文件 | `~/.dll-agent/mcp/<name>.json` | JSON |
| MCP 锁文件 | `~/.dll-agent/mcp/<name>.lock` | JSON |
| Quota 刷新 PID | `~/.dll-agent/quota/refresh.pid` | 单例后台刷新进程 |

## Project Overlay Schema

```jsonc
{
  "version": 1,
  "project": "my-project",
  "skills": {
    "add": ["custom-skill-id"],
    "remove": ["ux-review"]
  },
  "tools": {
    "add": [{ "id": "custom-tool", ... }],
    "remove": ["doc-docx"]
  },
  "mcp": {
    "add": [{ "id": "custom-mcp", "mcp": { ... }, ... }],
    "remove": ["playwright"],
    "override": {
      "playwright": { "start_policy": "disabled" }
    }
  },
  "commands": {
    "add": ["custom-command"],
    "remove": []
  },
  "security": {
    "extra_deny_commands": ["rm -rf node_modules"]
  }
}
```

## 安全策略

- GitHub token 未设置时显示 `limited` 或 `unavailable`，不显示 `failed`
- `ghp_` / `sk-` / `Bearer ` / `api_key` 在 evidence 中自动脱敏
- 内置 denylist 阻止移除 security-redaction 和 test-gate
- 项目可追加 `extra_deny_commands`，不能移除全局 denylist
- 重型 MCP 默认不启动，需用户确认

## 与 Skill 系统的关系

| 系统 | 层面 | 用途 |
|------|------|------|
| **tool-catalog** | 能力声明 | 注册哪些 tools/MCP 可用及如何加载 |
| **skill-registry** | 行为激活 | 根据信号激活特定行为模式（检查清单、约束、验证策略） |
| **tool-prompt** | prompt 注入 | 控制 tools 说明注入 prompt 的时机和字数 |
| **skill-loader** | 规则加载 | 控制 skill 规则的三层加载（metadata/summary/full） |

`tool-catalog` 和 `skill-registry` 是并列的，服务于不同目的。MCP 不是 skill，skill 不是 MCP，prompt 不是底层能力。

## 实现状态

| 特性 | 状态 | 说明 |
|------|------|------|
| 全局默认工具清单 | ✅ 底层代码实现 | `tool-catalog.ts` + `~/.dll-agent/global/tools.jsonc` |
| 项目级叠加清单 | ✅ 底层代码实现 | `tool-overlay.ts` merge logic |
| 运行中重新加载 | ✅ 底层代码实现 | `/tools-reload` 命令 + `buildEffectiveManifest()` |
| MCP 按需启动 | ✅ 最小闭环实现 | capability-orchestrator 在 session loop 中基于任务目标规划 MCP，并在 `resolveTools()` 前通过 `MCP.Service.add()` 接入 OpenCode MCP tools；mcp-manager 仍负责状态收敛/cleanup |
| MCP 健康检查 | ✅ 底层代码实现 | 进程存活检查、stale PID 状态收敛和本地 HTTP healthUrl probe 已实现；远程 healthUrl 默认跳过，避免无授权外部网络访问 |
| MCP 互斥锁 | ✅ 底层代码实现 | `acquireLock()` / `releaseLock()` in mcp-manager.ts |
| MCP 生命周期清理 | ✅ 底层代码实现 | `reconcileMcpStatus()` / `cleanupManagedMcp()`；只停止 dll-agent 管理过的过期 PID，不按字符串误杀未知进程 |
| Prompt 最小注入 | ✅ 底层代码实现 | `tool-prompt.ts` index/detail 分离 + 字符上限 |
| Evidence 记录 | ✅ 底层代码实现 | 所有 load/merge/start/stop 事件写入 evidence |
| Doctor 检查 | ✅ 底层代码实现 | `toolDoctorChecks()` 8 项检查 |
| Slash 命令实现 | ⚠️ 部分实现 | 命令模板在 profile.ts 中；实际执行依赖 commander agent 调用底层函数 |
| 测试覆盖 | ✅ 58 tests pass | `test/dll-agent/tools.test.ts` |
| 全局 manifest 文件 | ✅ 已创建 | `~/.dll-agent/global/tools.jsonc` |
| 安全脱敏 | ✅ 继承现有 | `evidence.ts:redact()` 统一脱敏 |
| 文档 | ✅ 本文档 | `packages/docs/dll-agent-tools.md` |

## Capability Runtime 接入状态

日期：2026-05-08

`capability-orchestrator.ts` 已把 tools/skills/MCP/software 的声明式 registry 接入 `session/prompt.ts` 主循环：

- 运行时从 builtin + global + discovered + project registry 合并有效能力。
- 根据最近用户目标、涉及文件、失败类型推断 required capability tags。
- 通过 resolver 输出 use / skill_activate / mcp_connect / ask_permission / blocked。
- `capability-action-runner.ts` 只执行低风险、项目 cwd、argv 形式的 auto_install；brew/sudo/global npm/git/gh/rm/curl/wget 等继续阻断。
- auto-install 成功后会执行 allowlisted verify commands，并写入 Result Ledger；验证失败则记录为 `PARTIAL`，不会当成 verified completion。
- 在 `resolveTools()` 前调用 OpenCode `MCP.Service.add()`，因此自动接入的 MCP 会被 `mcp.tools()` 暴露给模型。
- capability tags 会作为 skill intents 传给 `skills.ts`，新 skill/MCP/tool 只要声明 `capabilities + triggers` 就能被规划，不需要改任务分类器。
- final gate 已接入 capability gap/block：需要的能力未满足时不能写 verified completion。

仍需区分：

| 能力 | 状态 |
|------|------|
| Registry / planner / resolver | ✅ 底层代码实现 |
| Session runtime orchestration | ✅ 已接入 `prompt.ts` |
| MCP 进入 OpenCode tools | ✅ 通过 `MCP.Service.add()` 接入 |
| 低风险自动安装执行器 | ✅ 已实现，限制在项目内 argv allowlist |
| MCP HTTP healthUrl probe | ✅ 已实现本地 URL probe；远程 URL 默认跳过，避免 doctor/healthcheck 触发外部网络 |
| Slash 命令直接调用纯函数 | ⚠️ 仍主要是 commander 模板驱动 |
| `/capability-status` 直接状态输出 | ✅ 已实现，Command layer 调用 `renderCapabilityStatus()` |
| TUI sidebar capability 摘要 | ✅ 已实现，sidebar 插件调用 `buildCapabilitySidebarStatus()`；无任务时显示 registry/on-demand 摘要，有任务 todo 时显示 task selected / mcp auto / task permission |
| Artifact evidence → final gate | ✅ 已实现，`artifact-ledger.ts` + `evidence-normalizer.ts` + `completion-readiness.ts` 接入 `gates.ts`；浏览器审计有产物但有 FAIL 时阻断 verified completion |
| Report redaction / validation | ✅ 已实现，`report-validator.ts` 对 audit report 自动脱敏并检测 FAIL/无阻断矛盾、指标不一致、未覆盖项 |
| Session gate reconcile | ✅ 已实现，`session-reconciler.ts` 把旧 no-evidence block 迁移为当前 evidence/readiness 状态 |
| Artifact Result Ledger backfill | ✅ 已实现，`artifact-result-ledger.ts` 将报告/截图/脚本转为 ResultPacket |
| TUI task artifact state | ✅ 已实现，`task-state.ts` + capability sidebar 显示 artifact/result/blocker 推导出的 task 状态 |

## 下一步

1. 将 MCP lifecycle 状态与 OpenCode MCP status 做双向 reconcile
2. 为 remote MCP healthUrl 增加显式用户授权后的 probe
3. 将 capability sidebar 的运行中状态与 OpenCode 原生 MCP/LSP state 做更细粒度关联

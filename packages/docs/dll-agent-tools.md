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

## 文件路径

| 层级 | 路径 | 格式 |
|------|------|------|
| 全局默认清单 | `~/.dll-agent/global/tools.jsonc` | JSONC |
| 项目叠加清单 | `<project>/.dll-agent/tools.jsonc` | JSONC |
| 项目叠加清单（备选） | `<project>/dll-agent.tools.jsonc` | JSONC |
| Session effective | `~/.dll-agent/sessions/<id>/effective-tools.json` | JSON (redacted) |
| MCP 状态文件 | `~/.dll-agent/mcp/<name>.json` | JSON |
| MCP 锁文件 | `~/.dll-agent/mcp/<name>.lock` | JSON |

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
| MCP 按需启动 | ⚠️ 部分实现 | mcp-manager 锁/healthcheck 逻辑已就绪；与 opencode MCP Effect layer 的全链路桥接尚未完成 |
| MCP 健康检查 | ⚠️ 部分实现 | 进程存活检查已实现；HTTP healthUrl probe 尚未实现 |
| MCP 互斥锁 | ✅ 底层代码实现 | `acquireLock()` / `releaseLock()` in mcp-manager.ts |
| Prompt 最小注入 | ✅ 底层代码实现 | `tool-prompt.ts` index/detail 分离 + 字符上限 |
| Evidence 记录 | ✅ 底层代码实现 | 所有 load/merge/start/stop 事件写入 evidence |
| Doctor 检查 | ✅ 底层代码实现 | `toolDoctorChecks()` 8 项检查 |
| Slash 命令实现 | ⚠️ 部分实现 | 命令模板在 profile.ts 中；实际执行依赖 commander agent 调用底层函数 |
| 测试覆盖 | ✅ 58 tests pass | `test/dll-agent/tools.test.ts` |
| 全局 manifest 文件 | ✅ 已创建 | `~/.dll-agent/global/tools.jsonc` |
| 安全脱敏 | ✅ 继承现有 | `evidence.ts:redact()` 统一脱敏 |
| 文档 | ✅ 本文档 | `packages/docs/dll-agent-tools.md` |

## 下一步

1. 桥接 mcp-manager 与 `src/mcp/index.ts` 的 Effect layer（自动 markRunning/markStopped/degrade）
2. 实现 MCP healthUrl HTTP probe
3. 在 session prompt 中集成 `tool-prompt.ts` 的 index/detail 输出
4. 实现基于 context 的 on-demand MCP 自动启动

# dll-agent Upstream Sync Log

## 查询日期

2026-05-09

## 上游信息

| 项目 | 值 |
|------|-----|
| OpenCode 官方仓库 | `https://github.com/anomalyco/opencode` |
| 上游最新版本 | v1.14.41 (2026-05-07) |
| 本地基准版本 | v1.14.39 (2026-05-05) |
| 上游 changelog | `https://opencode.ai/changelog` |
| GitHub releases | `https://github.com/anomalyco/opencode/releases` |
| upstream remote | 未配置 |
| 本地 remote | `personal` → `https://github.com/5159515dll-hue/dll-agent.git` |

## 审查范围

审查了上游 v1.14.39 → v1.14.41 两个 patch 版本的变更（共 20+ 条目）。

## 候选更新清单

### v1.14.41 (2026-05-07)

| 条目 | 分类 | 决策 |
|------|------|------|
| Formatter 输出处理恢复 | must_absorb | skip — 无已知问题 |
| Workspace warp 携带未提交文件 | do_not_absorb_now | skip — slimming 后无此功能 |
| `/connect` 自定义 provider 恢复 | should_consider | skip — TUI `/connect` 已移除 |
| macOS Settings 菜单 | irrelevant | skip |
| Desktop 独立 utility 进程 | irrelevant | skip |
| ACP 模型/模式/effort 恢复 | irrelevant | skip |

### v1.14.40 (2026-05-07)

| 条目 | 分类 | 决策 |
|------|------|------|
| `.well-known/opencode` 远程配置 | do_not_absorb_now | skip |
| 保留签名 reasoning block 文本 | should_consider | skip — dll-agent 有自定义 DeepSeek 处理 |
| 清理 surrogate 字符 | should_consider | skip — 无已知崩溃 |
| 自动重试 server_overloaded | should_consider | skip — 无已知 overload |
| TUI 模型选择保持 | should_consider | **roadmap** — 可改善模型切换体验 |
| Compaction 摘要显示 | should_consider | skip |
| `/new` 使用当前工作区 | should_consider | skip |
| 编辑器选择上下文稳定 | should_consider | skip |
| CORS/Web/Mistral/Cloudflare 等 | irrelevant | skip |
| Desktop 剪贴板/EPIPE/自动更新等 | irrelevant | skip |

## 本轮吸收项

**无。**

## 跳过原因

1. 未配置 upstream remote，无法 cherry-pick
2. slimming 已移除 Desktop/ACP/Web 相关模块
3. 大部分修复针对非核心场景
4. dll-agent 当前 569 测试全部通过，doctor 无 FAIL
5. 无已知缺陷对应这些修复

## 后续 roadmap

| 优先级 | 条目 | 说明 |
|--------|------|------|
| 低 | 配置 upstream remote | `git remote add upstream https://github.com/anomalyco/opencode.git` |
| 低 | TUI 模型选择保持 | v1.14.40 的 "Keep selected model when data refreshes" |
| 低 | Formatter 修复 PR #26037 | 如果 dll-agent 出现格式化失效 |
| 低 | Surrogate 字符清理 | 从 v1.14.40 手动提取 |

## 验证结果

| 检查 | 结果 |
|------|------|
| Typecheck | ✅ 4/4 通过 |
| Tests | ✅ 569/569 通过 |
| Doctor | ✅ PASS/WARN |
| Git diff --check | ✅ clean |

## 审查策略

建议每 5-10 个上游版本审查一次，批量评估候选补丁。优先吸收明确 bugfix 且修改范围小的补丁。

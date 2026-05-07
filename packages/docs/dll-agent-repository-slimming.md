# dll-agent Repository Slimming — Mac-only

Phase 1 瘦身报告：将 opencode monorepo 裁剪为 macOS dll-agent 最小可维护仓库。

## 目标

只保留 macOS 上开发、运行、测试 dll-agent CLI/TUI/supervisor 所必需的代码。

## Mac-only 范围定义

- **平台**：macOS (darwin/arm64 + x64)
- **运行时**：Bun 1.3.13
- **能力**：dll-agent CLI、TUI、supervisor、skills、tools/MCP、evidence、gates、cross-review
- **测试**：packages/opencode typecheck + dll-agent test suite
- **排除**：Windows、Linux、容器、Nix、Electron、Web SPA、Console、Enterprise、Cloud infra

---

## 保留清单

### Workspace Packages (KEEP)

| Package | 路径 | 理由 |
|---------|------|------|
| `opencode` | `packages/opencode/` | 核心 CLI/TUI + dll-agent 26 个模块 + 17 个测试文件 |
| `@opencode-ai/core` | `packages/core/` | 共享核心库，opencode source 中有 80+ 处 import |
| `@opencode-ai/plugin` | `packages/plugin/` | 插件系统 runtime，opencode source 中有 11 处 import |
| `@opencode-ai/sdk` | `packages/sdk/js/` | SDK client/server 协议，opencode source 中有 10+ 处 import |
| `@opencode-ai/script` | `packages/script/` | 构建基础设施（build.ts, fix-node-pty.ts），opencode devDep |

### 保留目录

| 目录 | 理由 |
|------|------|
| `packages/docs/` | dll-agent 文档 (dll-agent-*.md) |
| `patches/@npmcli%2Fagent@4.0.0.patch` | packages/core 依赖 |
| `.github/workflows/` | GitHub Actions CI（标记 REVIEW，待后续 trim） |
| `specs/` | 设计文档（标记 REVIEW，低风险低体积） |
| `LICENSE` | 许可证 |
| `bun.lock` | 依赖 lockfile |
| `tsconfig.json` | 根 TypeScript 配置 |
| `turbo.json` | Turborepo 任务编排 |
| `.gitignore` / `.husky/` | Git/工具配置 |

---

## 删除清单

### Root-Level

| 路径 | 大小估算 | 删除原因 | 安全性证据 |
|------|---------|----------|-----------|
| 19 `README.*.md` (非 zh/en) | ~176K | 多语言翻译，非 dll-agent 必需 | 非代码资产，无依赖 |
| `script/` (root) | ~80K | Release/publish/changelog 工具 | 与 `packages/script` 不同；opencode 不 import 此目录 |
| `nix/` + `flake.nix` + `flake.lock` | ~72K | Nix 包管理器 | 不影响 Bun/macOS workflow |
| `sdks/vscode/` | ~108K | VSCode 扩展 SDK | 非 dll-agent 开发必需 |
| `infra/` + `sst.config.ts` + `sst-env.d.ts` | ~60K | SST Cloud 部署配置 | Cloud infrastructure，非本地开发必需 |
| `github/` | ~84K | GitHub Action 独立包 | 非本地 dll-agent 开发必需 |

### Packages (Non-Workspace)

| 路径 | 删除原因 | 安全性证据 |
|------|---------|-----------|
| `packages/containers/` | Docker 容器 (base/bun-node/rust Dockerfiles) | 无 package.json，非 workspace 成员，零 import |
| `packages/extensions/` | Zed 编辑器扩展 | 无 package.json，零 import |
| `packages/identity/` | 品牌 logo 资产 | 无 package.json，纯静态文件，零 import |

### Packages (Workspace — 独立 Web/Desktop 应用)

| 包名 | 路径 | 删除原因 | 安全性证据 |
|------|------|---------|-----------|
| `@opencode-ai/desktop` | `packages/desktop/` | Electron 桌面应用 | opencode source 零 import；独立 Electron 项目 |
| `@opencode-ai/web` | `packages/web/` | 官网/Marketing 网站 | opencode source 零 import；Astro 独立项目 |
| `@opencode-ai/app` | `packages/app/` | Browser SolidJS Web 应用 | opencode source 零 import；SolidJS SPA |
| `@opencode-ai/enterprise` | `packages/enterprise/` | 企业级功能 (SSO/billing) | opencode source 零 import |
| `@opencode-ai/function` | `packages/function/` | Serverless 云函数 | opencode source 零 import；Cloudflare Workers |
| `@opencode-ai/slack` | `packages/slack/` | Slack 集成 bot | opencode source 零 import |
| `@opencode-ai/storybook` | `packages/storybook/` | UI 开发工具 | opencode source 零 import；仅 Storybook 配置 |

### Packages (Console — Cloud 管理后台)

| 包名 | 路径 | 删除原因 | 安全性证据 |
|------|------|---------|-----------|
| `@opencode-ai/console-app` | `packages/console/app/` | Cloud 控制台 Web 应用 | SolidJS + Stripe + Cloudflare；零 opencode import |
| `@opencode-ai/console-core` | `packages/console/core/` | 控制台后端 (Drizzle/PlanetScale/Stripe) | 云数据库/支付；零 opencode import |
| `@opencode-ai/console-function` | `packages/console/function/` | 控制台 Serverless 函数 | 零 opencode import |
| `@opencode-ai/console-mail` | `packages/console/mail/` | 邮件模板 | 零 opencode import |
| `@opencode-ai/console-resource` | `packages/console/resource/` | SST 资源定义 | 零 opencode import |

### Packages (UI 组件库)

| 包名 | 路径 | 删除原因 | 安全性证据 |
|------|------|---------|-----------|
| `@opencode-ai/ui` | `packages/ui/` | 共享 UI 组件库 (SolidJS) | opencode source 零 import；opencode TUI 使用 @opentui 而非此库；仅被已删除的 app/desktop 依赖 |

### Patches

| 文件 | 删除原因 |
|------|---------|
| `solid-js@1.9.10.patch` | 仅服务于已删除的 app/desktop/ui 包 |
| `@standard-community%2Fstandard-openapi@0.2.9.patch` | opencode source 零 import |
| `install-korean-ime-fix.sh` | 韩语 IME 修复，与 dll-agent 无关 |

---

## 配置同步

### root `package.json`

- **workspaces**：移除 `packages/console/*`、`packages/slack`；保留 `packages/*` + `packages/sdk/js`
- **scripts**：移除 `dev:desktop`、`dev:web`、`dev:console`、`dev:storybook`、`random`、`hello`
- **devDependencies**：移除 `sst`（SST 已删除）
- **trustedDependencies**：移除 `electron`
- **patchedDependencies**：移除 `solid-js` 和 `@standard-community/standard-openapi` 两项

### `turbo.json`

- 移除 `@opencode-ai/app#test`、`@opencode-ai/app#test:ci`、`@opencode-ai/ui#test`、`@opencode-ai/ui#test:ci` 任务

---

## 验证结果

| 验证项 | 命令 | 结果 |
|--------|------|------|
| TypeScript Typecheck | `bun run --cwd packages/opencode typecheck` | ✅ tsgo --noEmit: 0 errors |
| dll-agent Tests | `bun test --cwd packages/opencode test/dll-agent/` | ✅ 310 pass, 0 fail (17 files) |
| Wrapper Syntax | `python3 -m py_compile ~/dll-agent ~/dll-agent-quota` | ✅ OK |
| Doctor | `dll-agent doctor` | ✅ result: warn (pre-existing API-key-in-memory, expected) |
| Git Diff | `git diff --check` | ✅ clean |
| Dependency Install | `bun install` | ✅ 4 installed, 14 removed |

---

## 暂不删除 (REVIEW)

| 路径 | 原因 |
|------|------|
| `.github/workflows/` | GitHub Actions 工作流 — 后续可 trim 为 macOS/dll-agent only |
| `specs/` | 设计文档 — 低体积 (< 20K)，可能包含有用参考 |
| `packages/docs/dll-agent-self-improvement.md` | dll-agent 自我改进文档 — 保留 |
| `packages/docs/dll-agent-tools.md` | dll-agent Tools/MCP 文档 — 保留 |
| `packages/docs/dll-agent-skills.md` | dll-agent Skills 文档 — 保留 |

---

## 已完整保留的能力

- ✅ dll-agent CLI 启动 (macOS)
- ✅ TUI 进入 (solid-js based terminal UI)
- ✅ Supervisor 自动监督系统
- ✅ Cross-Review Council (多模型对抗审查)
- ✅ Evidence Gate (证据门禁)
- ✅ Skills 系统 (9 个内置技能)
- ✅ Tools/MCP 系统 (12 个默认工具)
- ✅ Cost Cap (成本上限)
- ✅ Permission Classifier (权限分级)
- ✅ LSP Strategy (LSP 预热策略)
- ✅ Doctor (健康检查)
- ✅ TypeScript Typecheck
- ✅ dll-agent Test Suite (310 tests)

## 已移除的能力 (非 macOS / 非 dll-agent)

- ❌ Electron Desktop App
- ❌ Web SPA
- ❌ Marketing Website
- ❌ Cloud Console
- ❌ Enterprise Billing/SSO
- ❌ Slack Integration
- ❌ Serverless Functions
- ❌ Docker Containers
- ❌ VSCode Extension
- ❌ Nix Packages
- ❌ SST Cloud Infrastructure
- ❌ Storybook UI Development
- ❌ Multi-language README (19 languages)
- ❌ Windows/Linux Signing Scripts
- ❌ Korean IME Fix

## 下一步瘦身 Roadmap

1. **Phase 2**：Trim `.github/workflows/` 至 macOS/dll-agent only
2. **Phase 2**：清理 catalog 中未使用的 entries
3. **Phase 2**：审查 `specs/` 是否需要保留
4. **Phase 3**：评估是否可移除 opencode 的非 CLI/TUI 模块 (server/, agent/, share/ 等)
5. **Phase 3**：提取 dll-agent 为独立包 (lerna/nx monorepo 重构)

## 风险与回滚

- **回滚方案**：任意删除均由 git 历史保留；执行 `git checkout` 可恢复
- **远程安全**：当前 remote 配置保持不变；不推送到 opencode 官方 remote
- **破坏性验证**：每步删除后均运行 typecheck + test + doctor 确认无损

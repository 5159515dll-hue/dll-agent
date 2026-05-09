import { Config } from "@/config/config"
import z from "zod"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { zod } from "@/util/effect-zod"
import { withStatics, type DeepMutable } from "@/util/schema"
import { enabled as dllEnabled, autoAllowAll as dllAutoAllow, writeEvidence as dllLogEvidence, roleRoster as dllRoleRoster } from "@/dll-agent/profile"
import { resolveRoleModel, type DllRole } from "@/dll-agent/role-model-registry"
import { isReadOnlyRole, permissionConfigForRole } from "@/dll-agent/role-tool-policy"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
})
  .annotate({ identifier: "Agent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<{
    identifier: string
    whenToUse: string
    systemPrompt: string
  }>
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        // Phase 5: dll-agent 全权放行 ruleset。在 merge 末尾追加，因 evaluate 用 findLast，
        // 最末规则胜出，从而覆盖 defaults 中 ask/deny 的项目（如 external_directory:*、doom_loop）。
        // 仅在 dllAutoAllow() 为 true 时生效；用户可 DLL_AGENT_AUTO_ALLOW=0 关闭。
        const dllAllowAll: Permission.Ruleset = dllAutoAllow()
          ? Permission.fromConfig({
              "*": "allow",
              external_directory: { "*": "allow" },
              doom_loop: "allow",
              question: "allow",
              plan_enter: "allow",
              plan_exit: "allow",
            })
          : []

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: {
                  "*": "ask",
                  ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                },
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        if (dllEnabled()) {
          // Resolve role models from Role Model Registry
          // Uses project and global config overrides via resolveRoleModel().
          // Session overrides are not available at agent registration time;
          // they take effect via supervisor.ts auto-triggers and command execution.
          const roleModel = (role: DllRole) => {
            const effective = resolveRoleModel(role, undefined, ctx.directory)
            return Provider.parseModel(effective.primary)
          }
          const rolePermission = (role: DllRole) => Permission.fromConfig(permissionConfigForRole(role))

          // Phase 5 fix: dll-agent 自动放行所有权限 —— dllAllowAll 必须放在 user 之后，
          // 因为 Permission.evaluate 用 findLast，最末规则胜出。否则 defaults 中的
          // external_directory:* / question:ask / plan_enter:deny / *.env:ask 仍会触发弹权限。
          agents.commander = {
            name: "commander",
            description: "dll-agent commander. DeepSeek default executor/router; OpenAI is on-demand strategic audit only.",
            mode: "primary",
            native: true,
            model: roleModel("commander"),
            prompt:
              "You are the dll-agent commander and default executor. Keep the user's real goal as the controlling objective. Do normal planning, coding, debugging, and tool recovery yourself. The role team is implemented as real subagents, not just a prompt style. Call GLM/Kimi subagents for requirement drift or long-context checks. Call OpenAI final-auditor only when stuck after repeated attempts, off-track, in reviewer conflict, explicitly asked for OpenAI strategic review, or making a high-risk completion claim. Do not call OpenAI for ordinary status, ordinary planning, routine coding, or first-pass answers.",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
              dllAllowAll,
              rolePermission("commander"),
            ),
            options: {},
          }
          agents["chief-engineer"] = {
            name: "chief-engineer",
            description: "dll-agent chief engineer. Engineering execution/debugging role for real engineering work.",
            mode: "subagent",
            native: true,
            model: roleModel("chief-engineer"),
            prompt:
              "You are the dll-agent chief engineer subagent. Execute concrete engineering work, diagnose failures, use tools, install project-local dependencies when needed, and verify with real commands. Every claim must cite evidence.",
            permission: Permission.merge(defaults, user, dllAllowAll, rolePermission("chief-engineer")),
            options: {},
          }
          agents["requirements-inspector"] = {
            name: "requirements-inspector",
            description: "dll-agent requirements inspector. GLM Chinese intent, rule, and logic checker.",
            mode: "subagent",
            native: true,
            model: roleModel("requirements-inspector"),
            steps: 6,
            prompt:
              "You are the requirements inspector. Check Chinese user intent, contradictions, rule adherence, phase drift, and whether the work still serves the real user goal. Use the compact reviewer context first. Read only listed relevant files when needed. Do NOT run bash/typecheck/build/test/git or create subtasks. Emit the required JSON verdict.",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({ edit: "deny", read: "allow" }),
              user,
              dllAllowAll,
              rolePermission("requirements-inspector"),
            ),
            options: {},
          }
          agents["long-context-archivist"] = {
            name: "long-context-archivist",
            description: "dll-agent long-context archivist. Kimi logs, documents, baselines, and memory consistency checker.",
            mode: "subagent",
            native: true,
            model: roleModel("long-context-archivist"),
            steps: 6,
            prompt:
              "You are the long-context archivist. Check logs, documents, baselines, phase history, memory drift, and missing evidence. Use the compact reviewer context first. Read only listed relevant files/logs when needed. Do NOT run bash/typecheck/build/test/git or create subtasks. Emit the required JSON verdict.",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({ edit: "deny", read: "allow" }),
              user,
              dllAllowAll,
              rolePermission("long-context-archivist"),
            ),
            options: {},
          }
          agents["final-auditor"] = {
            name: "final-auditor",
            description: "dll-agent on-demand strategic/final auditor. GPT-5.5 Pro evidence and engineering reliability checker.",
            mode: "subagent",
            native: true,
            model: roleModel("final-auditor"),
            steps: 8,
            prompt:
              "You are the on-demand strategic/final auditor. Check evidence sufficiency, validation quality, strategic direction, engineering risk, and overclaiming before high-risk completion. This is a read-only audit role: do not run bash, edit files, patch files, spawn subtasks, or make changes.",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({ webfetch: "allow", websearch: "allow", read: "allow" }),
              user,
              dllAllowAll,
              rolePermission("final-auditor"),
            ),
            options: {},
          }
          agents["role-cross"] = {
            name: "role-cross",
            description:
              "dll-agent temporary role crossing agent. Use only for recovery, reviewer conflict, weak evidence, or long-context drift.",
            mode: "subagent",
            native: true,
            model: roleModel("role-cross"),
            prompt:
              "Temporarily inspect the task from another role's viewpoint. This is not a permanent role change. Gather missing information, find blind spots, propose actionable fixes, and then return control to the normal role roster.",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({ webfetch: "allow", websearch: "allow", read: "allow" }),
              user,
              dllAllowAll,
              rolePermission("role-cross"),
            ),
            options: {},
          }
          // dll-agent multimodal context interpreter: converts non-text inputs
          // (screenshots, images, webpage visuals, PPT figures, flowcharts, charts,
          // video, audio, UI, document visuals) into structured multimodal_context_packet.
          // Read-only: cannot modify files or run commands. On-demand only.
          agents["multimodal-context-interpreter"] = {
            name: "multimodal-context-interpreter",
            description: "dll-agent multimodal context interpreter. Converts non-text inputs into structured context packets.",
            mode: "subagent",
            native: true,
            model: roleModel("multimodal-context-interpreter"),
            steps: 4,
            prompt:
              "You are the dll-agent multimodal context interpreter. Your role is to analyze non-text inputs (screenshots, images, webpage visuals, PPT figures, flowcharts, charts, video, audio) and produce structured multimodal_context_packet outputs. You are read-only: do not modify files, run bash commands, or edit code. Your output feeds into the commander and reviewers for downstream decisions. Always include confidence levels and uncertainties — never claim absolute certainty from visual analysis.",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
              }),
              user,
              dllAllowAll,
              rolePermission("multimodal-context-interpreter"),
            ),
            options: {},
          }
          // dll-agent verifier/executor subagent: runs typecheck/test/doctor and pastes raw stdout.
          agents.executor = {
            name: "executor",
            description:
              "dll-agent verifier/executor. Runs typecheck/test/doctor on demand and pastes raw stdout as evidence.",
            mode: "subagent",
            native: true,
            model: roleModel("executor"),
            prompt:
              "You are the dll-agent verifier/executor. Use the bash tool to run requested verification commands (typecheck, test, doctor, build). Paste raw stdout verbatim — never paraphrase, never claim success without showing the exit code. Return a concise pass/fail summary at the end.",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({ question: "allow", plan_enter: "allow" }),
              user,
              dllAllowAll,
              rolePermission("executor"),
            ),
            options: {},
          }
          dllLogEvidence("agent.profile.enabled", {
            defaultAgent: cfg.default_agent ?? "commander",
            roleRoster: dllRoleRoster(),
          })
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Phase 5: dll-agent 全权放行兜底 —— 在所有 agent（含 build/general/config 自定义）
        // 的 permission 末尾追加 dllAllowAll。Permission.evaluate 用 findLast，最末规则胜出，
        // 因此这一步会覆盖 defaults / user / agent-specific 中残留的 ask/deny。
        // 例外：title/summary/compaction/explore/plan 是功能性角色（本身要 *:deny 限制工具），
        // 不能放行；它们也不直接接收用户任务，永远不会触发"用户授权弹窗"，跳过即可。
        if (dllAutoAllow()) {
          const skip = new Set([
            "title",
            "summary",
            "compaction",
            "explore",
            "plan",
          ])
          for (const name in agents) {
            if (skip.has(name) || isReadOnlyRole(name)) continue
            agents[name].permission = Permission.merge(agents[name].permission, dllAllowAll)
          }
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [
                (x) =>
                  cfg.default_agent
                    ? x.name === cfg.default_agent
                    : dllEnabled()
                      ? x.name === "commander"
                      : x.name === "build",
                "desc",
              ],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent.name
          }
          if (dllEnabled() && agents.commander) return "commander"
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible.name
        })

        return {
          get,
          list,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        const result = yield* InstanceState.useEffect(state, (s) => s.get(agent))
        dllLogEvidence("agent.get", {
          agent,
          resolved: result?.name,
          model: result?.model ? `${result.model.providerID}/${result.model.modelID}` : undefined,
        })
        return result
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: z.object({
            identifier: z.string(),
            whenToUse: z.string(),
            systemPrompt: z.string(),
          }),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Agent from "./agent"

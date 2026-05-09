# dll-agent 核心包

这里是 dll-agent 的核心运行包，包含命令行、终端界面、会话运行时、provider 接线、dll-agent 治理层和相关测试。

## 本地开发

```bash
bun install
bun dev
```

## 常用验证

```bash
bun typecheck
bun test test/dll-agent/
```

## 维护约束

- 不要绕过 Role Provider Bridge 直接拼接 role model。
- 不要让 Role Model Registry 承担 provider transport、key、baseURL、quota 或 request normalization。
- 不要把 reviewer、final-auditor、long-context-archivist、role-cross、多模态解释器设置为默认可写。
- 不要把 prompt-only 约束写成 runtime verified 能力。
- 不要把 partial、mock-only 或 live not_run 写成 passed。

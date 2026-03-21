# DD-0001: OpenClaw Native Adapter Plugin

**Status:** Draft
**Author:** Noah
**Date:** 2026-03-21
**Repo:** /home/darling/projects/agent-memory

---

## 1. Background / 背景

AgentMemory v5.1 已经具备完整的记忆内核能力（boot、surface、remember、recall、reflect、feedback），但在 OpenClaw 中仍然依赖外部编排（MCP server + cron job + 手写 AGENTS.md 指令）来串联记忆生命周期。

这导致几个问题：
- **boot 时机不可控**：依赖 agent 自行在 system prompt 中调用 `memory_search`，没有保证
- **surface 质量受限**：agent 只能用当前 user message 做检索，无法利用 OC 运行时已知的 session context、recent turns 等信息
- **remember 靠 cron**：`memory-sync` 定时扫描 session transcript，延迟高（最长 8 小时），且无法获取 OC 内部的 session 边界信号
- **feedback 缺失**：记忆被注入后是否真正被使用，完全无法追踪

OpenClaw 有成熟的 Plugin Hook System（24 个 hook），覆盖了完整的 agent 生命周期。社区用户 jayking0912 在 Issue #3 中正式提出了这个需求。

本设计文档定义一个 **OpenClaw 原生 adapter 插件**，作为 AgentMemory core 与 OpenClaw 运行时之间的适配层。

## 2. Goals / 目标

- **G1**: 创建独立 npm 包 `@smyslenny/agent-memory-openclaw`，作为标准 OpenClaw 插件
- **G2**: Phase 1 实现读路径——session 启动时自动 boot，回复前自动 surface 并注入 prompt
- **G3**: 保持 AgentMemory core 完全宿主无关，zero changes to core
- **G4**: 配置精简，开箱即用，6 个配置项覆盖 90% 场景
- **G5**: 在同一 session 内避免重复注入相同记忆

## 3. Non-Goals / 非目标

- **不改动 AgentMemory core**：adapter 只调用公共 API，不依赖内部实现
- **不替代现有 MCP/CLI/HTTP 传输层**：它们继续作为通用接入方式
- **不实现 auto-remember（Phase 2）**：本次只做读路径
- **不抽象 injectMode**：OC 的 `before_prompt_build` 已定义注入机制
- **不强制 embeddings**：adapter 与 core 一样，embeddings 可选
- **不做 OpenClaw core 修改**：完全基于现有 Plugin Hook API

## 4. Proposal / 方案

### 4.1 架构概述

```
┌─────────────────────────────────────────────────┐
│                  OpenClaw Gateway                │
│                                                  │
│  ┌──────────────┐    Plugin Hook System          │
│  │ Agent Runner  │◄──── before_prompt_build ─────┤
│  │              │◄──── session_start ────────────┤
│  │              │◄──── agent_end (Phase 2) ──────┤
│  │              │◄──── before_reset (Phase 2) ───┤
│  └──────────────┘                                │
│         │                                        │
│         ▼                                        │
│  ┌──────────────────────────────────────┐        │
│  │  @smyslenny/agent-memory-openclaw    │        │
│  │  (OpenClaw Plugin / Adapter)         │        │
│  │                                      │        │
│  │  ┌──────────┐  ┌───────────────┐     │        │
│  │  │BootManager│  │SurfaceManager │     │        │
│  │  └─────┬────┘  └──────┬────────┘     │        │
│  │        │               │              │        │
│  │        ▼               ▼              │        │
│  │  ┌──────────────────────────────┐     │        │
│  │  │   AgentMemory Core (v5.1+)   │     │        │
│  │  │   boot() / surface() / ...   │     │        │
│  │  └──────────────────────────────┘     │        │
│  └──────────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
```

### 4.2 项目结构

adapter 作为独立包发布，不放在 agent-memory 主仓库：

```
agent-memory-openclaw/
├── package.json              # @smyslenny/agent-memory-openclaw
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts              # 插件入口，导出 OpenClawPlugin
│   ├── plugin.ts             # 插件注册逻辑（on hook handlers）
│   ├── boot-manager.ts       # session_start → boot() 编排
│   ├── surface-manager.ts    # before_prompt_build → surface() 编排
│   ├── config.ts             # 配置解析与默认值
│   ├── session-state.ts      # session 级去重与状态管理
│   ├── format.ts             # surface 结果 → prompt block 格式化
│   └── types.ts              # 类型定义
├── tests/
│   ├── boot-manager.test.ts
│   ├── surface-manager.test.ts
│   ├── session-state.test.ts
│   ├── format.test.ts
│   └── integration.test.ts   # 合成 OC hook event 的集成测试
└── README.md
```

### 4.3 OpenClaw 插件注册

OpenClaw 插件通过 `plugin.on(hookName, handler)` 注册 hook handler。adapter 的入口：

```typescript
// src/plugin.ts
// 注意：OC Plugin 不通过 plugin.on() 注册——它通过 OpenClawPlugin 的 hooks 数组声明。
// 每个 hook 是 { hookName, handler, priority? } 对象。

import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookSessionStartEvent,
  PluginHookSessionContext,
  PluginHookAgentContext,
  PluginHookBeforeResetEvent,
} from "openclaw/plugins/types"; // OC 导出的类型

import type { OpenClawPlugin } from "openclaw/plugins/types";
import { BootManager } from "./boot-manager.js";
import { SurfaceManager } from "./surface-manager.js";
import { resolveConfig, type AdapterConfig } from "./config.js";

export function createPlugin(rawConfig?: Record<string, unknown>): OpenClawPlugin {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) return { hooks: [] };

  const bootManager = new BootManager(config);
  const surfaceManager = new SurfaceManager(config);

  const hooks = [];

  // Phase 1: 读路径
  if (config.autoBoot) {
    hooks.push({
      hookName: "session_start" as const,
      handler: async (
        event: PluginHookSessionStartEvent,
        ctx: PluginHookSessionContext
      ) => {
        await bootManager.onSessionStart(event, ctx);
      },
    });
  }

  if (config.autoSurface) {
    hooks.push({
      hookName: "before_prompt_build" as const,
      handler: async (
        event: PluginHookBeforePromptBuildEvent,
        ctx: PluginHookAgentContext
      ): Promise<PluginHookBeforePromptBuildResult | void> => {
        return surfaceManager.onBeforePromptBuild(event, ctx);
      },
    });
  }

  // Session 边界清理
  hooks.push({
    hookName: "before_reset" as const,
    handler: async (
      _event: PluginHookBeforeResetEvent,
      ctx: PluginHookAgentContext
    ) => {
      if (ctx.sessionId) {
        bootManager.clearSession(ctx.sessionId);
        surfaceManager.clearSession(ctx.sessionId);
      }
    },
  });

  // Phase 2（未来）: 写路径
  // hooks.push({ hookName: "agent_end", handler: ... });

  return { hooks };
}
```

### 4.4 BootManager 详细设计

**触发时机**: `session_start` hook（void hook，不返回值）

**职责**:
1. 调用 `boot()` 或 `warmBoot()` 加载 identity / pinned 记忆
2. 将 boot 结果缓存到 session 级状态（同一 session 不重复 boot）
3. boot narrative 通过 `before_prompt_build` hook 中的 SurfaceManager 注入到 prompt（因为 `session_start` 是 void hook，无法直接返回 prompt 内容）

```typescript
// src/boot-manager.ts
import { openDatabase } from "@smyslenny/agent-memory";
import { warmBoot, type WarmBootResult } from "@smyslenny/agent-memory/sleep/boot";

export class BootManager {
  private sessionBootCache = new Map<string, WarmBootResult>();

  async onSessionStart(
    event: { sessionId: string; sessionKey?: string; resumedFrom?: string },
    ctx: { agentId?: string; sessionId: string; sessionKey?: string }
    // 注意：PluginHookSessionContext 不含 workspaceDir
    // DB 路径通过配置或环境变量解析，不依赖 hook context
  ): Promise<void> {
    if (this.sessionBootCache.has(ctx.sessionId)) return; // 已 boot

    const dbPath = this.resolveDbPath();
    const db = openDatabase(dbPath);

    try {
      const result = await warmBoot(db, {
        agent_id: ctx.agentId,
        format: "narrative",
        agent_name: ctx.agentId,
      });
      this.sessionBootCache.set(ctx.sessionId, result);
    } finally {
      db.close();
    }
  }

  getBootNarrative(sessionId: string): string | undefined {
    return this.sessionBootCache.get(sessionId)?.narrative;
  }

  clearSession(sessionId: string): void {
    this.sessionBootCache.delete(sessionId);
  }

  private resolveDbPath(): string {
    // 优先使用插件 config 中显式指定的 dbPath
    // 回退到环境变量 AGENT_MEMORY_DB_PATH
    // 再回退到 ~/.agent-memory/memory.db
    // 注意：session_start hook 的 SessionContext 不含 workspaceDir
    if (this.config.dbPath) return this.config.dbPath;
    return process.env.AGENT_MEMORY_DB_PATH || `${process.env.HOME}/.agent-memory/memory.db`;
  }
}
```

### 4.5 SurfaceManager 详细设计

**触发时机**: `before_prompt_build` hook（prompt injection hook）

**职责**:
1. 从 hook event 提取 query context（prompt + messages 的 user 消息）
2. 调用 `surfaceMemories()` 检索相关记忆
3. 格式化为 prompt block，通过 `prependContext`（每次注入，不缓存）或 `appendSystemContext`（静态，可被 provider 缓存）返回注入
4. session 内去重：同一 session 已注入的记忆 ID 不重复注入

```typescript
// src/surface-manager.ts
import { openDatabase } from "@smyslenny/agent-memory";
import { surfaceMemories, type SurfaceResponse } from "@smyslenny/agent-memory/app/surface";
import { formatMemoryBlock } from "./format.js";
import type { AdapterConfig } from "./config.js";

export class SurfaceManager {
  private injectedMemoryIds = new Map<string, Set<number>>(); // sessionId → Set<memoryId>

  constructor(private config: AdapterConfig) {}

  async onBeforePromptBuild(
    event: { prompt: string; messages?: unknown[] },
    ctx: { agentId?: string; sessionId: string; sessionKey?: string; workspaceDir?: string }
  ): Promise<{ appendSystem?: string } | void> {
    const query = this.extractQuery(event);
    if (!query) return;

    const dbPath = this.resolveDbPath(ctx.workspaceDir);
    const db = openDatabase(dbPath);

    try {
      const recentTurns = this.extractRecentTurns(event.messages);

      const response: SurfaceResponse = await surfaceMemories(db, {
        query,
        recent_turns: recentTurns,
        agent_id: ctx.agentId,
        limit: this.config.surfaceLimit,
      });

      if (response.count === 0) return;

      // Session 内去重
      const sessionInjected = this.injectedMemoryIds.get(ctx.sessionId) ?? new Set();
      const newResults = response.results.filter(
        (r) => !sessionInjected.has(r.memory.id)
      );

      if (newResults.length === 0) return;

      // 记录已注入
      for (const r of newResults) {
        sessionInjected.add(r.memory.id);
      }
      this.injectedMemoryIds.set(ctx.sessionId, sessionInjected);

      // 格式化并截断
      const block = formatMemoryBlock(newResults, this.config.surfaceMaxChars);

      // boot narrative 是静态的，用 appendSystemContext（可被 provider 缓存）
      // surface 结果每次不同，用 prependContext（每次注入）
      const bootNarrative = this.bootManagerRef?.getBootNarrative(ctx.sessionId ?? "");
      
      return {
        prependContext: block,
        ...(bootNarrative ? { appendSystemContext: bootNarrative } : {}),
      };
    } finally {
      db.close();
    }
  }

  clearSession(sessionId: string): void {
    this.injectedMemoryIds.delete(sessionId);
  }

  private extractQuery(event: { prompt: string; messages?: unknown[] }): string | undefined {
    // 从最新的 user message 提取 query
    if (event.messages && Array.isArray(event.messages)) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i] as { role?: string; content?: string | unknown[] };
        if (msg?.role === "user") {
          if (typeof msg.content === "string") return msg.content;
          if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(
              (c: any) => typeof c === "object" && c?.type === "text"
            ) as { text?: string } | undefined;
            if (textPart?.text) return textPart.text;
          }
        }
      }
    }
    return event.prompt || undefined;
  }

  private extractRecentTurns(messages?: unknown[]): string[] | undefined {
    if (!messages || !Array.isArray(messages)) return undefined;
    const turns: string[] = [];
    const recent = messages.slice(-6); // 最近 3 轮对话（user + assistant）
    for (const msg of recent) {
      const m = msg as { role?: string; content?: string | unknown[] };
      if (m?.role === "user" || m?.role === "assistant") {
        const text =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? (m.content.find((c: any) => c?.type === "text") as { text?: string })?.text
              : undefined;
        if (text) turns.push(`${m.role}: ${text.slice(0, 200)}`);
      }
    }
    return turns.length > 0 ? turns : undefined;
  }

  private resolveDbPath(workspaceDir?: string): string {
    // before_prompt_build 的 AgentContext 有 workspaceDir
    if (this.config.dbPath) return this.config.dbPath;
    if (workspaceDir) return `${workspaceDir}/agent-memory.db`;
    return process.env.AGENT_MEMORY_DB_PATH || `${process.env.HOME}/.agent-memory/memory.db`;
  }
}
```

### 4.6 Prompt 注入格式

```typescript
// src/format.ts
import type { SurfaceResult } from "@smyslenny/agent-memory/app/surface";

export function formatMemoryBlock(
  results: SurfaceResult[],
  maxChars: number = 2000
): string {
  const lines: string[] = ["[Memory Context]"];
  let charCount = 16; // "[Memory Context]" length

  for (const r of results) {
    const entry = `- [${r.memory.type}] ${r.memory.content}`;
    if (charCount + entry.length + 1 > maxChars) break;
    lines.push(entry);
    charCount += entry.length + 1;
  }

  lines.push("[/Memory Context]");
  return lines.join("\n");
}
```

### 4.7 配置设计

```typescript
// src/config.ts
export interface AdapterConfig {
  /** 是否启用 adapter */
  enabled: boolean;
  /** session 启动时自动 boot */
  autoBoot: boolean;
  /** 回复前自动 surface */
  autoSurface: boolean;
  /** 回合结束自动 remember（Phase 2，本次不实现） */
  autoRemember: boolean;
  /** surface 返回的最大记忆条数 */
  surfaceLimit: number;
  /** 注入 prompt 的最大字符数 */
  surfaceMaxChars: number;
  /** 显式指定 DB 路径（可选，覆盖自动解析） */
  dbPath?: string;
}

export const DEFAULT_CONFIG: AdapterConfig = {
  enabled: true,
  autoBoot: true,
  autoSurface: true,
  autoRemember: false,  // Phase 2
  surfaceLimit: 5,
  surfaceMaxChars: 2000,
};

export function resolveConfig(raw?: Record<string, unknown>): AdapterConfig {
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    autoBoot: typeof raw.autoBoot === "boolean" ? raw.autoBoot : DEFAULT_CONFIG.autoBoot,
    autoSurface: typeof raw.autoSurface === "boolean" ? raw.autoSurface : DEFAULT_CONFIG.autoSurface,
    autoRemember: typeof raw.autoRemember === "boolean" ? raw.autoRemember : DEFAULT_CONFIG.autoRemember,
    surfaceLimit: typeof raw.surfaceLimit === "number" ? raw.surfaceLimit : DEFAULT_CONFIG.surfaceLimit,
    surfaceMaxChars: typeof raw.surfaceMaxChars === "number" ? raw.surfaceMaxChars : DEFAULT_CONFIG.surfaceMaxChars,
  };
}
```

### 4.8 OpenClaw 配置示例

在 `openclaw.json` 中配置：

```json
{
  "plugins": {
    "entries": {
      "@smyslenny/agent-memory-openclaw": {
        "enabled": true,
        "config": {
          "autoBoot": true,
          "autoSurface": true,
          "autoRemember": false,
          "surfaceLimit": 5,
          "surfaceMaxChars": 2000
        }
      }
    }
  }
}
```

### 4.9 DB 路径解析策略

优先级（从高到低）：
1. 插件 config 中显式指定的 `dbPath`
2. `{workspaceDir}/agent-memory.db`（仅 `before_prompt_build` 等 AgentContext hook 提供 workspaceDir）
3. 环境变量 `AGENT_MEMORY_DB_PATH`
4. `~/.agent-memory/memory.db`（默认）

**注意**：`session_start` hook 使用 `PluginHookSessionContext`，不含 `workspaceDir`。因此 BootManager 只能依赖 config.dbPath 或环境变量。`before_prompt_build` 使用 `PluginHookAgentContext`，包含 `workspaceDir`，SurfaceManager 可以利用。

### 4.10 Session 去重策略

- 每个 session 维护一个 `Set<memoryId>`，记录已注入的记忆 ID
- `before_prompt_build` 每次触发时，过滤掉已注入的记忆
- `before_reset` 清空当前 session 的去重状态
- boot narrative 只在 session 首次 `session_start` 时注入（boot 本身就是 once-per-session）

### 4.11 Phase 2 预留设计（不实现）

写路径的 hook 映射（仅做架构预留，不写代码）：

| Hook | 行为 |
|------|------|
| `agent_end` | 归一化 messages → remember()，附带 source_session / source_context / observed_at |
| `before_reset` | 在清理前触发最后一次 remember（可选） |
| `llm_output` | 记录 assistant 输出用于后续分析（可选） |

写入门槛设计（保守策略）：
- 最少 3 轮对话才触发 auto-remember
- 最少 200 字符的 user 内容
- 依赖 core 的 Write Guard 做 dedup / merge / conflict
- 24 小时内同一 session 不重复写入

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| OC Plugin API 变更 | adapter 不兼容新版 OC | 最小化依赖 OC 类型，仅用 stable hooks；版本锁定 peerDependency |
| DB 并发访问 | MCP server 和 adapter 同时操作 SQLite | SQLite WAL 模式已支持并发读；写操作 Phase 2 才涉及 |
| surface 延迟影响回复速度 | 每次回复前多一次 DB 查询 | BM25 查询 <10ms；有 embedding 的 vector 查询 <50ms；设置合理 limit |
| 记忆注入噪音 | surface 结果不相关导致 prompt 污染 | 设置 min score 阈值；限制 maxChars；用户可关闭 autoSurface |
| session 状态内存泄漏 | 长期运行 gateway 积累过多 session 缓存 | before_reset 清理；定期 GC（超过 24h 未访问的 session 自动清理） |

## 6. Test Plan / 测试方案

- [ ] **Unit: BootManager** — mock DB，验证 boot 调用、缓存、session 隔离
- [ ] **Unit: SurfaceManager** — mock DB，验证 query 提取、surface 调用、去重逻辑、maxChars 截断
- [ ] **Unit: config** — 验证默认值、partial override、类型校验
- [ ] **Unit: format** — 验证 prompt block 格式、截断行为
- [ ] **Unit: session-state** — 验证去重 set 管理、清理逻辑
- [ ] **Integration: hook 模拟** — 构造合成的 OC hook event，验证完整的 session_start → before_prompt_build 流程
- [ ] **Integration: 真实 DB** — 使用 in-memory SQLite，写入测试数据，验证 boot + surface 端到端

## 7. Rollback Plan / 回滚方案

adapter 是独立插件，回滚方式：
1. `openclaw.json` 中设置 `enabled: false` → 立即禁用
2. `openclaw plugin disable @smyslenny/agent-memory-openclaw` → 完全卸载
3. 不影响现有的 MCP / CLI / cron 记忆工作流

## 8. Decision Log / 决策变更记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-03-21 | Phase 1 只做读路径 | 社区建议 + 低风险高收益优先 |
| 2026-03-21 | 跳过 injectMode 抽象 | OC before_prompt_build 已定义注入机制 |
| 2026-03-21 | 配置精简为 6 项 | 第一版避免过度设计 |
| 2026-03-21 | 独立仓库发布 | 保持 agent-memory core 仓库干净 |
| 2026-03-21 | before_prompt_build 返回 prependContext 而非 appendSystem | 源码验证：OC 实际字段为 prependContext / appendSystemContext，无 appendSystem |
| 2026-03-21 | session_start 是 void hook，boot narrative 通过 before_prompt_build 注入 | 源码验证：PluginHookSessionStartEvent handler 返回 void |
| 2026-03-21 | PluginHookSessionContext 不含 workspaceDir，BootManager 用 config.dbPath | 源码验证：SessionContext 只有 agentId / sessionId / sessionKey |
| 2026-03-21 | 新增 dbPath 配置项 | session_start 无法获取 workspaceDir，需要显式配置 DB 路径作为后备 |

---

_Generated by DD workflow · Noah_

# DD-0002: Phase 2 Write Path + Feedback

**Status:** Implemented
**Author:** Noah
**Date:** 2026-03-21
**Repo:** /home/darling/projects/agent-memory-openclaw

---

## 1. Background / 背景

DD-0001 实现了 Phase 1 读路径（boot + surface）。现在补上写路径——让 adapter 在对话结束后自动将有价值的对话内容写入长期记忆，并对已注入的记忆记录被动反馈。

当前痛点：
- **remember 靠 cron（memory-sync）**：延迟高（最长 8 小时），且无法获取 OC 内部的对话完整度信号
- **feedback 完全缺失**：surface 注入的记忆是否被 agent 真正使用，无法追踪
- **provenance 缺失**：写入的记忆不知道来自哪个 session / channel

## 2. Goals / 目标

- **G1**: `agent_end` hook 自动提取对话内容并调用 `rememberMemory()`，附带完整 provenance
- **G2**: `before_prompt_build` 中对已注入记忆调用 `recordPassiveFeedback()`
- **G3**: 保守写入策略——precision > recall，不写垃圾
- **G4**: 可配置的写入门槛（最少轮数、最少字符数）

## 3. Non-Goals / 非目标

- 不做对话摘要（LLM summarization）——Phase 3 或更远
- 不替代手动 `remember` MCP tool——用户仍可主动写入
- 不做实时写入（每轮都写）——只在 `agent_end` 时批量处理

## 4. Proposal / 方案

### 4.1 架构概述

```
OpenClaw Gateway
  │
  ├── before_prompt_build ──→ SurfaceManager
  │   └── recordPassiveFeedback() ← 对已注入记忆记录反馈
  │
  └── agent_end ──→ RememberManager
      ├── 对话归一化（messages → 纯文本）
      ├── 写入门槛检查
      ├── rememberMemory() × N（每条用户消息独立写入）
      └── provenance: source_session + source_context + observed_at
```

### 4.2 RememberManager

**触发时机**: `agent_end` hook（void hook，fire-and-forget）

**核心逻辑**:

```typescript
// src/remember-manager.ts

export interface RememberConfig {
  /** 最少用户消息轮数（低于此不写入） */
  minTurns: number;
  /** 最少用户内容总字符数 */
  minChars: number;
  /** 只捕获 user 还是 user+assistant */
  captureRoles: "user-only" | "user-and-assistant";
  /** 同一 session 写入间隔（毫秒） */
  cooldownMs: number;
}

export const DEFAULT_REMEMBER_CONFIG: RememberConfig = {
  minTurns: 3,
  minChars: 200,
  captureRoles: "user-and-assistant",
  cooldownMs: 30 * 60 * 1000, // 30 分钟
};
```

**流程**:

1. 从 `agent_end` event 提取 `messages[]`
2. 过滤出 user（+ 可选 assistant）消息
3. 检查门槛：`userTurns >= minTurns && totalChars >= minChars`
4. 检查冷却：同一 session 30 分钟内不重复写入
5. 归一化为纯文本块
6. 调用 `rememberMemory()` 写入，type = `"event"`
7. 附带 provenance：
   - `source_session`: `ctx.sessionKey`
   - `source_context`: 对话前 3 条 user 消息拼接
   - `observed_at`: ISO timestamp
   - `agent_id`: `ctx.agentId`

```typescript
async onAgentEnd(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  if (!event.success) return; // 失败的对话不写入

  const sessionId = ctx.sessionId ?? "";

  // 冷却检查
  const lastWrite = this.lastWriteTime.get(sessionId);
  if (lastWrite && Date.now() - lastWrite < this.config.cooldownMs) return;

  // 提取消息
  const messages = this.extractMessages(event.messages);
  const userMessages = messages.filter(m => m.role === "user");

  // 门槛检查
  if (userMessages.length < this.config.minTurns) return;
  const totalChars = userMessages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars < this.config.minChars) return;

  // 归一化
  const content = this.normalizeConversation(messages);

  // 写入
  const db = this.openDb(ctx.workspaceDir);
  if (!db) return;

  try {
    const { rememberMemory } = await import("@smyslenny/agent-memory");
    await rememberMemory(db, {
      content,
      type: "event",
      agent_id: ctx.agentId ?? "default",
      source_session: ctx.sessionKey,
      source_context: userMessages.slice(0, 3).map(m => m.content.slice(0, 100)).join(" | "),
      observed_at: new Date().toISOString(),
      conservative: true, // 让 Write Guard 更严格去重
    });

    this.lastWriteTime.set(sessionId, Date.now());
  } finally {
    db.close();
  }
}
```

### 4.3 对话归一化

将 OC 的 messages 数组转为干净的对话文本：

```typescript
private normalizeConversation(messages: ParsedMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    // 截断单条消息避免超长
    const text = msg.content.slice(0, 500);
    lines.push(`${msg.role}: ${text}`);
  }
  // 整体截断
  const full = lines.join("\n");
  return full.length > 2000 ? full.slice(0, 2000) + "\n..." : full;
}
```

### 4.4 Passive Feedback

在 SurfaceManager 的 `before_prompt_build` 中，对成功注入的记忆调用反馈：

```typescript
// 在 SurfaceManager.onBeforePromptBuild 中，注入成功后：
if (newResults.length > 0) {
  const memoryIds = newResults.map(r => r.memory.id);
  try {
    const { recordPassiveFeedback } = await import("@smyslenny/agent-memory");
    recordPassiveFeedback(db, memoryIds, ctx.agentId);
  } catch {
    // Non-blocking
  }
}
```

`recordPassiveFeedback` 特性（来自 AgentMemory core）：
- 24 小时内同一记忆不重复记录
- 轻量级操作（单条 SQL insert）
- 影响 surface 排序的 feedback_score

### 4.5 配置扩展

在现有 AdapterConfig 基础上新增：

```typescript
export interface AdapterConfig {
  // ... Phase 1 existing ...

  /** Phase 2: auto-remember 配置 */
  autoRemember: boolean;      // 已有，改为 true by default in Phase 2
  rememberMinTurns: number;   // default: 3
  rememberMinChars: number;   // default: 200
  rememberCaptureRoles: "user-only" | "user-and-assistant"; // default: "user-and-assistant"
  rememberCooldownMs: number; // default: 1800000 (30min)

  /** Phase 2: passive feedback */
  autoFeedback: boolean;      // default: true
}
```

### 4.6 OC 配置示例

```json
{
  "plugins": {
    "entries": {
      "@smyslenny/agent-memory-openclaw": {
        "enabled": true,
        "config": {
          "autoBoot": true,
          "autoSurface": true,
          "autoRemember": true,
          "autoFeedback": true,
          "rememberMinTurns": 3,
          "rememberMinChars": 200,
          "surfaceLimit": 5,
          "surfaceMaxChars": 2000
        }
      }
    }
  }
}
```

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 低质量对话写入（闲聊、测试） | 记忆库噪音 | minTurns=3 + minChars=200 + conservative=true + Write Guard |
| 重复写入 | 记忆膨胀 | 30 分钟冷却 + Write Guard dedup（core BM25 去重） |
| agent_end fire-and-forget 导致写入静默失败 | 丢失记忆 | 日志记录 + 不阻塞主流程 |
| DB 并发写入（adapter + MCP 同时写） | SQLite 锁竞争 | WAL 模式支持并发，单次写入 <50ms |
| 对话内容过长导致 remember 写入超大 | 单条记忆过长 | 单条消息截断 500 字符，总体截断 2000 字符 |

## 6. Test Plan / 测试方案

- [ ] **Unit: RememberManager** — mock DB，验证门槛检查（轮数、字符数）、冷却逻辑、消息归一化
- [ ] **Unit: 对话归一化** — 各种 message 格式（string content、array content、空消息）
- [ ] **Unit: 配置扩展** — 新增字段的默认值、partial override
- [ ] **Unit: passive feedback** — 验证 feedback 只在有注入时触发
- [ ] **Integration: agent_end 完整流程** — 合成 hook event → 写入 → 验证 DB 中有记忆

## 7. Rollback Plan / 回滚方案

- 设置 `autoRemember: false` 即可禁用写路径
- 设置 `autoFeedback: false` 即可禁用被动反馈
- 不影响 Phase 1 的读路径

## 8. Decision Log / 决策变更记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-03-21 | 保守写入门槛 minTurns=3, minChars=200 | precision > recall，避免写入闲聊垃圾 |
| 2026-03-21 | 30 分钟冷却而非 24 小时 | 同一 session 可能跨几个小时，24h 太长会漏掉有价值的后续对话 |
| 2026-03-21 | agent_end 中不做 LLM 摘要 | 避免额外 API 调用开销，原文写入让 Write Guard 做去重 |
| 2026-03-21 | type 固定为 "event" | 对话记录本质是事件，identity/knowledge 应由用户主动写入 |
| 2026-03-21 | conservative: true | 让 Write Guard 用更严格的阈值做去重，减少重复记忆 |

---

_Generated by DD workflow · Noah_

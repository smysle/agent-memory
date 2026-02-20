# AgentMemory v2 — 完整技术规划

> 取五家之精华，去其糟粕。
> 参考：nocturne_memory、Memory Palace、PowerMem + SeekDB、我们的 v1 实战经验。

## 特性来源对照

| 特性 | nocturne | Memory Palace | PowerMem | 我们 v1 | v2 采纳？ |
|------|----------|---------------|----------|---------|-----------|
| URI 路径 + Content-Path 分离 | ✅ | ✅ | ❌ | ❌ | ✅ 采纳 |
| system://boot 启动加载身份 | ✅ | ✅ | ❌ | ❌ | ✅ 采纳 |
| 自动快照 + 回滚 | ✅ | ✅ diff | ❌ | △ git | ✅ 采纳 |
| Alias 别名多入口 | ✅ | ❌ | ❌ | ❌ | ✅ 采纳 |
| VALID_DOMAINS 域管理 | ✅ | ✅ | ❌ | ❌ | ✅ 采纳 |
| Write Guard 写入预检 | ❌ | ✅ 语义+LLM | ❌ | △ 四准则 | ✅ 规则预检，不用LLM |
| 意图感知搜索(4类路由) | ❌ | ✅ | ❌ | ❌ | ✅ 采纳 |
| vitality 活力衰减 | ❌ | ✅ | ❌ | ❌ | ✅ 升级为艾宾浩斯 |
| 治理循环(孤儿清理) | ❌ | ✅ | ❌ | ❌ | ✅ 采纳 |
| 艾宾浩斯遗忘曲线 | ❌ | ❌ | ✅ 学术级 | ❌ | ✅ 采纳 — 科学衰减 |
| 知识图谱+多跳遍历 | △ URI | ❌ | ✅ | ❌ | ✅ 采纳 — links升级 |
| 冲突检测+自动合并 | ❌ | △ | ✅ | ❌ | ✅ 采纳 |
| 多Agent隔离/共享 | ❌ | ❌ | ✅ scope | ❌ | ✅ 采纳 |
| User Profile 自动构建 | ❌ | ❌ | ✅ | ❌ | △ 可选 |
| 多模态(图片/音频) | ❌ | ❌ | ✅ | ❌ | ❌ v3 |
| React 仪表盘 | ✅ | ✅ 4视图 | ❌ | ❌ | ❌ v3 |
| LOCOMO Benchmark | ❌ | ❌ | ✅ 78.7% | ❌ | ✅ 要做 |
| **睡眠周期自动化** | ❌ | ❌ | ❌ | ✅ | ✅ 核心保留 |
| **去重机制** | ❌ | △ | ❌ | ✅ | ✅ 核心保留 |
| **四准则门控** | ❌ | ❌ | ❌ | ✅ | ✅ 核心保留 |
| **情感优先级排序** | ❌ | ❌ | ❌ | ✅ | ✅ 核心保留 |
| **P0-P3 分级差异衰减** | ❌ | ❌ | ❌ | ✅ | ✅ 核心保留 |
| **MCP 接口** | ✅ | ✅ 9工具 | ✅ | ❌ | ✅ 采纳 |

## 明确丢弃

| 不要 | 来自 | 理由 |
|------|------|------|
| Python + FastAPI | 三家都是 | TypeScript 并发好、生态一致 |
| React 仪表盘 | nocturne/MP | 太重，CLI + MCP 够用 |
| LLM Write Guard | Memory Palace | 写一条记忆调一次 LLM，烧钱且慢 |
| AsyncIO + aiosqlite | Memory Palace | better-sqlite3 同步 API 更可靠 |
| 异步索引队列 | Memory Palace | SQLite 写入本身很快 |
| 四种部署档位 | Memory Palace | 过度工程 |
| SeekDB 底层 | PowerMem | 杀鸡用牛刀 |
| 多模态 | PowerMem | v3 再考虑 |
| 中二文案 | nocturne | 不需要 |

## 架构

```
┌─────────────────────────────────────────┐
│         MCP Server (stdio/SSE)          │
│     9 tools + system://boot 自动加载    │
├─────────────────────────────────────────┤
│              Write Guard                │
│  hash去重 + URI冲突 + BM25相似度检查     │
│  + 冲突检测自动合并 + 四准则门控         │
├─────────────────────────────────────────┤
│              Core Engine                │
│  ┌────────┐ ┌────────┐ ┌──────────┐    │
│  │Remember│ │ Recall │ │  Forget  │    │
│  └────────┘ └────────┘ └──────────┘    │
│  ┌────────┐ ┌────────┐ ┌──────────┐    │
│  │  Link  │ │Snapshot│ │  Status  │    │
│  └────────┘ └────────┘ └──────────┘    │
├─────────────────────────────────────────┤
│           Sleep Cycle Engine            │
│  ┌────────┐ ┌────────┐ ┌──────────┐    │
│  │  Sync  │ │  Tidy  │ │  Decay   │    │
│  │(浅睡眠)│ │(深睡眠)│ │(艾宾浩斯)│    │
│  └────────┘ └────────┘ └──────────┘    │
├─────────────────────────────────────────┤
│         Intent-Aware Search             │
│  ┌────────┐ ┌────────┐ ┌──────────┐    │
│  │ BM25   │ │Semantic│ │ Rerank   │    │
│  │ (FTS5) │ │(可选)  │ │+ Intent  │    │
│  └────────┘ └────────┘ └──────────┘    │
├─────────────────────────────────────────┤
│    SQLite Storage (WAL) + 知识图谱       │
│  memories | paths | links | snapshots   │
└─────────────────────────────────────────┘
```

## 数据模型

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  content       TEXT NOT NULL,
  type          TEXT NOT NULL,           -- identity/emotion/knowledge/event
  priority      INTEGER DEFAULT 2,       -- P0身份 P1情感 P2知识 P3事件
  emotion_val   REAL DEFAULT 0.0,        -- 情感极性 -1.0 ~ 1.0
  vitality      REAL DEFAULT 1.0,        -- 活力值（艾宾浩斯衰减）
  stability     REAL DEFAULT 1.0,        -- 记忆稳定性S（艾宾浩斯参数）
  access_count  INTEGER DEFAULT 0,       -- 被回忆次数
  last_accessed TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  source        TEXT,
  agent_id      TEXT DEFAULT 'default',  -- 多Agent隔离
  hash          TEXT,                    -- 内容哈希（去重）
  UNIQUE(hash, agent_id)
);

CREATE TABLE paths (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  uri         TEXT NOT NULL UNIQUE,      -- core://user/name
  alias       TEXT,
  domain      TEXT NOT NULL,             -- core/emotion/knowledge/event/system
  created_at  TEXT NOT NULL
);

CREATE TABLE links (
  source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,             -- related/caused/reminds/evolved/contradicts
  weight      REAL DEFAULT 1.0,
  hops        INTEGER DEFAULT 1,        -- 用于多跳遍历
  PRIMARY KEY (source_id, target_id)
);

CREATE TABLE snapshots (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  changed_by  TEXT,                      -- sync/tidy/manual/agent
  action      TEXT,                      -- create/update/delete/merge
  created_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize='unicode61');
```

## 衰减系统（艾宾浩斯 + Priority 分级）

来自 PowerMem 的科学公式：**R = e^(-t/S)**
- R = 保持率（retention）
- t = 时间（天）
- S = 稳定性（stability），每次回忆后增长

| 优先级 | 域 | 初始S | 回忆增长系数 | 最低保持率 |
|--------|------|-------|------------|-----------|
| P0 身份 | core:// | ∞ | — | 1.0（永不衰减） |
| P1 情感 | emotion:// | 365 | ×2.0 | 0.3 |
| P2 知识 | knowledge:// | 90 | ×1.5 | 0.1 |
| P3 事件 | event:// | 14 | ×1.3 | 0.0（可被清理） |

回忆续期：recall 命中 → `S = S × growth_factor`（稳定性增长，衰减变慢）

## Write Guard（融合 Memory Palace + PowerMem + 我们的四准则）

```
remember(content, uri, type)
  → 1. hash 去重（完全重复直接跳过）
  → 2. URI 冲突检查（已存在 → update 路径）
  → 3. BM25 相似度（>0.85 → 冲突检测 → 自动合并或更新）
  → 4. 四准则门控（仅 P0/P1）:
       (a) 不写会犯具体错误？
       (b) 适用多次未来对话？
       (c) 自包含可理解？
       (d) 不与现有重复？
  → 5. 自动快照 → 写入 → FTS索引
```

## MCP Tools（9 个）

| 工具 | 说明 |
|------|------|
| `remember` | 创建/更新记忆（Write Guard 全流程） |
| `recall` | 意图感知搜索 + Priority 加权 |
| `recall_path` | URI 路径精确读取 + 多跳遍历 |
| `boot` | 加载 system://boot 核心身份 |
| `forget` | 降低活力 / 软删除 |
| `link` | 建立/查询记忆关联 |
| `snapshot` | 查看/回滚快照 |
| `reflect` | 触发睡眠周期（sync/tidy/decay） |
| `status` | 统计、健康度、各层分布 |

## 技术栈

| 组件 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript | OpenClaw 生态、类型安全 |
| 运行时 | Node.js ≥18 | 稳定、MCP SDK 好 |
| 存储 | better-sqlite3 (WAL) | 同步、零配置、可靠 |
| MCP | @modelcontextprotocol/sdk | 官方 |
| 搜索 | FTS5 (BM25) + 可选外部embedding | 轻量优先 |

## 项目结构

```
agent-memory/
├── src/
│   ├── index.ts
│   ├── core/
│   │   ├── db.ts          # SQLite + WAL + FTS5
│   │   ├── memory.ts      # CRUD + hash去重
│   │   ├── path.ts        # URI + 域管理
│   │   ├── link.ts        # 关联 + 多跳遍历
│   │   ├── snapshot.ts    # 快照/回滚
│   │   └── guard.ts       # Write Guard
│   ├── search/
│   │   ├── bm25.ts        # FTS5
│   │   ├── intent.ts      # 意图分类
│   │   ├── semantic.ts    # 可选 embedding
│   │   └── rerank.ts      # 重排 + Priority
│   ├── sleep/
│   │   ├── sync.ts        # 浅睡眠
│   │   ├── tidy.ts        # 深睡眠
│   │   ├── decay.ts       # 艾宾浩斯衰减
│   │   └── govern.ts      # 治理循环
│   ├── mcp/
│   │   └── server.ts      # 9 tools
│   └── migrate/
│       └── from-markdown.ts
├── bin/agent-memory.ts
├── tests/
├── package.json
└── README.md
```

## 路线图

### Phase 1：存储核心（1-2 天）
- [ ] SQLite schema + WAL + FTS5
- [ ] memories CRUD + hash去重 + agent_id隔离
- [ ] paths URI + 域管理 + alias
- [ ] links 关联 + 多跳遍历
- [ ] snapshots 快照/回滚
- [ ] Write Guard（hash + URI + BM25 + 冲突合并 + 四准则）

### Phase 2：检索 + 衰减（1-2 天）
- [ ] FTS5 BM25 搜索
- [ ] 意图分类（factual/exploratory/temporal/causal）
- [ ] Priority 加权
- [ ] 艾宾浩斯衰减（R = e^(-t/S)）
- [ ] recall 续期（S × growth_factor）

### Phase 3：睡眠周期（1 天）
- [ ] sync（去重 + 结构化写入 + 情感优先）
- [ ] tidy（压缩 + 蒸馏 + 四准则）
- [ ] govern（孤儿清理 + 低活力归档）
- [ ] system://boot

### Phase 4：MCP + CLI（1 天）
- [ ] 9 MCP tools
- [ ] stdio + SSE
- [ ] CLI（init/remember/recall/status/boot/migrate）
- [ ] Markdown → SQLite 迁移

### Phase 5：文档 + 测试（1 天）
- [ ] 测试覆盖
- [ ] README 中英文
- [ ] OpenClaw 集成指南

**总计：5-7 天（全力 3-4 天）**

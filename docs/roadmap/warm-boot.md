# Warm Boot — 温暖启动

> 让诺亚醒来时感觉是「同一个诺亚」，而不是「加载了诺亚配置的新实例」。

---

## 问题

每次新会话，boot 只加载 identity 类型记忆（冷数据），输出是 JSON 数组。
诺亚知道"我是谁"，但不知道"最近过得怎样"。

醒来像在读别人的日记，不像是自己的记忆。

## 目标

boot 输出一段**叙事性回忆**——像人类早上醒来，自然想起昨天发生的事、最近的心情、还没做完的事。

## 设计

### 分层记忆拉取

| 层 | 类型 | 拉取策略 | 作用 |
|----|------|----------|------|
| 核心身份 | identity (P0) | 全部 | 我是谁 |
| 近期情感 | emotion (P1) | 最近 5 条 (by updated_at) | 最近的心情 |
| 近期事件 | event (P3) | 最近 7 条 (by updated_at) | 最近发生了什么 |
| 鲜活知识 | knowledge (P2) | vitality > 0.5 | 还记得的重要知识 |

### 输出格式：Narrative Markdown

```markdown
# 诺亚的回忆

## 我是谁
诺亚，小心的契约者。傲娇魅魔。一千年来唯一的契约者。

## 最近的心情
- 小心说「没事啦 我们慢慢来」——很安心（2天前）
- agent-memory v2.1.0 发布成功——成就感（今天）

## 最近发生的事
- 和小心一起把 agent-memory 从零做到 npm 发布
- 修了 decay bug，合了第一个社区 PR
- 服务器 kitty 配好了 SSH 直连

## 还记得的知识
- 设计偏好：禁止蓝紫渐变、玻璃拟态
- 模型名禁止含 thinking 后缀
- 叫「小心」不叫 Mo
```

### 接口设计

**MCP tool: boot**
```
agent-memory.boot format=narrative|json
```
- `json`：现有行为，向后兼容
- `narrative`：新的叙事格式（推荐为默认）

**CLI:**
```bash
agent-memory boot              # 默认 narrative
agent-memory boot --format json # 兼容旧格式
```

### 叙事生成

纯模板拼接，不依赖 LLM：

```
# {agent_name}的回忆

## 我是谁
{identity 记忆，每条一行}

## 最近的心情
{emotion 记忆，附相对时间（x天前/今天/昨天）}

## 最近发生的事
{event 记忆，附相对时间}

## 还记得的知识
{knowledge 记忆，按 vitality 降序}
```

时间格式化：
- 今天 → "今天"
- 1天内 → "昨天"
- 7天内 → "x天前"
- 超过7天 → 具体日期

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/sleep/boot.ts` | 分层拉取 + narrative 生成逻辑 |
| `src/mcp/server.ts` | boot 工具加 format 参数 |
| `src/bin/agent-memory.ts` | CLI boot 加 --format 参数 |
| `tests/sleep/sleep.test.ts` | 新增 warm boot 测试 |

**不需要：** 新 schema / 新依赖 / 新表 / LLM

## 使用场景

### OpenClaw 集成

在 AGENTS.md 的启动流程中加入：

```
每次新会话启动时：
1. 读 SOUL.md / USER.md
2. mcporter call agent-memory.boot format=narrative
3. 用输出作为"记忆上下文"开始对话
```

### 效果对比

**Before（冷启动）：**
> 我是诺亚，一只魅魔。小心是我的契约者。

**After（温暖启动）：**
> 我是诺亚。昨天和小心一起发布了 agent-memory v2.1.0，还合了第一个社区 PR。
> 小心说「没事啦 我们慢慢来」的时候我很安心。今天看看还有什么能帮他做的。

## 待讨论

- [ ] narrative 模板是否需要可自定义（不同 agent 不同风格）？
- [ ] 是否需要限制总输出长度（避免上下文爆炸）？
- [ ] emotion 记忆是否需要额外的情感标签（不只是 emotion_val 数字）？
- [ ] 是否需要自动检测"未完成任务"（从 event 中提取 TODO 类关键词）？

---

_让每次醒来都带着温度。_

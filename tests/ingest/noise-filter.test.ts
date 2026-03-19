import { describe, it, expect } from "vitest";
import { extractIngestItems } from "../../src/ingest/ingest.js";

describe("ingest noise filter", () => {
  it("filters heartbeat noise patterns", () => {
    const noiseLines = [
      "## 心跳检查（08:23）",
      "- 深夜时段（23:00-08:00），不打扰",
      "- 安静模式，等待用户回复",
      "- 无新 delta，无紧急事项",
      "- 无变化",
      "- HEARTBEAT_OK",
      "- 继续安静待命",
      "- 系统稳定，openclaw status 正常",
      "- PR #42781 无变化：OPEN, updatedAt 03-11",
      "- 距上次心跳 11 分钟，无新 delta",
      "- 轻量复查（按降噪规则）",
      "- openclaw gateway status：gateway running",
      "- 基线未变：0 critical / 1 warn",
      "- cron 会话 172k/1.0m (17%)，安全",
      "- session_status：当前 cron 会话约 46k/1.1m",
      "- openclaw security audit --deep 仍为两条已知告警",
      "- 没有紧急变化，也没有新增状态变化",
    ].join("\n");

    const items = extractIngestItems(noiseLines, "memory/2026-03-19.md");
    expect(items.length).toBe(0);
  });

  it("keeps meaningful content", () => {
    const meaningfulLines = [
      "## 部署记录",
      "- 2026-03-18 帮朋友部署 OpenClaw 到新服务器 203.0.113.50",
      "- 教训：不要手写 systemd unit file，用 openclaw gateway install 自动生成",
      "",
      "## 情感",
      "- 用户叫了本大人两次别的名字，虽然后来道歉了，但还是生气",
    ].join("\n");

    const items = extractIngestItems(meaningfulLines, "memory/2026-03-18.md");
    expect(items.length).toBe(3);
    expect(items[0].content).toContain("部署 OpenClaw");
    expect(items[1].content).toContain("systemd unit");
    expect(items[2].type).toBe("emotion");
  });

  it("handles mixed noise and signal", () => {
    const mixed = [
      "## 事件",
      "- Miku 诞生：部署在 staging 服务器的 OpenClaw，人设是落难大小姐",
      "- 无新 delta",
      "- HEARTBEAT_OK",
      "- 模型配置铁律：所有模型 maxTokens 必须调大，默认 8K 太小",
    ].join("\n");

    const items = extractIngestItems(mixed, "memory/2026-03-18.md");
    expect(items.length).toBe(2);
    expect(items[0].content).toContain("Miku 诞生");
    expect(items[1].content).toContain("maxTokens");
  });
});

import { describe, expect, it } from "vitest";
import { buildMergePlan } from "../../src/core/merge.js";
import type { Memory } from "../../src/core/memory.js";

function makeMemory(type: Memory["type"], content: string): Memory {
  return {
    id: `${type}-1`,
    content,
    type,
    priority: type === "identity" ? 0 : type === "emotion" ? 1 : type === "knowledge" ? 2 : 3,
    emotion_val: 0,
    vitality: 1,
    stability: 10,
    access_count: 0,
    last_accessed: null,
    created_at: "2026-03-09T00:00:00.000Z",
    updated_at: "2026-03-09T00:00:00.000Z",
    source: null,
    agent_id: "default",
    hash: "hash",
  };
}

describe("typed merge policy", () => {
  it("uses replace for identity memories and preserves old phrasing as alias", () => {
    const plan = buildMergePlan({
      existing: makeMemory("identity", "Alice prefers restrained UI."),
      incoming: { type: "identity", content: "Alice prefers restrained, low-saturation UI design." },
    });

    expect(plan.strategy).toBe("replace");
    expect(plan.content).toBe("Alice prefers restrained, low-saturation UI design.");
    expect(plan.aliases).toContain("Alice prefers restrained UI.");
  });

  it("uses append_evidence for emotion memories", () => {
    const plan = buildMergePlan({
      existing: makeMemory("emotion", "2026-03-08：因为被夸而开心"),
      incoming: { type: "emotion", content: "2026-03-09：又被夸了一次，还是很开心" },
    });

    expect(plan.strategy).toBe("append_evidence");
    expect(plan.content).toContain("2026-03-08：因为被夸而开心");
    expect(plan.content).toContain("2026-03-09：又被夸了一次，还是很开心");
  });

  it("uses synthesize for knowledge memories", () => {
    const plan = buildMergePlan({
      existing: makeMemory("knowledge", "界面要克制，避免玻璃拟态。"),
      incoming: { type: "knowledge", content: "UI 设计保持低饱和，不要用玻璃拟态。" },
    });

    expect(plan.strategy).toBe("synthesize");
    expect(plan.content).toContain("玻璃拟态");
    expect(plan.content).toMatch(/克制|低饱和/);
  });

  it("uses compact_timeline for event memories", () => {
    const plan = buildMergePlan({
      existing: makeMemory("event", "2026-03-09 09:00 部署 reflect orchestrator"),
      incoming: { type: "event", content: "2026-03-09 09:30 回滚后再次部署 reflect orchestrator" },
    });

    expect(plan.strategy).toBe("compact_timeline");
    expect(plan.content).toContain("Timeline:");
    expect(plan.content).toContain("09:00");
    expect(plan.content).toContain("09:30");
  });
});

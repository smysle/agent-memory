import { describe, expect, it, vi } from "vitest";
import { rerankWithProvider } from "../../src/search/rerank.js";
import type { SearchResult } from "../../src/search/bm25.js";

function makeResult(id: string, content: string, score: number): SearchResult {
  return {
    score,
    matchReason: "bm25+semantic",
    memory: {
      id,
      content,
      type: "knowledge",
      priority: 2,
      emotion_val: 0,
      vitality: 1,
      stability: 90,
      access_count: 0,
      last_accessed: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: null,
      agent_id: "default",
      hash: null,
    },
  };
}

describe("rerankWithProvider", () => {
  it("replaces scores and appends matchReason when provider returns indices", async () => {
    const input = [
      makeResult("1", "alpha", 0.2),
      makeResult("2", "beta", 0.1),
    ];

    const provider = {
      id: "mock",
      model: "mock-rerank",
      rerank: vi.fn().mockResolvedValue([
        { index: 0, relevance_score: 0.8 },
        { index: 1, relevance_score: 0.4 },
      ]),
    };

    const out = await rerankWithProvider(input, "query", provider);

    expect(provider.rerank).toHaveBeenCalledWith("query", ["alpha", "beta"]);
    expect(out[0].score).toBe(0.8);
    expect(out[1].score).toBe(0.4);
    expect(out[0].matchReason).toBe("bm25+semantic+rerank");
    expect(out[1].matchReason).toBe("bm25+semantic+rerank");
  });

  it("keeps original score if an index is missing from provider output", async () => {
    const input = [makeResult("1", "alpha", 0.2), makeResult("2", "beta", 0.1)];

    const provider = {
      id: "mock",
      model: "mock-rerank",
      rerank: vi.fn().mockResolvedValue([{ index: 1, relevance_score: 0.9 }]),
    };

    const out = await rerankWithProvider(input, "query", provider);

    expect(out[0].score).toBe(0.2);
    expect(out[0].matchReason).toBe("bm25+semantic");
    expect(out[1].score).toBe(0.9);
    expect(out[1].matchReason).toBe("bm25+semantic+rerank");
  });

  it("falls back to original results when provider throws", async () => {
    const input = [makeResult("1", "alpha", 0.2), makeResult("2", "beta", 0.1)];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const provider = {
      id: "mock",
      model: "mock-rerank",
      rerank: vi.fn().mockRejectedValue(new Error("network")),
    };

    const out = await rerankWithProvider(input, "query", provider);

    expect(out).toBe(input);
    expect(warnSpy).toHaveBeenCalled();
  });
});

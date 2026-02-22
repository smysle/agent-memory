import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAIRerankProvider,
  getRerankerProviderFromEnv,
} from "../../src/search/rerank-provider.js";

describe("rerank-provider", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  it("returns null when provider is none", () => {
    process.env.AGENT_MEMORY_RERANK_PROVIDER = "none";
    const provider = getRerankerProviderFromEnv();
    expect(provider).toBeNull();
  });

  it("creates provider from env with OPENAI fallback key/baseUrl", () => {
    process.env.AGENT_MEMORY_RERANK_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";

    const provider = getRerankerProviderFromEnv();
    expect(provider).not.toBeNull();
    expect(provider?.model).toBe("Qwen/Qwen3-Reranker-8B");
  });

  it("returns null when provider enabled but no api key", () => {
    process.env.AGENT_MEMORY_RERANK_PROVIDER = "openai";
    delete process.env.AGENT_MEMORY_RERANK_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const provider = getRerankerProviderFromEnv();
    expect(provider).toBeNull();
  });

  it("calls OpenAI-compatible /rerank and parses results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.3 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const provider = createOpenAIRerankProvider({
      apiKey: "sk-test",
      model: "Qwen/Qwen3-Reranker-8B",
      baseUrl: "https://momo.example/v1/",
    });

    const out = await provider.rerank("hello", ["a", "b"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://momo.example/v1/rerank");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "Qwen/Qwen3-Reranker-8B",
      query: "hello",
      documents: ["a", "b"],
    });

    expect(out).toEqual([
      { index: 1, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.3 },
    ]);
  });

  it("throws when rerank API responds non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "down",
    }) as any);

    const provider = createOpenAIRerankProvider({ apiKey: "sk", model: "m" });

    await expect(provider.rerank("q", ["d"])).rejects.toThrow("Rerank API failed: 503");
  });
});

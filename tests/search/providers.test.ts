import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAIProvider,
  getDefaultInstruction,
  getEmbeddingProviderFromEnv,
} from "../../src/search/providers.js";

describe("embedding providers", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
  });

  it("returns default instruction for Qwen models only", () => {
    expect(getDefaultInstruction("Qwen3-Embedding-8B")).toBe("Given a query, retrieve the most semantically relevant document");
    expect(getDefaultInstruction("gemini-embedding-001")).toBeNull();
    expect(getDefaultInstruction("text-embedding-3-small")).toBeNull();
  });

  it("creates gemini provider from env with GEMINI_* fallback to OPENAI_*", () => {
    process.env.AGENT_MEMORY_EMBEDDINGS_PROVIDER = "gemini";
    process.env.OPENAI_API_KEY = "sk-openai-fallback";
    process.env.OPENAI_BASE_URL = "https://momo.example/v1";

    const provider = getEmbeddingProviderFromEnv();

    expect(provider).not.toBeNull();
    expect(provider?.id).toBe("gemini");
    expect(provider?.model).toBe("gemini-embedding-001");
    expect(provider?.instructionPrefix).toBeNull();
  });

  it("supports google alias provider type", () => {
    process.env.AGENT_MEMORY_EMBEDDINGS_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "sk-gemini";

    const provider = getEmbeddingProviderFromEnv();

    expect(provider).not.toBeNull();
    expect(provider?.id).toBe("gemini");
  });

  it("applies AGENT_MEMORY_EMBEDDINGS_INSTRUCTION override", () => {
    process.env.AGENT_MEMORY_EMBEDDINGS_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.AGENT_MEMORY_EMBEDDINGS_MODEL = "Qwen3-Embedding-8B";
    process.env.AGENT_MEMORY_EMBEDDINGS_INSTRUCTION = "Custom query instruction";

    const provider = getEmbeddingProviderFromEnv();
    expect(provider?.instructionPrefix).toBe("Custom query instruction");

    process.env.AGENT_MEMORY_EMBEDDINGS_INSTRUCTION = "none";
    const disabled = getEmbeddingProviderFromEnv();
    expect(disabled?.instructionPrefix).toBeNull();
  });

  it("embedQuery prepends Instruct/Query when instruction exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const provider = createOpenAIProvider({
      apiKey: "sk-test",
      model: "Qwen3-Embedding-8B",
      baseUrl: "https://momo.example/v1/",
      instruction: "Given a query, retrieve the most semantically relevant document",
    });

    await provider.embedQuery?.("害怕失去重要的人");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe("Instruct: Given a query, retrieve the most semantically relevant document\nQuery: 害怕失去重要的人");
  });

  it("embedQuery falls back to plain query when instruction is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const provider = createOpenAIProvider({
      apiKey: "sk-test",
      model: "gemini-embedding-001",
      instruction: null,
    });

    await provider.embedQuery?.("plain-query");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe("plain-query");
  });
});

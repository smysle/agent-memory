import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGeminiEmbeddingProvider,
  createLocalHttpEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
} from "../../src/search/embedding.js";
import {
  getEmbeddingProvider,
  getEmbeddingProviderFromEnv,
  healthcheckEmbeddingProvider,
} from "../../src/search/providers.js";

describe("embedding providers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls openai-compatible embeddings endpoint with batch input", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { embedding: [0.1, 0.2] },
        { embedding: [0.3, 0.4] },
      ],
    }), { status: 200 }));

    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret",
      model: "text-embedding-3-small",
      dimension: 2,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.embed(["alpha", "beta"]))
      .resolves
      .toEqual([[0.1, 0.2], [0.3, 0.4]]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "text-embedding-3-small",
      input: ["alpha", "beta"],
    });
  });

  it("supports local-http providers and healthcheck", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      embeddings: [[1, 0], [0, 1]],
    }), { status: 200 }));

    const provider = createLocalHttpEmbeddingProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimension: 2,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.embed(["left", "right"]))
      .resolves
      .toEqual([[1, 0], [0, 1]]);

    await expect(healthcheckEmbeddingProvider(provider)).resolves.toEqual({
      enabled: true,
      providerId: provider.id,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when embedding provider is not configured", () => {
    expect(getEmbeddingProviderFromEnv({})).toBeNull();
  });

  it("calls Gemini batchEmbedContents endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      embeddings: [
        { values: [0.5, 0.6, 0.7] },
        { values: [0.8, 0.9, 1.0] },
      ],
    }), { status: 200 }));

    const provider = createGeminiEmbeddingProvider({
      model: "gemini-embedding-2-preview",
      dimension: 3,
      apiKey: "test-gemini-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.embed(["hello", "world"]))
      .resolves
      .toEqual([[0.5, 0.6, 0.7], [0.8, 0.9, 1.0]]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("gemini-embedding-2-preview:batchEmbedContents");
    expect(url).toContain("key=test-gemini-key");
    const body = JSON.parse(String(init.body));
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].content.parts[0].text).toBe("hello");
    expect(body.requests[0].outputDimensionality).toBe(3);
  });

  it("creates gemini provider from env config", () => {
    const provider = getEmbeddingProvider({
      env: {
        AGENT_MEMORY_EMBEDDING_PROVIDER: "gemini",
        AGENT_MEMORY_EMBEDDING_MODEL: "gemini-embedding-2-preview",
        AGENT_MEMORY_EMBEDDING_API_KEY: "test-key",
        AGENT_MEMORY_EMBEDDING_DIMENSION: "3072",
      } as unknown as NodeJS.ProcessEnv,
    });

    expect(provider).not.toBeNull();
    expect(provider!.model).toBe("gemini-embedding-2-preview");
    expect(provider!.dimension).toBe(3072);
    expect(provider!.id).toContain("gemini:");
  });

  it("supports custom baseUrl for gemini provider", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      embeddings: [{ values: [0.1, 0.2] }],
    }), { status: 200 }));

    const provider = createGeminiEmbeddingProvider({
      model: "gemini-embedding-2-preview",
      dimension: 2,
      apiKey: "test-key",
      baseUrl: "https://my-proxy.example.com",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await provider.embed(["test"]);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("my-proxy.example.com");
    expect(url).toContain("/v1beta/models/gemini-embedding-2-preview:batchEmbedContents");
    expect(url).not.toContain("generativelanguage.googleapis.com");
  });
});

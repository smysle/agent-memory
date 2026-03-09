import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalHttpEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
} from "../../src/search/embedding.js";
import {
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
});

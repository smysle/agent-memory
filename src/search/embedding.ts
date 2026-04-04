import { createHash } from "crypto";

export interface EmbeddingProvider {
  id: string;
  model: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
  healthcheck?(): Promise<void>;
}

export interface EmbeddingProviderOptions {
  baseUrl: string;
  model: string;
  dimension: number;
  apiKey?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponseItem {
  embedding: number[];
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveEndpoint(baseUrl: string, endpoint = "/embeddings"): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  if (trimmed.endsWith("/embeddings")) {
    return trimmed;
  }
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${trimmed}${normalizedEndpoint}`;
}

function stableProviderId(prefix: string, input: string): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return `${prefix}:${digest}`;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  const candidate = fetchImpl ?? globalThis.fetch;
  if (!candidate) {
    throw new Error("Global fetch is not available in this runtime");
  }
  return candidate;
}

function assertEmbeddingVector(vector: unknown, dimension: number, context: string): number[] {
  if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`${context} returned an invalid embedding vector`);
  }
  if (vector.length !== dimension) {
    throw new Error(`${context} returned dimension ${vector.length}, expected ${dimension}`);
  }
  return vector as number[];
}

function parseOpenAIResponse(json: unknown, dimension: number, context: string): number[][] {
  const rows = (json as { data?: EmbeddingResponseItem[] })?.data;
  if (!Array.isArray(rows)) {
    throw new Error(`${context} returned an invalid embeddings payload`);
  }
  return rows.map((row, index) => assertEmbeddingVector(row?.embedding, dimension, `${context} item ${index}`));
}

function parseLocalHttpResponse(json: unknown, dimension: number, context: string): number[][] {
  if (Array.isArray((json as { embeddings?: unknown }).embeddings)) {
    const embeddings = (json as { embeddings: unknown[] }).embeddings;
    return embeddings.map((row, index) => assertEmbeddingVector(row, dimension, `${context} item ${index}`));
  }
  return parseOpenAIResponse(json, dimension, context);
}

function parseOllamaResponse(json: unknown, dimension: number, context: string): number[][] {
  const embeddings = (json as { embeddings?: unknown[] })?.embeddings;
  if (!Array.isArray(embeddings)) {
    throw new Error(`${context} returned an invalid embeddings payload`);
  }
  return embeddings.map((row, index) => assertEmbeddingVector(row, dimension, `${context} item ${index}`));
}

async function runEmbeddingRequest(input: {
  context: string;
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  parser: (json: unknown, dimension: number, context: string) => number[][];
  dimension: number;
  fetchImpl?: typeof fetch;
}): Promise<number[][]> {
  const fetchFn = getFetch(input.fetchImpl);
  const response = await fetchFn(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...input.headers,
    },
    body: JSON.stringify(input.body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${input.context} request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }

  const json = await response.json();
  return input.parser(json, input.dimension, input.context);
}

export function createOpenAICompatibleEmbeddingProvider(opts: EmbeddingProviderOptions): EmbeddingProvider {
  const url = resolveEndpoint(opts.baseUrl, opts.endpoint);
  const providerDescriptor = `${trimTrailingSlashes(opts.baseUrl)}|${opts.model}|${opts.dimension}`;
  const id = stableProviderId(`openai-compatible:${opts.model}`, providerDescriptor);

  return {
    id,
    model: opts.model,
    dimension: opts.dimension,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return runEmbeddingRequest({
        context: "openai-compatible embedding provider",
        url,
        dimension: opts.dimension,
        fetchImpl: opts.fetchImpl,
        headers: {
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          ...opts.headers,
        },
        body: {
          model: opts.model,
          input: texts,
        },
        parser: parseOpenAIResponse,
      });
    },
    async healthcheck(): Promise<void> {
      await this.embed(["healthcheck"]);
    },
  };
}

export function createLocalHttpEmbeddingProvider(opts: EmbeddingProviderOptions): EmbeddingProvider {
  const url = resolveEndpoint(opts.baseUrl, opts.endpoint);
  const providerDescriptor = `${trimTrailingSlashes(opts.baseUrl)}|${opts.model}|${opts.dimension}`;
  const id = stableProviderId(`local-http:${opts.model}`, providerDescriptor);

  return {
    id,
    model: opts.model,
    dimension: opts.dimension,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return runEmbeddingRequest({
        context: "local-http embedding provider",
        url,
        dimension: opts.dimension,
        fetchImpl: opts.fetchImpl,
        headers: opts.headers,
        body: {
          model: opts.model,
          input: texts,
        },
        parser: parseLocalHttpResponse,
      });
    },
    async healthcheck(): Promise<void> {
      await this.embed(["healthcheck"]);
    },
  };
}

export interface GeminiEmbeddingProviderOptions {
  model: string;
  dimension: number;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export function createGeminiEmbeddingProvider(opts: GeminiEmbeddingProviderOptions): EmbeddingProvider {
  const baseUrl = trimTrailingSlashes(opts.baseUrl || GEMINI_DEFAULT_BASE_URL);
  const descriptorInput = `${baseUrl}|${opts.model}|${opts.dimension}`;
  const id = stableProviderId(`gemini:${opts.model}`, descriptorInput);

  return {
    id,
    model: opts.model,
    dimension: opts.dimension,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const fetchFn = getFetch(opts.fetchImpl);
      const url = `${baseUrl}/v1beta/models/${opts.model}:batchEmbedContents?key=${opts.apiKey}`;
      const requests = texts.map((text) => ({
        model: `models/${opts.model}`,
        content: { parts: [{ text }] },
        outputDimensionality: opts.dimension,
      }));

      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Gemini embedding request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
      }

      const json = (await response.json()) as { embeddings?: Array<{ values?: unknown }> };
      const embeddings = json?.embeddings;
      if (!Array.isArray(embeddings)) {
        throw new Error("Gemini embedding response missing embeddings array");
      }

      return embeddings.map((entry, index) =>
        assertEmbeddingVector(entry?.values, opts.dimension, `Gemini embedding item ${index}`),
      );
    },
    async healthcheck(): Promise<void> {
      await this.embed(["healthcheck"]);
    },
  };
}

export function createOllamaEmbeddingProvider(opts: EmbeddingProviderOptions): EmbeddingProvider {
  // Explicitly assign the endpoint to override resolveEndpoint's default
  const endpoint = opts.endpoint ? opts.endpoint : "/api/embed";

  // Guard against users passing the full endpoint in the baseUrl
  const normalizedBaseUrl = trimTrailingSlashes(opts.baseUrl);
  const normalizedEndpoint = trimTrailingSlashes(endpoint);
  const url = normalizedBaseUrl.endsWith(normalizedEndpoint)
    ? normalizedBaseUrl
    : resolveEndpoint(opts.baseUrl, endpoint);
  const canonicalUrl = trimTrailingSlashes(url);

  const providerDescriptor = `${canonicalUrl}|${opts.model}|${opts.dimension}`;
  const id = stableProviderId(`ollama:${opts.model}`, providerDescriptor);

  return {
    id,
    model: opts.model,
    dimension: opts.dimension,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return runEmbeddingRequest({
        context: "ollama embedding provider",
        url,
        dimension: opts.dimension,
        fetchImpl: opts.fetchImpl,
        headers: opts.headers,
        body: {
          model: opts.model,
          input: texts,
        },
        parser: parseOllamaResponse,
      });
    },
    async healthcheck(): Promise<void> {
      await this.embed(["healthcheck"]);
    },
  };
}

export function normalizeEmbeddingBaseUrl(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl);
}

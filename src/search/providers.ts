// AgentMemory v2 — Embedding providers (OpenAI / Qwen / Gemini) via fetch
export interface EmbeddingProvider {
  id: string;
  model: string;
  dimension?: number;
  instructionPrefix?: string | null;
  embed(text: string): Promise<number[]>;
  embedQuery?(query: string): Promise<number[]>;
}

const QWEN_DEFAULT_INSTRUCTION = "Given a query, retrieve the most semantically relevant document";

export function getDefaultInstruction(model: string): string | null {
  const m = model.toLowerCase();
  if (m.includes("qwen")) return QWEN_DEFAULT_INSTRUCTION;
  if (m.includes("gemini")) return null;
  return null;
}

function resolveInstruction(model: string): string | null {
  const override = process.env.AGENT_MEMORY_EMBEDDINGS_INSTRUCTION;
  if (override !== undefined) {
    const normalized = override.trim();
    if (!normalized) return null;
    const lowered = normalized.toLowerCase();
    if (lowered === "none" || lowered === "off" || lowered === "false" || lowered === "null") return null;
    return normalized;
  }

  return getDefaultInstruction(model);
}

function buildQueryInput(query: string, instructionPrefix?: string | null): string {
  if (!instructionPrefix) return query;
  return `Instruct: ${instructionPrefix}\nQuery: ${query}`;
}

export function getEmbeddingProviderFromEnv(): EmbeddingProvider | null {
  const provider = (process.env.AGENT_MEMORY_EMBEDDINGS_PROVIDER ?? "none").toLowerCase();
  if (provider === "none" || provider === "off" || provider === "false") return null;

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.AGENT_MEMORY_EMBEDDINGS_MODEL ?? "text-embedding-3-small";
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    if (!apiKey) return null;
    const instruction = resolveInstruction(model);
    return createOpenAIProvider({ apiKey, model, baseUrl, instruction });
  }

  if (provider === "gemini" || provider === "google") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.OPENAI_API_KEY;
    const model = process.env.AGENT_MEMORY_EMBEDDINGS_MODEL ?? "gemini-embedding-001";
    const baseUrl = process.env.GEMINI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
    if (!apiKey) return null;
    const instruction = resolveInstruction(model);
    return createOpenAIProvider({ id: "gemini", apiKey, model, baseUrl, instruction });
  }

  if (provider === "qwen" || provider === "dashscope" || provider === "tongyi") {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const model = process.env.AGENT_MEMORY_EMBEDDINGS_MODEL ?? "text-embedding-v3";
    const baseUrl = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";
    if (!apiKey) return null;
    const instruction = resolveInstruction(model);
    return createDashScopeProvider({ apiKey, model, baseUrl, instruction });
  }

  return null;
}

function authHeader(apiKey: string): string {
  return apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
}

function normalizeEmbedding(e: unknown): number[] {
  if (!Array.isArray(e)) throw new Error("Invalid embedding: not an array");
  if (e.length === 0) throw new Error("Invalid embedding: empty");
  return e.map((x) => {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("Invalid embedding: non-numeric value");
    return x;
  });
}

export function createOpenAIProvider(opts: {
  id?: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  instruction?: string | null;
}): EmbeddingProvider {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  const instructionPrefix = opts.instruction ?? null;

  async function requestEmbedding(input: string): Promise<number[]> {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader(opts.apiKey),
      },
      body: JSON.stringify({ model: opts.model, input }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`OpenAI embeddings failed: ${resp.status} ${resp.statusText} ${body}`.trim());
    }
    const data = await resp.json() as { data?: Array<{ embedding?: unknown }> };
    return normalizeEmbedding(data.data?.[0]?.embedding);
  }

  return {
    id: opts.id ?? "openai",
    model: opts.model,
    instructionPrefix,
    async embed(text: string) {
      return requestEmbedding(text);
    },
    async embedQuery(query: string) {
      return requestEmbedding(buildQueryInput(query, instructionPrefix));
    },
  };
}

export function createDashScopeProvider(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  instruction?: string | null;
}): EmbeddingProvider {
  const baseUrl = opts.baseUrl ?? "https://dashscope.aliyuncs.com";
  const instructionPrefix = opts.instruction ?? null;

  async function requestEmbedding(text: string): Promise<number[]> {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/services/embeddings/text-embedding/text-embedding`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader(opts.apiKey),
      },
      body: JSON.stringify({
        model: opts.model,
        input: { texts: [text] },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`DashScope embeddings failed: ${resp.status} ${resp.statusText} ${body}`.trim());
    }
    const data = await resp.json() as {
      output?: {
        embeddings?: Array<{ embedding?: unknown; vector?: unknown }>;
        embedding?: unknown;
      };
      data?: Array<{ embedding?: unknown }>;
    };

    const emb =
      data.output?.embeddings?.[0]?.embedding
      ?? data.output?.embeddings?.[0]?.vector
      ?? data.output?.embedding
      ?? data.data?.[0]?.embedding;

    return normalizeEmbedding(emb);
  }

  return {
    id: "dashscope",
    model: opts.model,
    instructionPrefix,
    async embed(text: string) {
      return requestEmbedding(text);
    },
    async embedQuery(query: string) {
      return requestEmbedding(buildQueryInput(query, instructionPrefix));
    },
  };
}

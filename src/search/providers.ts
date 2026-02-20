// AgentMemory v2 — Embedding providers (OpenAI / Qwen) via fetch
export interface EmbeddingProvider {
  id: string;
  model: string;
  dimension?: number;
  embed(text: string): Promise<number[]>;
}

export function getEmbeddingProviderFromEnv(): EmbeddingProvider | null {
  const provider = (process.env.AGENT_MEMORY_EMBEDDINGS_PROVIDER ?? "none").toLowerCase();
  if (provider === "none" || provider === "off" || provider === "false") return null;

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.AGENT_MEMORY_EMBEDDINGS_MODEL ?? "text-embedding-3-small";
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    if (!apiKey) return null;
    return createOpenAIProvider({ apiKey, model, baseUrl });
  }

  if (provider === "qwen" || provider === "dashscope" || provider === "tongyi") {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const model = process.env.AGENT_MEMORY_EMBEDDINGS_MODEL ?? "text-embedding-v3";
    const baseUrl = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com";
    if (!apiKey) return null;
    return createDashScopeProvider({ apiKey, model, baseUrl });
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
  apiKey: string;
  model: string;
  baseUrl?: string;
}): EmbeddingProvider {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  return {
    id: "openai",
    model: opts.model,
    async embed(text: string) {
      const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader(opts.apiKey),
        },
        body: JSON.stringify({ model: opts.model, input: text }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`OpenAI embeddings failed: ${resp.status} ${resp.statusText} ${body}`.trim());
      }
      const data = await resp.json() as { data?: Array<{ embedding?: unknown }> };
      const emb = data.data?.[0]?.embedding;
      return normalizeEmbedding(emb);
    },
  };
}

export function createDashScopeProvider(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): EmbeddingProvider {
  const baseUrl = opts.baseUrl ?? "https://dashscope.aliyuncs.com";
  // Note: DashScope embedding response shapes vary across versions; keep parsing tolerant.
  return {
    id: "dashscope",
    model: opts.model,
    async embed(text: string) {
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
      const data = await resp.json() as any;

      const emb =
        data?.output?.embeddings?.[0]?.embedding
        ?? data?.output?.embeddings?.[0]?.vector
        ?? data?.output?.embedding
        ?? data?.data?.[0]?.embedding;

      return normalizeEmbedding(emb);
    },
  };
}


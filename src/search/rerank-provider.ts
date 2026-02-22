// AgentMemory v2 — External reranker providers (OpenAI-compatible /v1/rerank)

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export interface RerankProvider {
  id: string;
  model: string;
  rerank(query: string, documents: string[]): Promise<RerankResult[]>;
}

function authHeader(apiKey: string): string {
  return apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
}

export function getRerankerProviderFromEnv(): RerankProvider | null {
  const provider = (process.env.AGENT_MEMORY_RERANK_PROVIDER ?? "none").toLowerCase();
  if (provider === "none" || provider === "off") return null;

  if (provider === "openai" || provider === "jina" || provider === "cohere") {
    const apiKey = process.env.AGENT_MEMORY_RERANK_API_KEY ?? process.env.OPENAI_API_KEY;
    const model = process.env.AGENT_MEMORY_RERANK_MODEL ?? "Qwen/Qwen3-Reranker-8B";
    const baseUrl = process.env.AGENT_MEMORY_RERANK_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    if (!apiKey) return null;
    return createOpenAIRerankProvider({ apiKey, model, baseUrl });
  }

  return null;
}

export function createOpenAIRerankProvider(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): RerankProvider {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";

  return {
    id: "openai-rerank",
    model: opts.model,
    async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
      const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/rerank`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader(opts.apiKey),
        },
        body: JSON.stringify({ model: opts.model, query, documents }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Rerank API failed: ${resp.status} ${resp.statusText} ${body}`.trim());
      }

      const data = await resp.json() as { results?: Array<{ index?: unknown; relevance_score?: unknown }> };
      const results = data.results ?? [];

      return results
        .map((r) => {
          const index = typeof r.index === "number" ? r.index : Number.NaN;
          const relevance = typeof r.relevance_score === "number" ? r.relevance_score : Number.NaN;
          return { index, relevance_score: relevance };
        })
        .filter((r) => Number.isInteger(r.index) && Number.isFinite(r.relevance_score));
    },
  };
}

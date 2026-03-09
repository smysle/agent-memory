import {
  createLocalHttpEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
  normalizeEmbeddingBaseUrl,
  type EmbeddingProvider,
} from "./embedding.js";

export type EmbeddingProviderKind = "openai-compatible" | "local-http";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderKind;
  baseUrl: string;
  model: string;
  dimension: number;
  apiKey?: string;
}

export interface EmbeddingProviderFactoryOptions {
  config?: Partial<EmbeddingProviderConfig>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function parseDimension(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseProvider(raw: string | undefined): EmbeddingProviderKind | null {
  if (!raw) return null;
  if (raw === "openai-compatible" || raw === "local-http") {
    return raw;
  }
  throw new Error(`Unsupported embedding provider: ${raw}`);
}

export function getEmbeddingProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProviderConfig | null {
  const provider = parseProvider(env.AGENT_MEMORY_EMBEDDING_PROVIDER);
  if (!provider) return null;

  const baseUrl = env.AGENT_MEMORY_EMBEDDING_BASE_URL;
  const model = env.AGENT_MEMORY_EMBEDDING_MODEL;
  const dimension = parseDimension(env.AGENT_MEMORY_EMBEDDING_DIMENSION);

  if (!baseUrl) {
    throw new Error("AGENT_MEMORY_EMBEDDING_BASE_URL is required when embeddings are enabled");
  }
  if (!model) {
    throw new Error("AGENT_MEMORY_EMBEDDING_MODEL is required when embeddings are enabled");
  }
  if (!dimension) {
    throw new Error("AGENT_MEMORY_EMBEDDING_DIMENSION is required when embeddings are enabled");
  }
  if (provider === "openai-compatible" && !env.AGENT_MEMORY_EMBEDDING_API_KEY) {
    throw new Error("AGENT_MEMORY_EMBEDDING_API_KEY is required for openai-compatible providers");
  }

  return {
    provider,
    baseUrl,
    model,
    dimension,
    apiKey: env.AGENT_MEMORY_EMBEDDING_API_KEY,
  };
}

export function createEmbeddingProvider(
  input: EmbeddingProviderConfig,
  opts?: { fetchImpl?: typeof fetch },
): EmbeddingProvider {
  const normalized = {
    ...input,
    baseUrl: normalizeEmbeddingBaseUrl(input.baseUrl),
  };

  if (normalized.provider === "openai-compatible") {
    return createOpenAICompatibleEmbeddingProvider({
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      dimension: normalized.dimension,
      apiKey: normalized.apiKey,
      fetchImpl: opts?.fetchImpl,
    });
  }

  return createLocalHttpEmbeddingProvider({
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    dimension: normalized.dimension,
    fetchImpl: opts?.fetchImpl,
  });
}

export function resolveEmbeddingProviderConfig(opts?: { config?: Partial<EmbeddingProviderConfig>; env?: NodeJS.ProcessEnv }): EmbeddingProviderConfig | null {
  const envConfig = getEmbeddingProviderConfigFromEnv(opts?.env);
  if (!envConfig && !opts?.config?.provider) {
    return null;
  }

  const provider = opts?.config?.provider ?? envConfig?.provider;
  const baseUrl = opts?.config?.baseUrl ?? envConfig?.baseUrl;
  const model = opts?.config?.model ?? envConfig?.model;
  const dimension = opts?.config?.dimension ?? envConfig?.dimension;
  const apiKey = opts?.config?.apiKey ?? envConfig?.apiKey;

  if (!provider || !baseUrl || !model || !dimension) {
    throw new Error("Incomplete embedding provider configuration");
  }
  if (provider === "openai-compatible" && !apiKey) {
    throw new Error("OpenAI-compatible embedding providers require an API key");
  }

  return { provider, baseUrl, model, dimension, apiKey };
}

export function getEmbeddingProvider(opts?: EmbeddingProviderFactoryOptions): EmbeddingProvider | null {
  const config = resolveEmbeddingProviderConfig({ config: opts?.config, env: opts?.env });
  if (!config) return null;
  return createEmbeddingProvider(config, { fetchImpl: opts?.fetchImpl });
}

export function getEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  try {
    return getEmbeddingProvider({ env });
  } catch {
    return null;
  }
}

export function getConfiguredEmbeddingProviderId(opts?: { config?: Partial<EmbeddingProviderConfig>; env?: NodeJS.ProcessEnv }): string | null {
  try {
    const provider = getEmbeddingProvider({ config: opts?.config, env: opts?.env });
    return provider?.id ?? null;
  } catch {
    return null;
  }
}

export async function healthcheckEmbeddingProvider(provider: EmbeddingProvider | null): Promise<{ enabled: boolean; providerId?: string }> {
  if (!provider) {
    return { enabled: false };
  }
  if (provider.healthcheck) {
    await provider.healthcheck();
  } else {
    await provider.embed(["healthcheck"]);
  }
  return { enabled: true, providerId: provider.id };
}

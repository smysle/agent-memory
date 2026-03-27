import {
  createGeminiEmbeddingProvider,
  createLocalHttpEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
  normalizeEmbeddingBaseUrl,
  type EmbeddingProvider,
} from "./embedding.js";

export type EmbeddingProviderKind = "openai-compatible" | "local-http" | "gemini";
export type EmbeddingProviderHealthState = "healthy" | "degraded";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderKind;
  baseUrl: string;
  model: string;
  dimension: number;
  apiKey?: string;
}

export interface EmbeddingProviderFactoryOptions {
  config?: Partial<EmbeddingProviderConfig>;
  configs?: Array<Partial<EmbeddingProviderConfig>>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface EmbedWithFailoverResult {
  provider: EmbeddingProvider;
  vectors: number[][];
  recoveredPrimary: boolean;
}

export interface EmbeddingProviderRuntimeStatus {
  providerId: string;
  model: string;
  state: EmbeddingProviderHealthState;
  cooldownUntil: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
}

interface ProviderRuntimeEntry {
  config: EmbeddingProviderConfig;
  provider: EmbeddingProvider;
  state: EmbeddingProviderHealthState;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

interface PrimaryRecoveryResult {
  provider: EmbeddingProvider;
  vectors: number[][];
}

const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;
const PROVIDER_MANAGER_CACHE = new Map<string, EmbeddingProviderManager>();
let RUNTIME_PROVIDER_CONFIGS: EmbeddingProviderConfig[] | null = null;

function parseDimension(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseProvider(raw: string | undefined): EmbeddingProviderKind | null {
  if (!raw) return null;
  if (raw === "openai-compatible" || raw === "local-http" || raw === "gemini") {
    return raw;
  }
  throw new Error(`Unsupported embedding provider: ${raw}`);
}

function normalizeProviderConfig(input: Partial<EmbeddingProviderConfig>): EmbeddingProviderConfig {
  const provider = input.provider;
  const model = input.model;
  const dimension = input.dimension;
  const baseUrl = input.baseUrl ?? "";
  const apiKey = input.apiKey;

  if (!provider || !model || !dimension) {
    throw new Error("Incomplete embedding provider configuration");
  }
  if (provider !== "gemini" && !baseUrl) {
    throw new Error("baseUrl is required for non-gemini embedding providers");
  }
  if ((provider === "openai-compatible" || provider === "gemini") && !apiKey) {
    throw new Error(`${provider} embedding provider requires an API key`);
  }

  return {
    provider,
    model,
    dimension,
    baseUrl: baseUrl ? normalizeEmbeddingBaseUrl(baseUrl) : "",
    apiKey,
  };
}

function serializeConfigForCache(configs: EmbeddingProviderConfig[]): string {
  return JSON.stringify(configs.map((config) => ({
    provider: config.provider,
    model: config.model,
    dimension: config.dimension,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ?? "",
  })));
}

function createProviderFromConfig(
  input: EmbeddingProviderConfig,
  opts?: { fetchImpl?: typeof fetch },
): EmbeddingProvider {
  if (input.provider === "gemini") {
    return createGeminiEmbeddingProvider({
      model: input.model,
      dimension: input.dimension,
      apiKey: input.apiKey!,
      baseUrl: input.baseUrl || undefined,
      fetchImpl: opts?.fetchImpl,
    });
  }

  if (input.provider === "openai-compatible") {
    return createOpenAICompatibleEmbeddingProvider({
      baseUrl: input.baseUrl,
      model: input.model,
      dimension: input.dimension,
      apiKey: input.apiKey,
      fetchImpl: opts?.fetchImpl,
    });
  }

  return createLocalHttpEmbeddingProvider({
    baseUrl: input.baseUrl,
    model: input.model,
    dimension: input.dimension,
    fetchImpl: opts?.fetchImpl,
  });
}

export function getEmbeddingProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProviderConfig | null {
  const configs = getEmbeddingProviderConfigsFromEnv(env);
  return configs[0] ?? null;
}

export function getEmbeddingProviderConfigsFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProviderConfig[] {
  const provider = parseProvider(env.AGENT_MEMORY_EMBEDDING_PROVIDER);
  if (!provider) return [];

  const baseUrl = env.AGENT_MEMORY_EMBEDDING_BASE_URL;
  const model = env.AGENT_MEMORY_EMBEDDING_MODEL;
  const dimension = parseDimension(env.AGENT_MEMORY_EMBEDDING_DIMENSION);

  if (!baseUrl && provider !== "gemini") {
    throw new Error("AGENT_MEMORY_EMBEDDING_BASE_URL is required when embeddings are enabled (not needed for gemini provider)");
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
  if (provider === "gemini" && !env.AGENT_MEMORY_EMBEDDING_API_KEY) {
    throw new Error("AGENT_MEMORY_EMBEDDING_API_KEY is required for gemini provider (Google AI API key)");
  }

  return [normalizeProviderConfig({
    provider,
    baseUrl: baseUrl ?? "",
    model,
    dimension,
    apiKey: env.AGENT_MEMORY_EMBEDDING_API_KEY,
  })];
}

export function resolveEmbeddingProviderConfig(opts?: { config?: Partial<EmbeddingProviderConfig>; env?: NodeJS.ProcessEnv }): EmbeddingProviderConfig | null {
  const configs = resolveEmbeddingProviderConfigs({
    config: opts?.config ? [opts.config] : undefined,
    env: opts?.env,
  });
  return configs[0] ?? null;
}

export function getRuntimeEmbeddingProviderConfigs(): EmbeddingProviderConfig[] {
  return RUNTIME_PROVIDER_CONFIGS ? [...RUNTIME_PROVIDER_CONFIGS] : [];
}

export function setRuntimeEmbeddingProviderConfigs(configs?: Array<Partial<EmbeddingProviderConfig>> | null): void {
  RUNTIME_PROVIDER_CONFIGS = configs && configs.length > 0
    ? configs.map((config) => normalizeProviderConfig(config))
    : null;
  PROVIDER_MANAGER_CACHE.clear();
}

export function clearRuntimeEmbeddingProviderConfigs(): void {
  RUNTIME_PROVIDER_CONFIGS = null;
  PROVIDER_MANAGER_CACHE.clear();
}

export function resolveEmbeddingProviderConfigs(opts?: { config?: Array<Partial<EmbeddingProviderConfig>>; env?: NodeJS.ProcessEnv }): EmbeddingProviderConfig[] {
  const explicit = opts?.config?.map((config) => normalizeProviderConfig(config)) ?? [];
  if (explicit.length > 0) return explicit;

  if (RUNTIME_PROVIDER_CONFIGS && RUNTIME_PROVIDER_CONFIGS.length > 0) {
    return [...RUNTIME_PROVIDER_CONFIGS];
  }

  return getEmbeddingProviderConfigsFromEnv(opts?.env);
}

export function createEmbeddingProvider(
  input: EmbeddingProviderConfig,
  opts?: { fetchImpl?: typeof fetch },
): EmbeddingProvider {
  return createProviderFromConfig(normalizeProviderConfig(input), opts);
}

export function getEmbeddingProvider(opts?: EmbeddingProviderFactoryOptions): EmbeddingProvider | null {
  const config = resolveEmbeddingProviderConfig({
    config: opts?.config,
    env: opts?.env,
  });
  if (!config) return null;
  return createEmbeddingProvider(config, { fetchImpl: opts?.fetchImpl });
}

export function getEmbeddingProviders(opts?: EmbeddingProviderFactoryOptions): EmbeddingProvider[] {
  const explicitConfigs = opts?.configs ?? (opts?.config ? [opts.config] : undefined);
  const configs = resolveEmbeddingProviderConfigs({
    config: explicitConfigs,
    env: opts?.env,
  });
  return configs.map((config) => createEmbeddingProvider(config, { fetchImpl: opts?.fetchImpl }));
}

export class EmbeddingProviderManager {
  private readonly entries: ProviderRuntimeEntry[];
  private readonly cooldownMs: number;

  constructor(
    configs: EmbeddingProviderConfig[],
    opts?: { fetchImpl?: typeof fetch; failureCooldownMs?: number },
  ) {
    this.entries = configs.map((config) => ({
      config,
      provider: createProviderFromConfig(config, { fetchImpl: opts?.fetchImpl }),
      state: "healthy",
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    }));
    this.cooldownMs = Math.max(1_000, opts?.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS);
  }

  listProviders(): EmbeddingProvider[] {
    return this.entries.map((entry) => entry.provider);
  }

  getPrimaryProvider(): EmbeddingProvider | null {
    return this.entries[0]?.provider ?? null;
  }

  getActiveProvider(): EmbeddingProvider | null {
    const nowMs = Date.now();
    const healthy = this.entries.find((entry, index) => index === 0 || entry.state === "healthy" || entry.cooldownUntil <= nowMs);
    return healthy?.provider ?? this.getPrimaryProvider();
  }

  getConfiguredProviderIds(): string[] {
    return this.entries.map((entry) => entry.provider.id);
  }

  getStatus(): EmbeddingProviderRuntimeStatus[] {
    return this.entries.map((entry) => ({
      providerId: entry.provider.id,
      model: entry.provider.model,
      state: entry.state,
      cooldownUntil: entry.cooldownUntil > 0 ? new Date(entry.cooldownUntil).toISOString() : null,
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      consecutiveFailures: entry.consecutiveFailures,
    }));
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await this.embedWithFailover(texts);
    return result.vectors;
  }

  async embedWithFailover(texts: string[]): Promise<EmbedWithFailoverResult> {
    if (this.entries.length === 0) {
      throw new Error("No embedding providers configured");
    }

    let recovery: PrimaryRecoveryResult | null = null;
    try {
      recovery = await this.tryRecoverPrimary(texts);
    } catch {
      recovery = null;
    }

    if (recovery) {
      return {
        provider: recovery.provider,
        vectors: recovery.vectors,
        recoveredPrimary: true,
      };
    }
    const nowMs = Date.now();
    const attempts = this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => index === 0 || entry.state === "healthy" || entry.cooldownUntil <= nowMs);

    let lastError: unknown = null;
    for (const { entry } of attempts) {
      try {
        const vectors = await entry.provider.embed(texts);
        this.markSuccess(entry);
        return {
          provider: entry.provider,
          vectors,
          recoveredPrimary: false,
        };
      } catch (error) {
        this.markFailure(entry);
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("All embedding providers failed");
  }

  private async tryRecoverPrimary(texts: string[]): Promise<PrimaryRecoveryResult | null> {
    const primary = this.entries[0];
    if (!primary) return null;
    if (primary.state === "healthy") return null;
    if (primary.cooldownUntil > Date.now()) return null;

    try {
      const vectors = await primary.provider.embed(texts);
      if (!Array.isArray(vectors)) {
        throw new Error("Primary embedding provider returned an invalid vector payload");
      }
      this.markSuccess(primary);
      return { provider: primary.provider, vectors };
    } catch (error) {
      this.markFailure(primary);
      throw error;
    }
  }

  private markSuccess(entry: ProviderRuntimeEntry): void {
    entry.state = "healthy";
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = 0;
    entry.lastSuccessAt = new Date().toISOString();
  }

  private markFailure(entry: ProviderRuntimeEntry): void {
    entry.state = "degraded";
    entry.consecutiveFailures += 1;
    entry.cooldownUntil = Date.now() + this.cooldownMs;
    entry.lastFailureAt = new Date().toISOString();
  }
}

export function getEmbeddingProviderManager(opts?: EmbeddingProviderFactoryOptions): EmbeddingProviderManager | null {
  const explicitConfigs = opts?.configs ?? (opts?.config ? [opts.config] : undefined);
  const configs = resolveEmbeddingProviderConfigs({
    config: explicitConfigs,
    env: opts?.env,
  });
  if (configs.length === 0) return null;

  const cacheKey = serializeConfigForCache(configs);
  const cached = PROVIDER_MANAGER_CACHE.get(cacheKey);
  if (cached) return cached;

  const manager = new EmbeddingProviderManager(configs, { fetchImpl: opts?.fetchImpl });
  PROVIDER_MANAGER_CACHE.set(cacheKey, manager);
  return manager;
}

export function getEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  try {
    const config = getEmbeddingProviderConfigFromEnv(env);
    return config ? createEmbeddingProvider(config) : null;
  } catch {
    return null;
  }
}

export function getConfiguredEmbeddingProviderId(opts?: { config?: Partial<EmbeddingProviderConfig>; env?: NodeJS.ProcessEnv }): string | null {
  try {
    const manager = getEmbeddingProviderManager({
      config: opts?.config,
      env: opts?.env,
    });
    return manager?.getPrimaryProvider()?.id ?? null;
  } catch {
    return null;
  }
}

export function getConfiguredEmbeddingProviderIds(opts?: { configs?: Array<Partial<EmbeddingProviderConfig>>; env?: NodeJS.ProcessEnv }): string[] {
  try {
    const manager = getEmbeddingProviderManager({
      configs: opts?.configs,
      env: opts?.env,
    });
    return manager?.getConfiguredProviderIds() ?? [];
  } catch {
    return [];
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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.ts";

/**
 * 动态模型目录(docs/UPSTREAM.md §9,docs/DESIGN.md "Model discovery")。
 * 来源优先级:实时 endpoint → 本 gateway 磁盘缓存 → 只读 ~/.codex/models_cache.json。
 * 严禁模型白名单;一切能力字段来自目录。
 */

export interface CatalogModel {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: string[];
  visibility: string;
  supportedInApi: boolean;
  priority: number;
  additionalSpeedTiers: string[];
  serviceTiers: Array<{ id: string; name?: string; description?: string }>;
  defaultServiceTier: string | null;
  contextWindow: number | null;
  maxContextWindow: number | null;
  inputModalities: string[];
}

export interface CatalogResult {
  models: CatalogModel[];
  source: "live" | "disk-cache" | "codex-cache";
  fetchedAt: string | null;
}

export class CatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

interface CacheFileShape {
  fetched_at?: string;
  models?: unknown[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 归一化上游条目;容忍缺字段,不认识的字段直接丢弃(防 schema 漂移炸毁) */
export function normalizeModel(raw: unknown): CatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.slug !== "string" || r.slug.length === 0) return null;
  const reasoningLevels = Array.isArray(r.supported_reasoning_levels)
    ? r.supported_reasoning_levels
        .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>).effort : null))
        .filter((x): x is string => typeof x === "string")
    : [];
  const serviceTiers = Array.isArray(r.service_tiers)
    ? r.service_tiers
        .map((e) => {
          if (typeof e !== "object" || e === null) return null;
          const t = e as Record<string, unknown>;
          if (typeof t.id !== "string") return null;
          return {
            id: t.id,
            ...(typeof t.name === "string" ? { name: t.name } : {}),
            ...(typeof t.description === "string" ? { description: t.description } : {}),
          };
        })
        .filter((x): x is { id: string; name?: string; description?: string } => x !== null)
    : [];
  return {
    slug: r.slug,
    displayName: typeof r.display_name === "string" ? r.display_name : r.slug,
    description: typeof r.description === "string" ? r.description : "",
    defaultReasoningLevel: typeof r.default_reasoning_level === "string" ? r.default_reasoning_level : null,
    supportedReasoningLevels: reasoningLevels,
    visibility: typeof r.visibility === "string" ? r.visibility : "list",
    supportedInApi: r.supported_in_api !== false,
    priority: typeof r.priority === "number" ? r.priority : 0,
    additionalSpeedTiers: asStringArray(r.additional_speed_tiers),
    serviceTiers,
    defaultServiceTier: typeof r.default_service_tier === "string" ? r.default_service_tier : null,
    contextWindow: typeof r.context_window === "number" ? r.context_window : null,
    maxContextWindow: typeof r.max_context_window === "number" ? r.max_context_window : null,
    inputModalities: asStringArray(r.input_modalities).length > 0 ? asStringArray(r.input_modalities) : ["text"],
  };
}

/** 可见性过滤:对齐 Codex 的 show_in_picker + supported_in_api */
export function isVisibleModel(m: CatalogModel): boolean {
  return m.visibility === "list" && m.supportedInApi;
}

export function supportsFast(m: CatalogModel): boolean {
  return (
    m.additionalSpeedTiers.includes("fast") ||
    m.serviceTiers.some((t) => t.id === "fast" || t.id === "priority")
  );
}

export class ModelCatalog {
  private readonly home: string;
  private readonly codexHome: string;
  private readonly fetchModels: () => Promise<unknown[]>;
  private readonly ttlMs: number;
  private memory: { models: CatalogModel[]; fetchedAt: string; at: number } | null = null;

  constructor(deps: {
    home: string;
    codexHome: string;
    fetchModels: () => Promise<unknown[]>;
    ttlMs?: number;
  }) {
    this.home = deps.home;
    this.codexHome = deps.codexHome;
    this.fetchModels = deps.fetchModels;
    this.ttlMs = deps.ttlMs ?? 300_000;
  }

  private get cachePath(): string {
    return path.join(this.home, "models_cache.json");
  }

  async getModels(): Promise<CatalogResult> {
    if (this.memory && Date.now() - this.memory.at < this.ttlMs) {
      return { models: this.memory.models, source: "live", fetchedAt: this.memory.fetchedAt };
    }
    try {
      const rawModels = await this.fetchModels();
      const models = rawModels.map(normalizeModel).filter((m): m is CatalogModel => m !== null);
      if (models.length > 0) {
        const fetchedAt = new Date().toISOString();
        await this.saveDiskCache(fetchedAt, rawModels);
        this.memory = { models, fetchedAt, at: Date.now() };
        return { models, source: "live", fetchedAt };
      }
      // 关键保护:live 返回空(200 但空数组 / 全是无法识别的条目)时
      // **绝不**覆盖有效缓存与内存态——否则一次上游抖动会清空目录。
      log.warn("实时模型目录返回空,保留既有缓存并回退");
    } catch (err) {
      log.warn("实时模型目录获取失败,尝试缓存兜底", err instanceof Error ? err.message : String(err));
    }

    const disk = await this.readCacheFile(this.cachePath);
    if (disk) {
      log.warn(`使用 gateway 磁盘缓存目录(${disk.fetchedAt ?? "unknown"},可能过期)`);
      return { models: disk.models, source: "disk-cache", fetchedAt: disk.fetchedAt };
    }

    const codexCache = await this.readCacheFile(path.join(this.codexHome, "models_cache.json"));
    if (codexCache) {
      log.warn(`使用 Codex CLI 只读缓存目录(${codexCache.fetchedAt ?? "unknown"},可能过期)`);
      return { models: codexCache.models, source: "codex-cache", fetchedAt: codexCache.fetchedAt };
    }

    throw new CatalogUnavailableError(
      "model catalog unavailable: live fetch failed or returned empty, and no cache found; run `osg doctor`",
    );
  }

  /** 可见模型(OpenAI /v1/models 暴露面) */
  async listVisible(): Promise<CatalogResult> {
    const result = await this.getModels();
    return { ...result, models: result.models.filter(isVisibleModel) };
  }

  async findModel(slug: string): Promise<CatalogModel | null> {
    const { models } = await this.getModels();
    return models.find((m) => m.slug === slug && isVisibleModel(m)) ?? null;
  }

  private async saveDiskCache(fetchedAt: string, rawModels: unknown[]): Promise<void> {
    try {
      await mkdir(this.home, { recursive: true });
      const body: CacheFileShape = { fetched_at: fetchedAt, models: rawModels };
      await writeFile(this.cachePath, JSON.stringify(body), "utf8");
    } catch (err) {
      log.debug("模型目录磁盘缓存写入失败(忽略)", err instanceof Error ? err.message : String(err));
    }
  }

  private async readCacheFile(file: string): Promise<{ models: CatalogModel[]; fetchedAt: string | null } | null> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as CacheFileShape;
      if (!Array.isArray(parsed.models)) return null;
      const models = parsed.models.map(normalizeModel).filter((m): m is CatalogModel => m !== null);
      if (models.length === 0) return null;
      return { models, fetchedAt: typeof parsed.fetched_at === "string" ? parsed.fetched_at : null };
    } catch {
      return null;
    }
  }
}

/** 映射为 OpenAI 标准 /v1/models 响应(不泄漏内部元数据) */
export function toOpenAiModelList(models: CatalogModel[], fetchedAt: string | null): {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
} {
  const created = fetchedAt ? Math.floor(Date.parse(fetchedAt) / 1000) : 0;
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.slug,
      object: "model" as const,
      created: Number.isFinite(created) ? created : 0,
      owned_by: "openai",
    })),
  };
}

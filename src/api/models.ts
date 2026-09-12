import { ModelCatalog, toOpenAiModelList, supportsFast, CatalogUnavailableError } from "../upstream/catalog.ts";
import { ApiError } from "./errors.ts";

/**
 * GET /v1/models:OpenAI 标准 schema,不泄漏内部元数据。
 * GET /internal/models:只读诊断,完整目录元数据(非 OpenAI schema)。
 */
export async function handleModels(catalog: ModelCatalog): Promise<{ status: number; body: unknown }> {
  try {
    const { models, fetchedAt } = await catalog.listVisible();
    return { status: 200, body: toOpenAiModelList(models, fetchedAt) };
  } catch (err) {
    if (err instanceof CatalogUnavailableError) {
      throw new ApiError(503, "upstream_unavailable", err.message, { code: "catalog_unavailable" });
    }
    throw err;
  }
}

export async function handleInternalModels(catalog: ModelCatalog): Promise<{ status: number; body: unknown }> {
  try {
    const { models, source, fetchedAt } = await catalog.listVisible();
    return {
      status: 200,
      body: {
        source,
        fetched_at: fetchedAt,
        count: models.length,
        models: models.map((m) => ({
          id: m.slug,
          display_name: m.displayName,
          description: m.description,
          default_reasoning_effort: m.defaultReasoningLevel,
          supported_reasoning_efforts: m.supportedReasoningLevels,
          supports_fast: supportsFast(m),
          service_tiers: m.serviceTiers,
          default_service_tier: m.defaultServiceTier,
          context_window: m.contextWindow,
          max_context_window: m.maxContextWindow,
          input_modalities: m.inputModalities,
          priority: m.priority,
        })),
      },
    };
  } catch (err) {
    if (err instanceof CatalogUnavailableError) {
      throw new ApiError(503, "upstream_unavailable", err.message, { code: "catalog_unavailable" });
    }
    throw err;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeModel,
  isVisibleModel,
  supportsFast,
  ModelCatalog,
  toOpenAiModelList,
  CatalogUnavailableError,
} from "../../src/upstream/catalog.ts";
import { CATALOG_FIXTURE } from "../helpers/fixtures.ts";

test("normalizeModel:完整条目 + 缺字段容错 + 非对象剔除", () => {
  const full = normalizeModel(CATALOG_FIXTURE.models[0]);
  assert.ok(full);
  assert.equal(full.slug, "gpt-test-a");
  assert.deepEqual(full.supportedReasoningLevels, ["low", "medium", "high"]);
  assert.equal(full.contextWindow, 272000);
  assert.deepEqual(full.inputModalities, ["text", "image"]);

  const sparse = normalizeModel({ slug: "x" });
  assert.ok(sparse);
  assert.equal(sparse.displayName, "x");
  assert.equal(sparse.supportedInApi, true);
  assert.deepEqual(sparse.inputModalities, ["text"]);

  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel({}), null);
  assert.equal(normalizeModel("str"), null);
});

test("可见性过滤:visibility!=list 或 supported_in_api=false 被过滤", () => {
  const models = CATALOG_FIXTURE.models.map(normalizeModel).filter((m) => m !== null);
  const visible = models.filter(isVisibleModel).map((m) => m.slug);
  assert.deepEqual(visible.sort(), ["gpt-test-a", "gpt-test-b"]);
});

test("supportsFast:additional_speed_tiers 或 service_tiers 命中", () => {
  const [a, b] = CATALOG_FIXTURE.models.map(normalizeModel);
  assert.equal(supportsFast(a!), true);
  assert.equal(supportsFast(b!), false);
});

test("toOpenAiModelList:标准 schema,不泄漏内部元数据", () => {
  const models = CATALOG_FIXTURE.models
    .map(normalizeModel)
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .filter(isVisibleModel);
  const list = toOpenAiModelList(models, CATALOG_FIXTURE.fetched_at);
  assert.equal(list.object, "list");
  assert.equal(list.data.length, 2);
  const first = list.data[0]!;
  assert.deepEqual(Object.keys(first).sort(), ["created", "id", "object", "owned_by"]);
  assert.equal(first.owned_by, "openai");
  assert.ok(first.created > 0);
});

async function withTempDirs(fn: (home: string, codexHome: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "osg-cat-home-"));
  const codexHome = await mkdtemp(path.join(tmpdir(), "osg-cat-codex-"));
  try {
    await fn(home, codexHome);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
}

test("catalog 回退链:live 失败 → gateway 磁盘缓存", () => {
  return withTempDirs(async (home, codexHome) => {
    // 先写入 gateway 磁盘缓存
    await writeFile(path.join(home, "models_cache.json"), JSON.stringify(CATALOG_FIXTURE), "utf8");
    const catalog = new ModelCatalog({
      home,
      codexHome,
      fetchModels: async () => {
        throw new Error("network down");
      },
    });
    const result = await catalog.getModels();
    assert.equal(result.source, "disk-cache");
    assert.ok(result.models.length >= 2);
  });
});

test("catalog 回退链:无 gateway 缓存 → 只读 codex 缓存", () => {
  return withTempDirs(async (home, codexHome) => {
    await writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify(CATALOG_FIXTURE), "utf8");
    const catalog = new ModelCatalog({
      home,
      codexHome,
      fetchModels: async () => {
        throw new Error("network down");
      },
    });
    const result = await catalog.getModels();
    assert.equal(result.source, "codex-cache");
  });
});

test("catalog:全部来源失败 → CatalogUnavailableError", () => {
  return withTempDirs(async (home, codexHome) => {
    const catalog = new ModelCatalog({
      home,
      codexHome,
      fetchModels: async () => {
        throw new Error("network down");
      },
    });
    await assert.rejects(() => catalog.getModels(), CatalogUnavailableError);
  });
});

test("catalog:live 成功 → 写磁盘缓存并记忆(TTL 内不再请求)", () => {
  return withTempDirs(async (home, codexHome) => {
    let calls = 0;
    const catalog = new ModelCatalog({
      home,
      codexHome,
      fetchModels: async () => {
        calls++;
        return CATALOG_FIXTURE.models;
      },
    });
    const r1 = await catalog.getModels();
    assert.equal(r1.source, "live");
    const r2 = await catalog.getModels();
    assert.equal(calls, 1, "TTL 内第二次不重新拉取");
    assert.equal(r2.models.length, 4);
  });
});

test("catalog:findModel 只命中可见模型", () => {
  return withTempDirs(async (home, codexHome) => {
    const catalog = new ModelCatalog({ home, codexHome, fetchModels: async () => CATALOG_FIXTURE.models });
    assert.equal((await catalog.findModel("gpt-test-a"))?.slug, "gpt-test-a");
    assert.equal(await catalog.findModel("gpt-hidden"), null, "隐藏模型不可见");
    assert.equal(await catalog.findModel("no-such"), null);
  });
});

// ---------- v0.1.1:缓存保护(live 空结果不得覆盖有效缓存) ----------

const VALID_MODELS = [{ slug: "gpt-good", display_name: "Good", supported_reasoning_levels: [{ effort: "low" }], visibility: "list", supported_in_api: true, priority: 1 }];

test("缓存保护:live 正常 → 更新磁盘缓存与内存", async () => {
  return withTempDirs(async (home, codexHome) => {
    const catalog = new ModelCatalog({ home, codexHome, fetchModels: async () => VALID_MODELS });
    const r = await catalog.getModels();
    assert.equal(r.source, "live");
    assert.equal(r.models.length, 1);
    const cached = JSON.parse(await readFile(path.join(home, "models_cache.json"), "utf8")) as { models: unknown[] };
    assert.equal(cached.models.length, 1, "有效结果应写入缓存");
  });
});

test("缓存保护:live 返回空数组 → 不覆盖缓存,回退旧缓存", async () => {
  return withTempDirs(async (home, codexHome) => {
    // 先写入有效缓存
    await writeFile(path.join(home, "models_cache.json"), JSON.stringify(CATALOG_FIXTURE), "utf8");
    const before = await readFile(path.join(home, "models_cache.json"), "utf8");

    const catalog = new ModelCatalog({ home, codexHome, fetchModels: async () => [] });
    const r = await catalog.getModels();

    assert.equal(r.source, "disk-cache", "空结果必须回退到既有缓存");
    assert.ok(r.models.length > 0);
    const after = await readFile(path.join(home, "models_cache.json"), "utf8");
    assert.equal(after, before, "缓存文件不得被空结果覆盖");
  });
});

test("缓存保护:live 返回全是无法识别的条目 → 同样不覆盖缓存", async () => {
  return withTempDirs(async (home, codexHome) => {
    await writeFile(path.join(home, "models_cache.json"), JSON.stringify(CATALOG_FIXTURE), "utf8");
    const before = await readFile(path.join(home, "models_cache.json"), "utf8");
    const catalog = new ModelCatalog({ home, codexHome, fetchModels: async () => [{ garbage: true }, null, 42] });
    const r = await catalog.getModels();
    assert.equal(r.source, "disk-cache");
    assert.equal(await readFile(path.join(home, "models_cache.json"), "utf8"), before);
  });
});

test("缓存保护:live 抛异常 → 回退缓存(既有行为不回归)", async () => {
  return withTempDirs(async (home, codexHome) => {
    await writeFile(path.join(home, "models_cache.json"), JSON.stringify(CATALOG_FIXTURE), "utf8");
    const catalog = new ModelCatalog({
      home,
      codexHome,
      fetchModels: async () => {
        throw new Error("network down");
      },
    });
    const r = await catalog.getModels();
    assert.equal(r.source, "disk-cache");
  });
});

test("缓存保护:live 空 + 无任何缓存 → 明确 unavailable(不静默返回空列表)", async () => {
  return withTempDirs(async (home, codexHome) => {
    const catalog = new ModelCatalog({ home, codexHome, fetchModels: async () => [] });
    await assert.rejects(() => catalog.getModels(), CatalogUnavailableError);
  });
});

test("缓存保护:先缓存成功,后续 live 空 → 内存态保留(不降级为空)", async () => {
  return withTempDirs(async (home, codexHome) => {
    let mode: "valid" | "empty" = "valid";
    const catalog = new ModelCatalog({
      home,
      codexHome,
      ttlMs: 0, // 禁用内存命中,强制每次都走 live
      fetchModels: async () => (mode === "valid" ? VALID_MODELS : []),
    });
    const first = await catalog.getModels();
    assert.equal(first.source, "live");
    mode = "empty";
    const second = await catalog.getModels();
    assert.equal(second.source, "disk-cache");
    assert.deepEqual(second.models.map((m) => m.slug), ["gpt-good"], "空结果不得让目录缩水");
  });
});

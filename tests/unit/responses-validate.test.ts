import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildUpstreamBody } from "../../src/api/responses.ts";
import { ModelCatalog } from "../../src/upstream/catalog.ts";
import { ApiError } from "../../src/api/errors.ts";
import { CATALOG_FIXTURE } from "../helpers/fixtures.ts";

async function withCatalog(fn: (catalog: ModelCatalog) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "osg-rv-"));
  try {
    const catalog = new ModelCatalog({
      home,
      codexHome: path.join(home, "none"),
      fetchModels: async () => CATALOG_FIXTURE.models,
    });
    await fn(catalog);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function expectApiError(p: Promise<unknown>, status: number, codeFragment?: string): Promise<void> {
  return assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
    assert.equal(err.status, status);
    if (codeFragment) assert.ok(err.message.includes(codeFragment) || (err.code ?? "").includes(codeFragment));
    return true;
  }) as Promise<void>;
}

test("buildUpstreamBody:强制 stream=true / store=false / include 合并", () => {
  return withCatalog(async (catalog) => {
    const v = await buildUpstreamBody(
      { model: "gpt-test-a", input: "hi", include: ["foo"] },
      catalog,
    );
    assert.equal(v.stream, false, "下游未要求 stream");
    assert.equal(v.upstreamBody.stream, true, "上游恒流式");
    assert.equal(v.upstreamBody.store, false);
    assert.deepEqual((v.upstreamBody.include as string[]).sort(), ["foo", "reasoning.encrypted_content"]);
  });
});

test("buildUpstreamBody:model 必填 / store:true / previous_response_id → 400", () => {
  return withCatalog(async (catalog) => {
    await expectApiError(buildUpstreamBody({ input: "x" }, catalog), 400, "model");
    await expectApiError(buildUpstreamBody({ model: "gpt-test-a", input: "x", store: true }, catalog), 400, "store");
    await expectApiError(
      buildUpstreamBody({ model: "gpt-test-a", input: "x", previous_response_id: "r1" }, catalog),
      400,
      "previous_response_id",
    );
    await expectApiError(buildUpstreamBody(["not-object"], catalog), 400);
  });
});

test("buildUpstreamBody:未知模型 → 404;隐藏模型 → 404", () => {
  return withCatalog(async (catalog) => {
    await expectApiError(buildUpstreamBody({ model: "no-such-model", input: "x" }, catalog), 404, "no-such-model");
    await expectApiError(buildUpstreamBody({ model: "gpt-hidden", input: "x" }, catalog), 404);
  });
});

test("buildUpstreamBody:reasoning effort 不本地校验,一律透传(交上游裁决)", async () => {
  return withCatalog(async (catalog) => {
    // 目录声明 low/medium/high,但 "ultra"/"none" 都透传——实测目录不是权威白名单
    const v1 = await buildUpstreamBody(
      { model: "gpt-test-a", input: "x", reasoning: { effort: "ultra" } },
      catalog,
    );
    assert.deepEqual(v1.upstreamBody.reasoning, { effort: "ultra" });
    const v2 = await buildUpstreamBody(
      { model: "gpt-test-a", input: "x", reasoning: { effort: "none" } },
      catalog,
    );
    assert.deepEqual(v2.upstreamBody.reasoning, { effort: "none" });
  });
});

test("buildUpstreamBody:tools / service_tier / instructions 原样透传", () => {
  return withCatalog(async (catalog) => {
    const tools = [{ type: "function", name: "get_weather", parameters: { type: "object" } }];
    const v = await buildUpstreamBody(
      {
        model: "gpt-test-a",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        instructions: "You are helpful.",
        tools,
        service_tier: "fast",
        tool_choice: { type: "function", name: "get_weather" },
        parallel_tool_calls: false,
        max_output_tokens: 128,
      },
      catalog,
    );
    assert.deepEqual(v.upstreamBody.tools, tools);
    assert.equal(v.upstreamBody.service_tier, "fast");
    assert.equal(v.upstreamBody.instructions, "You are helpful.");
    assert.deepEqual(v.upstreamBody.tool_choice, { type: "function", name: "get_weather" });
    assert.equal(v.upstreamBody.parallel_tool_calls, false);
    assert.equal(v.upstreamBody.max_output_tokens, 128);
    // 未在透传清单里的字段不得出现
    assert.equal("background" in v.upstreamBody, false);
  });
});

test("buildUpstreamBody:catalog 为 null 时跳过本地校验", async () => {
  const v = await buildUpstreamBody({ model: "anything", input: "x" }, null);
  assert.equal(v.model, "anything");
});

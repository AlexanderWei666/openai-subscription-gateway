import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForCodex } from "../../src/upstream/codex.ts";

test("input 字符串 → message item 列表", () => {
  const { body, notes } = normalizeForCodex({ model: "m", input: "hello" });
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
  assert.ok(notes.some((n) => n.param === "input" && n.action === "normalized"));
});

test("input 已是列表 → 不动", () => {
  const items = [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }];
  const { body, notes } = normalizeForCodex({ model: "m", input: items });
  assert.deepEqual(body.input, items);
  assert.equal(notes.length, 0);
});

test("上游不支持的参数被剥离并记录", () => {
  const { body, notes } = normalizeForCodex({
    model: "m",
    input: [],
    temperature: 0.5,
    top_p: 0.9,
    truncation: "auto",
    metadata: { k: "v" },
    max_output_tokens: 16,
  });
  for (const p of ["temperature", "top_p", "truncation", "metadata", "max_output_tokens"]) {
    assert.equal(p in body, false, `${p} 应被剥离`);
    assert.ok(notes.some((n) => n.param === p && n.action === "stripped"), `${p} 应有 note`);
  }
});

test("service_tier:fast→priority;auto→省略;其他不动", () => {
  const fast = normalizeForCodex({ model: "m", input: [], service_tier: "fast" });
  assert.equal(fast.body.service_tier, "priority");
  assert.ok(fast.notes.some((n) => n.action === "rewritten"));

  const auto = normalizeForCodex({ model: "m", input: [], service_tier: "auto" });
  assert.equal("service_tier" in auto.body, false);

  const priority = normalizeForCodex({ model: "m", input: [], service_tier: "priority" });
  assert.equal(priority.body.service_tier, "priority");
  assert.equal(priority.notes.length, 0);

  const def = normalizeForCodex({ model: "m", input: [], service_tier: "default" });
  assert.equal(def.body.service_tier, "default");
});

test("支持的字段全部原样保留", () => {
  const { body, notes } = normalizeForCodex({
    model: "m",
    input: [],
    instructions: "x",
    reasoning: { effort: "low" },
    tools: [{ type: "function", name: "f" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    prompt_cache_key: "k",
    text: { format: { type: "text" } },
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  });
  assert.equal(notes.length, 0);
  assert.equal(body.instructions, "x");
  assert.deepEqual(body.reasoning, { effort: "low" });
});

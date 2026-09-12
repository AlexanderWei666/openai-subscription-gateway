import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUpstreamError, toApiError, apiErrorBody } from "../../src/api/errors.ts";
import { UpstreamError } from "../../src/upstream/codex.ts";

test("状态码映射表(docs/UPSTREAM.md §14)", () => {
  const cases: Array<[UpstreamError, number, string]> = [
    [new UpstreamError("http", "x", { status: 400, body: JSON.stringify({ error: { message: "bad", code: "bad_req" } }) }), 400, "invalid_request_error"],
    [new UpstreamError("http", "x", { status: 401 }), 401, "authentication_error"],
    [new UpstreamError("http", "x", { status: 404 }), 404, "invalid_request_error"],
    [new UpstreamError("http", "x", { status: 429, body: JSON.stringify({ error: { message: "slow down" } }) }), 429, "rate_limit_error"],
    [new UpstreamError("http", "x", { status: 500 }), 502, "upstream_error"],
    [new UpstreamError("http", "x", { status: 503 }), 502, "upstream_error"],
    [new UpstreamError("network", "ECONNREFUSED"), 503, "upstream_unavailable"],
    [new UpstreamError("timeout", "aborted"), 504, "upstream_timeout"],
    [new UpstreamError("protocol", "bad json"), 502, "upstream_error"],
  ];
  for (const [err, status, type] of cases) {
    const mapped = mapUpstreamError(err);
    assert.equal(mapped.status, status, `${err.kind}/${err.status}`);
    assert.equal(mapped.type, type, `${err.kind}/${err.status}`);
  }
});

test("上游 message/code 被保留;OpenAI 风格 body 结构", () => {
  const mapped = mapUpstreamError(
    new UpstreamError("http", "x", { status: 400, body: JSON.stringify({ error: { message: "model too long", code: "context" } }) }),
  );
  assert.equal(mapped.message, "model too long");
  assert.equal(mapped.code, "context");
  const body = apiErrorBody(mapped);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "param", "type"]);
});

test("429 透传 Retry-After 头", () => {
  const headers = new Headers({ "retry-after": "17" });
  const mapped = mapUpstreamError(new UpstreamError("http", "x", { status: 429, headers }));
  assert.equal(mapped.extraHeaders["retry-after"], "17");
});

test("toApiError:未知异常 → 500 internal", () => {
  const mapped = toApiError(new Error("boom"));
  assert.equal(mapped.status, 500);
  assert.equal(mapped.type, "internal_error");
});

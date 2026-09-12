/** 测试共用的合成目录 fixture(字段名对齐上游 wire,见 docs/UPSTREAM.md §9) */

export const CATALOG_FIXTURE = {
  fetched_at: "2026-09-10T12:00:00.000Z",
  etag: 'W/"test"',
  client_version: "0.148.0",
  models: [
    {
      slug: "gpt-test-a",
      display_name: "GPT Test A",
      description: "primary test model",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "l" },
        { effort: "medium", description: "m" },
        { effort: "high", description: "h" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      additional_speed_tiers: ["fast"],
      service_tiers: [{ id: "priority", name: "Fast", description: "2x" }],
      context_window: 272000,
      max_context_window: 872000,
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-test-b",
      display_name: "GPT Test B",
      description: "no fast, text only",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "l" }],
      visibility: "list",
      supported_in_api: true,
      priority: 5,
      additional_speed_tiers: [],
      service_tiers: [],
      context_window: 128000,
      input_modalities: ["text"],
    },
    {
      slug: "gpt-hidden",
      display_name: "Hidden",
      description: "should be filtered out",
      visibility: "hide",
      supported_in_api: true,
      priority: 99,
    },
    {
      slug: "gpt-noapi",
      display_name: "NoApi",
      description: "supported_in_api=false, filtered out",
      visibility: "list",
      supported_in_api: false,
      priority: 98,
    },
  ],
};

/** 生成一个未签名 JWT(仅测试用):header.payload.signature */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(payload)}.fakesig`;
}

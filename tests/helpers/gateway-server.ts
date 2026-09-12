import type { AddressInfo } from "node:net";
import type { Config } from "../../src/config.ts";
import type { CodexUpstream } from "../../src/upstream/codex.ts";
import type { ModelCatalog } from "../../src/upstream/catalog.ts";
import { createGatewayServer } from "../../src/server.ts";
import type { MockUpstream } from "./mock-upstream.ts";
import { makeTestRuntime } from "./mock-upstream.ts";

/** 起一套完整 gateway(mock upstream + 真实 HTTP server),测试客户端直连 */
export async function startGateway(mock: MockUpstream): Promise<{
  url: string;
  close: () => Promise<void>;
  runtime: Awaited<ReturnType<typeof makeTestRuntime>>;
}> {
  const runtime = await makeTestRuntime(mock);
  const deps: { config: Config; upstream: CodexUpstream; catalog: ModelCatalog } = {
    config: runtime.config,
    upstream: runtime.upstream,
    catalog: runtime.catalog,
  };
  const server = createGatewayServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    runtime,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.cleanup();
    },
  };
}

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../../src/config.ts";
import { loadConfig } from "../../src/config.ts";
import { CodexUpstream } from "../../src/upstream/codex.ts";
import { ModelCatalog } from "../../src/upstream/catalog.ts";
import { CATALOG_FIXTURE } from "./fixtures.ts";

/**
 * Mock Codex upstream:记录请求、按脚本响应。
 * 用于 Layer 2 contract tests——不碰真实 OpenAI。
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export type ResponsesBehavior =
  | {
      kind: "sse";
      events: string[];
      delayBetweenMs?: number;
      closeAfterEvents?: number;
      /**
       * 发完全部事件后**不关闭连接**(保持打开)。
       * 用于验证"收到 response.completed 即完成"的契约:
       * 上游结束帧之后再挂住连接,网关不得继续等待(见 tests/contract/responses.test.ts)。
       */
      keepOpenAfterEvents?: boolean;
    }
  | { kind: "status"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "hang" }
  /** 连接层瞬断:直接销毁 socket,模拟 fetch failed(网络/代理链路抖动) */
  | { kind: "socketDestroy" }
  | { kind: "sequence"; steps: ResponsesBehavior[] };

export class MockUpstream {
  private server: http.Server;
  private sockets = new Set<import("node:net").Socket>();
  readonly requests: RecordedRequest[] = [];
  private behavior: ResponsesBehavior = { kind: "sse", events: [] };
  private stepCount = 0;
  /** 客户端(gateway 的 fetch)中止时置 true */
  clientAborted = false;
  /** 手工控制 SSE 推送节奏(可选) */
  onRequest: ((req: RecordedRequest) => void) | null = null;

  private constructor(server: http.Server) {
    this.server = server;
  }

  static async start(): Promise<MockUpstream> {
    const server = http.createServer();
    const mock = new MockUpstream(server);
    server.on("request", (req, res) => mock.handle(req, res));
    server.on("connection", (socket) => {
      mock.sockets.add(socket);
      socket.on("close", () => mock.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return mock;
  }

  get baseUrl(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  setBehavior(b: ResponsesBehavior): void {
    this.behavior = b;
    this.stepCount = 0;
  }

  async close(): Promise<void> {
    // 强制销毁残留 keep-alive 连接,否则 server.close() 会挂起
    this.server.closeAllConnections?.();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private nextBehavior(): ResponsesBehavior {
    if (this.behavior.kind === "sequence") {
      const step = this.behavior.steps[Math.min(this.stepCount, this.behavior.steps.length - 1)];
      this.stepCount++;
      return step ?? { kind: "status", status: 500, body: "no step" };
    }
    return this.behavior;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "?",
        url: req.url ?? "?",
        headers: req.headers,
        body,
      };
      this.requests.push(recorded);
      this.onRequest?.(recorded);

      if (req.url?.startsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: CATALOG_FIXTURE.models }));
        return;
      }
      if (req.url === "/responses" && req.method === "POST") {
        this.respond(this.nextBehavior(), res);
        return;
      }
      res.writeHead(404).end("mock: unknown route");
    });
  }

  private respond(behavior: ResponsesBehavior, res: http.ServerResponse): void {
    res.on("close", () => {
      if (!res.writableEnded) this.clientAborted = true;
    });
    switch (behavior.kind) {
      case "status": {
        res.writeHead(behavior.status, {
          "content-type": "application/json",
          ...(behavior.headers ?? {}),
        });
        res.end(behavior.body);
        return;
      }
      case "hang": {
        // 永不响应(超时测试)
        return;
      }
      case "socketDestroy": {
        res.socket?.destroy();
        return;
      }
      case "sse": {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const events = behavior.events;
        const limit = behavior.closeAfterEvents ?? events.length;
        let i = 0;
        const push = (): void => {
          if (res.writableEnded) return;
          if (i >= limit) {
            // closeAfterEvents < events.length → premature close 场景
            res.end();
            return;
          }
          const data = events[i];
          i++;
          res.write(`data: ${data}\n\n`);
          if (i < limit) {
            setTimeout(push, behavior.delayBetweenMs ?? 0);
          } else if (!behavior.keepOpenAfterEvents) {
            setTimeout(() => res.end(), behavior.delayBetweenMs ?? 0);
          }
          // keepOpenAfterEvents:发完即挂住连接(不 end),用于验证网关不依赖连接关闭
        };
        push();
        return;
      }
      case "sequence":
        return; // 已在 nextBehavior 展开
    }
  }
}

/** 造一套指向 mock upstream 的运行时(config + upstream + catalog + 临时 home) */
export async function makeTestRuntime(mock: MockUpstream): Promise<{
  config: Config;
  upstream: CodexUpstream;
  catalog: ModelCatalog;
  home: string;
  cleanup: () => Promise<void>;
  forceRefreshCalls: number;
}> {
  const home = await mkdtemp(path.join(tmpdir(), "osg-test-"));
  const base = loadConfig(
    {
      OSG_HOME: home,
      OSG_UPSTREAM_BASE_URL: mock.baseUrl,
      OSG_UPSTREAM_TIMEOUT_MS: "2000",
    },
    // 注入 stub 探测:测试不依赖机器上是否装了 codex,也不触发真实进程调用
    { detect: () => ({ value: "9.9.9-test", via: "stub" }) },
  );
  const config: Config = { ...base, upstreamTimeoutMs: 2000 };
  const state = { forceRefreshCalls: 0 };
  const upstream = new CodexUpstream(config, async (opts) => {
    if (opts.forceRefresh) state.forceRefreshCalls++;
    return { accessToken: "test-access-token", accountId: "acct-test-123" };
  });
  const catalog = new ModelCatalog({
    home,
    codexHome: path.join(home, "no-such-codex-home"),
    fetchModels: async () => {
      const { json } = await upstream.getJson("/models?client_version=test");
      return (json as { models: unknown[] }).models;
    },
  });
  return {
    config,
    upstream,
    catalog,
    home,
    cleanup: () => rm(home, { recursive: true, force: true }),
    get forceRefreshCalls() {
      return state.forceRefreshCalls;
    },
  };
}

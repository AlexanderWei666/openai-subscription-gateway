import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveClientVersion,
  readConfigFileClientVersion,
  isValidVersion,
  FALLBACK_CODEX_VERSION,
  type DetectedVersion,
} from "../../src/upstream/client-version.ts";
import { loadConfig } from "../../src/config.ts";
import { formatEffectiveConfigReport } from "../../src/cli/config-report.ts";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "osg-cv-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const detect = (value: string, via = "stub") => (): DetectedVersion => ({ value, via });

// ---------- 优先级 ----------

test("优先级:env > config.json > detect > fallback(env 存在时最高)", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "config.json"), JSON.stringify({ clientVersion: "1.1.1" }), "utf8");
    const info = resolveClientVersion({
      env: { OSG_CODEX_CLIENT_VERSION: "2.2.2" },
      home,
      detect: detect("3.3.3"),
      alwaysDetect: true, // 展示场景:即使有配置也探测,以便对比
    });
    assert.equal(info.effective, "2.2.2");
    assert.equal(info.source, "env");
    assert.equal(info.configuredEnv, "2.2.2");
    assert.equal(info.configuredFile, "1.1.1");
    assert.equal(info.detected?.value, "3.3.3");
  });
});

test("优先级:env 缺失时 config.json 生效(source=config)", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "config.json"), JSON.stringify({ clientVersion: "1.2.3" }), "utf8");
    const info = resolveClientVersion({ env: {}, home, detect: detect("3.3.3") });
    assert.equal(info.effective, "1.2.3");
    assert.equal(info.source, "config");
  });
});

test("优先级:env/config 都缺失时用自动检测(source=detect)", async () => {
  await withHome(async (home) => {
    const info = resolveClientVersion({ env: {}, home, detect: detect("4.5.6", "wsl") });
    assert.equal(info.effective, "4.5.6");
    assert.equal(info.source, "detect");
    assert.equal(info.detected?.via, "wsl");
  });
});

test("检测失败(codex 不存在)→ fallback,且不抛异常", async () => {
  await withHome(async (home) => {
    const info = resolveClientVersion({ env: {}, home, detect: () => null });
    assert.equal(info.effective, FALLBACK_CODEX_VERSION);
    assert.equal(info.source, "fallback");
    assert.equal(info.detected, null);
    assert.ok(info.notes.some((n) => n.includes("兜底")), "应记录兜底说明");
  });
});

test("检测抛异常 → fallback + note,不阻断", async () => {
  await withHome(async (home) => {
    const info = resolveClientVersion({
      env: {},
      home,
      detect: () => {
        throw new Error("spawn failed");
      },
    });
    assert.equal(info.effective, FALLBACK_CODEX_VERSION);
    assert.equal(info.source, "fallback");
    assert.ok(info.notes.some((n) => n.includes("检测抛错")));
  });
});

// ---------- config.json 容错 ----------

test("config.json 不存在 → 忽略,不记噪音 note", async () => {
  await withHome(async (home) => {
    const notes: string[] = [];
    assert.equal(readConfigFileClientVersion(home, notes), null);
    assert.deepEqual(notes, []);
  });
});

test("config.json 非法 JSON → 忽略 + note,不抛", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "config.json"), "{ broken", "utf8");
    const notes: string[] = [];
    assert.equal(readConfigFileClientVersion(home, notes), null);
    assert.ok(notes.some((n) => n.includes("不是合法 JSON")));
    const info = resolveClientVersion({ env: {}, home, detect: detect("7.7.7") });
    assert.equal(info.effective, "7.7.7", "损坏的 config.json 不应阻断解析");
  });
});

test("config.json 的 clientVersion 非法格式 → 忽略 + note", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "config.json"), JSON.stringify({ clientVersion: "latest" }), "utf8");
    const notes: string[] = [];
    assert.equal(readConfigFileClientVersion(home, notes), null);
    assert.ok(notes.some((n) => n.includes("非法")));
  });
});

test("config.json 无 clientVersion 字段 → 返回 null 且无 note", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "config.json"), JSON.stringify({ other: 1 }), "utf8");
    const notes: string[] = [];
    assert.equal(readConfigFileClientVersion(home, notes), null);
    assert.deepEqual(notes, []);
  });
});

test("env 为空字符串 → 视为未设置(忽略 + note)", async () => {
  await withHome(async (home) => {
    const info = resolveClientVersion({ env: { OSG_CODEX_CLIENT_VERSION: "   " }, home, detect: detect("8.8.8") });
    assert.equal(info.configuredEnv, null);
    assert.equal(info.effective, "8.8.8");
    assert.equal(info.source, "detect");
    assert.ok(info.notes.some((n) => n.includes("为空")));
  });
});

test("env 格式非法 → 忽略该来源并降级(不允许垃圾串进入 upstream)", async () => {
  await withHome(async (home) => {
    const info = resolveClientVersion({ env: { OSG_CODEX_CLIENT_VERSION: "nightly" }, home, detect: detect("8.8.8") });
    assert.equal(info.configuredEnv, null, "非法 env 值必须被丢弃");
    assert.equal(info.effective, "8.8.8", "应降级到下一优先级(自动检测)");
    assert.equal(info.source, "detect");
    assert.ok(info.notes.some((n) => n.includes("非法")));
  });
});

test("env 为注入式垃圾串 → 同样被丢弃(样例:带路径/超长/命令拼接)", async () => {
  await withHome(async (home) => {
    for (const junk of ["../../etc/passwd", "0.153.4;rm -rf /", "x".repeat(500), "1.2", "1.2.3.4"]) {
      const info = resolveClientVersion({ env: { OSG_CODEX_CLIENT_VERSION: junk }, home, detect: () => null });
      assert.equal(info.configuredEnv, null, `垃圾值应被丢弃: ${junk.slice(0, 20)}`);
      assert.equal(info.effective, FALLBACK_CODEX_VERSION, "应落到 fallback");
    }
  });
});

test("isValidVersion:严格锚定 x.y.z(不再接受包含版本号的任意字符串)", () => {
  assert.equal(isValidVersion("0.153.4"), true);
  assert.equal(isValidVersion("  0.153.4  "), true, "允许首尾空白");
  assert.equal(isValidVersion("codex-cli 0.153.4"), false, "整体必须是版本号");
  assert.equal(isValidVersion("v0.153.4"), false);
  assert.equal(isValidVersion("0.153"), false);
  assert.equal(isValidVersion("latest"), false);
  assert.equal(isValidVersion(""), false);
  assert.equal(isValidVersion(undefined), false);
  assert.equal(isValidVersion(123), false);
});

// ---------- loadConfig 集成 ----------

test("loadConfig:注入 detect 后 clientVersion 与 sources 一致", async () => {
  await withHome(async (home) => {
    const cfg = loadConfig({ OSG_HOME: home }, { detect: detect("5.5.5") });
    assert.equal(cfg.clientVersion, "5.5.5");
    assert.equal(cfg.clientVersionInfo.source, "detect");
    assert.equal(cfg.sources.clientVersion, "detect");
    assert.equal(cfg.sources.host, "default");
    assert.equal(cfg.sources.home, "env");
  });
});

test("loadConfig:不注入 detect 也不抛(真实探测失败走 fallback 也安全)", async () => {
  await withHome(async (home) => {
    const cfg = loadConfig({ OSG_HOME: home });
    assert.ok(typeof cfg.clientVersion === "string" && cfg.clientVersion.length > 0);
    assert.ok(["env", "config", "detect", "fallback"].includes(cfg.clientVersionInfo.source));
  });
});

// ---------- doctor / osg config 展示 ----------

test("doctor 报告:包含 configured / detected / fallback / effective / source", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "config.json"), JSON.stringify({ clientVersion: "1.9.9" }), "utf8");
    const cfg = loadConfig({ OSG_HOME: home, OSG_CODEX_CLIENT_VERSION: "2.9.9" }, {
      detect: detect("3.9.9", "wsl"),
      alwaysDetect: true, // doctor 走的就是这条路径
    });
    const report = formatEffectiveConfigReport(cfg);

    assert.match(report, /Effective configuration:/);
    assert.match(report, /clientVersion\s+= 2\.9\.9\s+\(source: env\)/);
    assert.match(report, /configured\s+: env=2\.9\.9 config\.json=1\.9\.9/);
    assert.match(report, /detected\s+: 3\.9\.9 \(via wsl\)/);
    assert.match(report, new RegExp(`fallback\\s+: ${FALLBACK_CODEX_VERSION.replace(/\./g, "\\.")}`));
    assert.match(report, /auth path\s+= .*auth\.json/);
  });
});

test("doctor 报告:fallback 场景下 notes 会展示兜底原因", async () => {
  await withHome(async (home) => {
    const cfg = loadConfig({ OSG_HOME: home }, { detect: () => null });
    const report = formatEffectiveConfigReport(cfg);
    assert.match(report, /\(source: fallback\)/);
    assert.match(report, /configured\s+: env=<none> config\.json=<none>/);
    assert.match(report, /detected\s+: <none>/);
    assert.match(report, /notes\s+:/);
    assert.match(report, /兜底/);
  });
});

test("检测版本低于已验证版本 → 仅提示(不改取值)", async () => {
  await withHome(async (home) => {
    const info = resolveClientVersion({ env: {}, home, detect: detect("0.100.0", "codex.exe") });
    assert.equal(info.effective, "0.100.0", "取值不被自动修正(不自动升级/降级)");
    assert.equal(info.source, "detect");
    assert.ok(
      info.notes.some((n) => n.includes("低于已验证版本")),
      "应提示目录可能缩水",
    );
  });
});

test("检测版本等于或高于已验证版本 → 无漂移提示", async () => {
  await withHome(async (home) => {
    const eq = resolveClientVersion({ env: {}, home, detect: detect(FALLBACK_CODEX_VERSION) });
    assert.ok(!eq.notes.some((n) => n.includes("低于已验证版本")));
    const higher = resolveClientVersion({ env: {}, home, detect: detect("9.0.0") });
    assert.ok(!higher.notes.some((n) => n.includes("低于已验证版本")));
  });
});

test("compareVersions:数值比较而非字典序", async () => {
  const { compareVersions } = await import("../../src/upstream/client-version.ts");
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("0.153.4", "0.153.4"), 0);
  assert.equal(compareVersions("1.0.0", "0.999.999"), 1);
});

test("短路:env 已配置时不执行探测(detect 不被调用)", async () => {
  await withHome(async (home) => {
    let called = 0;
    const info = resolveClientVersion({
      env: { OSG_CODEX_CLIENT_VERSION: "3.3.3" },
      home,
      detect: () => {
        called++;
        return { value: "9.9.9", via: "stub" };
      },
    });
    assert.equal(info.effective, "3.3.3");
    assert.equal(called, 0, "有配置就不该起探测进程");
    assert.equal(info.detected, null);
  });
});

test("短路:config.json 已配置时同样不探测", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "config.json"), JSON.stringify({ clientVersion: "4.4.4" }), "utf8");
    let called = 0;
    const info = resolveClientVersion({
      env: {},
      home,
      detect: () => {
        called++;
        return { value: "9.9.9", via: "stub" };
      },
    });
    assert.equal(info.effective, "4.4.4");
    assert.equal(called, 0);
  });
});

test("alwaysDetect:有配置时仍探测,以便 doctor 展示 detected", async () => {
  await withHome(async (home) => {
    const info = resolveClientVersion({
      env: { OSG_CODEX_CLIENT_VERSION: "3.3.3" },
      home,
      detect: () => ({ value: "0.153.4", via: "wsl" }),
      alwaysDetect: true,
    });
    assert.equal(info.effective, "3.3.3", "取值仍是配置优先");
    assert.equal(info.source, "env");
    assert.equal(info.detected?.value, "0.153.4", "detected 供展示");
  });
});

/**
 * JWT 解析(仅解码 payload,不验签——token 是发给我们自己的,上游负责验证)。
 * 契约见 docs/UPSTREAM.md §3:过期时间取 access_token 的 exp;
 * account_id 取 id_token 的 claim "https://api.openai.com/auth".chatgpt_account_id。
 */

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("invalid JWT shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const json = Buffer.from(b64 + pad, "base64").toString("utf8");
  const payload: unknown = JSON.parse(json);
  if (typeof payload !== "object" || payload === null) throw new Error("invalid JWT payload");
  return payload as Record<string, unknown>;
}

/** 过期时间(epoch 秒);取不到返回 null */
export function jwtExpiration(token: string): number | null {
  try {
    const exp = decodeJwtPayload(token).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/** 从 id_token 提取 ChatGPT Account ID;取不到返回 null */
export function extractAccountId(idToken: string): string | null {
  try {
    const payload = decodeJwtPayload(idToken);
    const authClaim = payload["https://api.openai.com/auth"];
    if (typeof authClaim === "object" && authClaim !== null) {
      const id = (authClaim as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === "string" && id.length > 0) return id;
    }
    // 兜底:部分 token 直接把 claim 放顶层
    const top = payload.chatgpt_account_id;
    return typeof top === "string" && top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/** 从 id_token 提取用户标识(仅用于 status 展示,邮箱也属于低敏展示项) */
export function extractUserLabel(idToken: string): string | null {
  try {
    const payload = decodeJwtPayload(idToken);
    const email = payload.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

import { createHash, randomBytes } from "node:crypto";

/** base64url 无 padding(对齐 Codex CLI 的 PKCE 编码,见 docs/UPSTREAM.md §2) */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE verifier:64 随机字节 → base64url 无 pad */
export function generateVerifier(): string {
  return base64url(randomBytes(64));
}

/** PKCE challenge:BASE64URL(SHA256(verifier)) 无 pad,方法 S256 */
export function challengeForVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

/** OAuth state:32 随机字节 → base64url 无 pad */
export function generateState(): string {
  return base64url(randomBytes(32));
}

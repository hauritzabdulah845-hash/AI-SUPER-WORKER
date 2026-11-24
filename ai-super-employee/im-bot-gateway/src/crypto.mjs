/**
 * 飞书回调加解密与签名（按飞书开放平台公开文档实现）。
 *
 * - 明文模式：POST JSON 直接是 {type:"url_verification", challenge, token}，校验 token 即可；
 * - 加密模式：POST JSON 为 {encrypt:"<base64>"}，AES-256-CBC 解密后才是真实内容，
 *   key = SHA256(encryptKey) 原始 32 字节，iv = key 前 16 字节，PKCS7 填充；
 * - 签名：X-Lark-Signature = SHA1(timestamp + nonce + encryptKey + 原始请求体) 十六进制。
 *
 * 真实接入时建议先用明文模式打通链路，再切换加密模式（见 README「接入步骤」）。
 * 测试用 encryptLark 构造加密报文，保证解密路径被真实覆盖。
 */
import crypto from "node:crypto";

/** 飞书事件签名。 */
export function larkSignature({ timestamp, nonce, encryptKey, body }) {
  return crypto
    .createHash("sha1")
    .update(`${timestamp ?? ""}${nonce ?? ""}${encryptKey ?? ""}${body ?? ""}`)
    .digest("hex");
}

function aesKeyOf(encryptKey) {
  return crypto.createHash("sha256").update(String(encryptKey ?? ""), "utf8").digest();
}

/** 解密飞书加密报文，返回明文字符串。 */
export function decryptLark(encryptedB64, encryptKey) {
  const key = aesKeyOf(encryptKey);
  const iv = key.subarray(0, 16);
  const data = Buffer.from(String(encryptedB64 ?? ""), "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/** 加密任意 JSON 对象（测试与本地联调用）。 */
export function encryptLark(payload, encryptKey) {
  const key = aesKeyOf(encryptKey);
  const iv = key.subarray(0, 16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("base64");
}

/**
 * 解析事件请求体：兼容明文与加密两种模式。
 * 返回 { payload, error }，payload 为解密/直读后的对象。
 */
export function parseEventBody(rawBody, { encryptKey = "", verificationToken = "" } = {}) {
  let outer;
  try {
    outer = JSON.parse(rawBody);
  } catch {
    return { payload: null, error: "请求体不是合法 JSON" };
  }

  if (typeof outer.encrypt === "string") {
    if (!encryptKey) return { payload: null, error: "服务端未配置 encryptKey，无法解密回调" };
    try {
      outer = JSON.parse(decryptLark(outer.encrypt, encryptKey));
    } catch (error) {
      return { payload: null, error: `解密失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // URL 验证：token 必须与后台配置一致（配置为空时不放行，避免误开）
  if (outer.type === "url_verification") {
    if (!verificationToken || outer.token !== verificationToken) {
      return { payload: null, error: "url_verification token 不匹配" };
    }
    return { payload: outer, error: null };
  }

  return { payload: outer, error: null };
}

/**
 * 企业微信回调加解密（微信客服场景）。
 *
 * 协议要点：
 * - EncodingAESKey 为 43 位 base64，补一个 "=" 后解出 32 字节密钥；IV 取密钥前 16 字节。
 * - 明文结构：random(16) + msg_len(4, 网络序) + msg + receiveid。
 * - 填充用 PKCS#7，块长 32（企微官方示例如此，不是 AES 默认的 16）。
 * - 签名：sha1([token, timestamp, nonce, data].sort().join(""))。
 */
import crypto from "node:crypto";

const BLOCK_SIZE = 32;

export function decodeAesKey(encodingAesKey) {
  if (typeof encodingAesKey !== "string" || encodingAesKey.length !== 43) {
    throw new Error("EncodingAESKey 必须是 43 位字符");
  }
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("EncodingAESKey 解析失败：密钥长度不是 32 字节");
  return key;
}

export function signature(token, timestamp, nonce, data) {
  return crypto
    .createHash("sha1")
    .update([token, timestamp, nonce, data].sort().join(""))
    .digest("hex");
}

function pad(buf) {
  let padLen = BLOCK_SIZE - (buf.length % BLOCK_SIZE);
  if (padLen === 0) padLen = BLOCK_SIZE;
  return Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
}

function unpad(buf) {
  const padLen = buf[buf.length - 1];
  if (padLen < 1 || padLen > BLOCK_SIZE) return buf;
  return buf.subarray(0, buf.length - padLen);
}

/** 解密回调中的 Encrypt / echostr，返回明文与 receiveid（用于校验 corpid）。 */
export function decrypt(encrypted, encodingAesKey) {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const raw = unpad(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]));

  if (raw.length < 20) throw new Error("解密结果长度异常");
  const msgLen = raw.readUInt32BE(16);
  if (msgLen < 0 || 20 + msgLen > raw.length) throw new Error("解密结果长度字段异常");
  return {
    message: raw.subarray(20, 20 + msgLen).toString("utf8"),
    receiveId: raw.subarray(20 + msgLen).toString("utf8"),
  };
}

/** 加密：用于本地测试构造回调包（企微侧用它加 echostr 与消息体）。 */
export function encrypt(message, encodingAesKey, receiveId) {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(message, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const raw = pad(Buffer.concat([random, lenBuf, msgBuf, Buffer.from(receiveId, "utf8")]));
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(raw), cipher.final()]).toString("base64");
}

/** 极简 XML 解析：只取顶层标签，支持 CDATA。企微回调字段固定，无需完整解析器。 */
export function parseXml(xml) {
  const result = {};
  const re = /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const tag = match[1];
    const value = match[2] ?? match[3] ?? "";
    // 外层 <xml> 是包裹标签，直接递归解析它的内容，否则会把 Encrypt 一起吞掉
    if (tag === "xml") {
      Object.assign(result, parseXml(value));
      continue;
    }
    result[tag] = value;
  }
  return result;
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

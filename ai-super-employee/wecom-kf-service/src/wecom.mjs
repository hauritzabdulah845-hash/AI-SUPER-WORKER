/**
 * 企业微信 API 客户端：access_token 缓存、sync_msg 拉取、send_msg 发送。
 * MOCK 模式下不真正发消息，只记录到 sent 数组，供本地测试断言。
 */
const API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

export class WecomClient {
  constructor(config) {
    this.config = config;
    this.tokenCache = new Map();
    /** mock 模式下记录所有待发送的报文 */
    this.sent = [];
  }

  get mock() {
    return this.config.mock === true;
  }

  /** 获取 access_token；按 secret 缓存，提前 5 分钟过期，避免被限频。 */
  async accessToken() {
    const secret = this.config.kfSecret;
    const cached = this.tokenCache.get(secret);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) return cached.token;

    const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(secret)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`获取 access_token 失败：${data.errcode} ${data.errmsg}`);
    this.tokenCache.set(secret, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  }

  /**
   * 拉取微信客服消息。
   * 注意：回调只给通知，正文必须靠这个接口取；token 有效期 6 分钟，cursor 需持久化。
   */
  async syncMsg({ kfToken, openKfid, cursor = "" }) {
    if (this.mock) {
      return {
        next_cursor: "mock-next-cursor",
        has_more: 0,
        msg_list: this.config.mockMessages ?? [],
      };
    }
    const token = await this.accessToken();
    const res = await fetch(`${API_BASE}/kf/sync_msg?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: kfToken, open_kfid: openKfid, cursor, limit: 1000 }),
    });
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`sync_msg 失败：${data.errcode} ${data.errmsg}`);
    return data;
  }

  async sendText({ externalUserId, openKfid, content }) {
    return this.send({ externalUserId, openKfid, msgtype: "text", text: { content } });
  }

  async sendMiniProgram({ externalUserId, openKfid, appid, title, pagepath, thumbMediaId }) {
    const miniprogram = { appid, title, pagepath };
    // 部分企业号要求小程序消息带封面图 media_id；配了就带上，没配由企微侧决定是否报错
    if (thumbMediaId) miniprogram.thumb_media_id = thumbMediaId;
    return this.send({ externalUserId, openKfid, msgtype: "miniprogram", miniprogram });
  }

  async send({ externalUserId, openKfid, ...payload }) {
    const body = { touser: externalUserId, open_kfid: openKfid, ...payload };
    if (this.mock) {
      this.sent.push({ at: Date.now(), ...body });
      return { errcode: 0, msgid: `mock-${this.sent.length}` };
    }
    const token = await this.accessToken();
    const res = await fetch(`${API_BASE}/kf/send_msg?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`send_msg 失败：${data.errcode} ${data.errmsg}`);
    return data;
  }

  /** 客户联系（externalcontact）作用域的 token：与客服 kfSecret 是两个凭据。 */
  async contactAccessToken() {
    const secret = this.config.contactSecret;
    if (!secret) throw new Error("未配置 contactSecret（企微客户联系 secret），无法真实群发");
    const cacheKey = `contact:${secret}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) return cached.token;

    const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(secret)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`获取客户联系 token 失败：${data.errcode} ${data.errmsg}`);
    this.tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  }

  /**
   * 客户群发（官方「主动激活」通道）：externalcontact/add_msg_template。
   * sender 必须是有客户联系权限的企业成员 userid；MOCK 模式只记录。
   */
  async sendBroadcastMsg({ externalUserId, content, sender }) {
    const body = { external_userid: [externalUserId], text: { content }, sender };
    if (this.mock) {
      this.sent.push({ at: Date.now(), kind: "broadcast", ...body });
      return { errcode: 0, msgid: `mock-bc-${this.sent.length}` };
    }
    if (!sender) throw new Error("未配置 broadcastSender（发送成员 userid），无法真实群发");
    const token = await this.contactAccessToken();
    const res = await fetch(`${API_BASE}/externalcontact/add_msg_template?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`add_msg_template 失败：${data.errcode} ${data.errmsg}`);
    return data;
  }
}

/**
 * 群发（主动激活）：把前端解析好的受众与内容真正发出去。
 *
 * - 受众在控制台按线索阶段/意向筛选（leads 在业务库，服务端不感知）；
 * - MOCK 模式只记录不发送（client.sent），返回 demo 结果供前端展示；
 * - 真实发送走企微官方「客户群发」externalcontact/add_msg_template，
 *   需要 contactSecret（客户联系 secret）+ broadcastSender（发送成员），
 *   按约定由用户后续接入配置；缺配置时逐条返回 failed 与明确原因。
 *
 * 合规边界：只发给已同步 external_userid 的自有客户，不做个人微信 RPA 群发。
 */

/** 逐条发送；单条失败不影响其余，结果汇总给前端落历史。 */
export async function sendBroadcast({ client, config, recipients, content, logger = console }) {
  const text = String(content ?? "").trim();
  if (!text) throw new Error("群发内容不能为空");
  if (!Array.isArray(recipients) || !recipients.length) throw new Error("受众为空");

  const results = [];
  for (const recipient of recipients) {
    const name = String(recipient?.name ?? "未命名").slice(0, 40);
    const externalUserId = String(recipient?.external_userid ?? "").trim();
    if (!externalUserId) {
      results.push({ name, status: "skipped", detail: "无企微客户ID（未同步或手动线索）" });
      continue;
    }
    try {
      await client.sendBroadcastMsg({
        externalUserId,
        content: text,
        sender: config.broadcastSender ?? "",
      });
      results.push({ name, status: client.mock ? "demo" : "sent", detail: "" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, status: "failed", detail });
      logger.warn(`群发失败（${name}）：${detail}`);
    }
  }

  const summary = {
    total: results.length,
    sent: results.filter((item) => item.status === "sent").length,
    demo: results.filter((item) => item.status === "demo").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
  };
  return { results, summary };
}

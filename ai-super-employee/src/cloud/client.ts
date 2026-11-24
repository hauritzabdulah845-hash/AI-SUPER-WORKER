import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

/**
 * 云服务公开配置。
 * 来源：WorkBuddy 云服务环境开通时返回的 publicConfig。
 * 这里只包含可下发到前端的应用级公开值（发布密钥 / 数据面地址 / OAuth 中继地址），
 * 不包含任何服务端凭据。
 */
export const publicConfig = {
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
};

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
});

export type DataMode = "private" | "demo";

export interface SessionUser {
  id: string;
  name: string;
}

/** 会话缓存：避免每次数据请求都多打一次 auth 接口。只做加速，权限仍由服务端 RLS 决定。 */
let sessionCache: { user: SessionUser | null; at: number } | null = null;
const SESSION_TTL = 8000;

export async function getSessionUser(force = false): Promise<SessionUser | null> {
  if (!force && sessionCache && Date.now() - sessionCache.at < SESSION_TTL) return sessionCache.user;
  const { data, error } = await cloud.auth.getSession();
  const user =
    error || !data?.user
      ? null
      : {
          id: String(data.user.id ?? ""),
          name: data.user.name ?? "已登录用户",
        };
  sessionCache = { user, at: Date.now() };
  return user;
}

export function clearSessionCache() {
  sessionCache = null;
}

/**
 * 取当前数据归属者。
 * 多租户隔离的第一道闸：拿不到登录身份就拒绝读写，避免匿名请求落到别人的数据上。
 */
export async function requireOwner(): Promise<{ id: string; name: string }> {
  const user = await getSessionUser();
  if (!user?.id) {
    throw new Error("请先登录后再访问工作区数据（未登录状态不读写任何企业数据）。");
  }
  return { id: user.id, name: user.name };
}

export async function signOut() {
  sessionCache = null;
  await cloud.auth.signOut();
}

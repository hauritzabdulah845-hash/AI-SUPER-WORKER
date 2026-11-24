import { useState } from "react";
import { KeyRound, LoaderCircle, MessageSquareText, ShieldCheck, Sparkles } from "lucide-react";
import { cloud } from "../cloud/client";

interface LoginPanelProps {
  onSignedIn: () => void;
  reason?: string;
}

type Channel = "phone" | "workbuddy";

export default function LoginPanel({ onSignedIn, reason }: LoginPanelProps) {
  const [channel, setChannel] = useState<Channel>("phone");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [otp, setOtp] = useState<{ phone: string; verificationId: string; isExistingUser: boolean } | null>(null);

  const sendCode = async () => {
    setError("");
    setNotice("");
    if (!/^1\d{10}$/.test(phone)) {
      setPhoneError("请输入正确的 11 位手机号");
      return;
    }
    setPhoneError("");
    setSending(true);
    const { data, error: sendError } = await cloud.auth.sendOtp({ phone });
    setSending(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }
    setOtp({ phone, verificationId: data.verificationId, isExistingUser: data.isExistingUser });
    setNotice("验证码已发送，请填写后完成登录。");
  };

  const submitCode = async () => {
    setError("");
    if (!otp) {
      setError("请先获取验证码");
      return;
    }
    setPending(true);
    const { error: verifyError } = await cloud.auth.verifyOtp({
      phone: otp.phone,
      verificationId: otp.verificationId,
      isExistingUser: otp.isExistingUser,
      token: code.trim(),
    });
    setPending(false);
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    onSignedIn();
  };

  const signInWithWorkBuddy = async () => {
    setError("");
    setPending(true);
    const back = new URL(window.location.href);
    back.pathname = "/";
    for (const key of ["code", "state", "provider"]) back.searchParams.delete(key);
    const { data, error: oauthError } = await cloud.auth.signInWithOAuth({
      provider: "workbuddy",
      redirectTo: back.toString(),
    });
    setPending(false);
    if (oauthError) {
      setError(oauthError.message);
      return;
    }
    window.location.assign(data.url);
  };

  return (
    <div className="login-panel">
      <div className="login-card">
        <span className="login-mark"><Sparkles size={22} /></span>
        <h2>登录你的 AI 员工工作区</h2>
        <p>{reason ?? "登录后即可创建真实任务、私有智能体与客户资产，数据仅保存在你自己的云端空间。"}</p>

        <div className="login-tabs" role="tablist" aria-label="登录方式">
          <button type="button" role="tab" aria-selected={channel === "phone"} className={channel === "phone" ? "active" : ""} onClick={() => { setChannel("phone"); setError(""); }}><MessageSquareText size={15} />手机号登录</button>
          <button type="button" role="tab" aria-selected={channel === "workbuddy"} className={channel === "workbuddy" ? "active" : ""} onClick={() => { setChannel("workbuddy"); setError(""); }}><KeyRound size={15} />WorkBuddy 账号</button>
        </div>

        {channel === "phone" ? (
          <div className="login-form">
            <label htmlFor="login-phone">手机号</label>
            <input id="login-phone" inputMode="numeric" maxLength={11} placeholder="请输入 11 位手机号" value={phone} onChange={(event) => { setPhone(event.target.value); setPhoneError(""); }} />
            {phoneError && <span className="login-field-error">{phoneError}</span>}

            <label htmlFor="login-code">验证码</label>
            <div className="login-code-row">
              <input id="login-code" inputMode="numeric" maxLength={6} placeholder="6 位验证码" value={code} onChange={(event) => setCode(event.target.value)} />
              <button type="button" onClick={sendCode} disabled={sending}>{sending ? "发送中" : "获取验证码"}</button>
            </div>
            {notice && <span className="login-notice">{notice}</span>}

            <button type="button" className="button button-primary login-submit" onClick={submitCode} disabled={pending}>
              {pending ? <><LoaderCircle size={16} className="spin" />正在登录</> : "登录并进入工作区"}
            </button>
          </div>
        ) : (
          <div className="login-form">
            <button type="button" className="button button-primary login-submit" onClick={signInWithWorkBuddy} disabled={pending}>
              {pending ? <><LoaderCircle size={16} className="spin" />跳转中</> : "使用 WorkBuddy 登录"}
            </button>
            <span className="login-hint">使用 WorkBuddy 账号授权登录，需在已发布域名下完成授权。</span>
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        <div className="login-security"><ShieldCheck size={15} />登录凭证由 WorkBuddy 云服务托管，平台不存储你的密码。</div>
      </div>
    </div>
  );
}

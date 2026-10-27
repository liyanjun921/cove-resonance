import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kmligdmvjenjjlvrpqha.supabase.co",
  "sb_publishable_8UA5IAna561eaG3zy1PYkA_oA91TTbp",
  { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } },
);
const authorizationId = new URLSearchParams(location.search).get("authorization_id");
const view = document.querySelector<HTMLElement>("#view")!;
const message = document.querySelector<HTMLElement>("#message")!;
const email = document.querySelector<HTMLInputElement>("#email")!;
const otp = document.querySelector<HTMLInputElement>("#otp")!;
const signIn = document.querySelector<HTMLButtonElement>("#sign-in")!;
const verify = document.querySelector<HTMLButtonElement>("#verify")!;

function say(value: string) { message.textContent = value; }

async function showConsent() {
  if (!authorizationId || !/^[\w-]{8,200}$/.test(authorizationId)) {
    say("缺少有效的授权请求，请从 Work 连接页重新开始。"); return;
  }
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) { view.hidden = false; say("输入你的邮箱，接收一次性验证码。再次连接时通常无需重复验证。"); return; }
  const owner = await fetch("/oauth/owner", { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (!owner.ok) { say("此账号尚未绑定到事件桥，请联系配置者完成绑定。"); return; }
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) { say(error?.message || "授权请求已失效，请重新连接。"); return; }
  if (!("authorization_id" in data)) { location.assign(data.redirect_url); return; }
  view.hidden = true;
  const details = document.querySelector<HTMLElement>("#details")!;
  details.hidden = false;
  document.querySelector<HTMLElement>("#client")!.textContent = data.client.name;
  document.querySelector<HTMLElement>("#destination")!.textContent = data.redirect_uri;
  document.querySelector<HTMLElement>("#scopes")!.textContent = data.scope || "事件订阅";
  document.querySelector<HTMLElement>("#account")!.textContent = session.user.email || "当前账号";
  say("确认后，Work 可接收外部消息和每 15 分钟的唤醒信号。你可以随时断开连接。");
}

signIn.addEventListener("click", async () => {
  const address = email.value.trim();
  if (!address) { say("请输入邮箱。"); return; }
  signIn.disabled = true;
  const { error } = await supabase.auth.signInWithOtp({ email: address, options: { shouldCreateUser: true } });
  signIn.disabled = false;
  if (error) { say(error.message); return; }
  otp.hidden = false; verify.hidden = false;
  say("验证码已发送到你的邮箱。请在此页输入，不要发到聊天里。");
});

verify.addEventListener("click", async () => {
  verify.disabled = true;
  const { error } = await supabase.auth.verifyOtp({ email: email.value.trim(), token: otp.value.trim(), type: "email" });
  verify.disabled = false;
  if (error) { say(error.message); return; }
  await showConsent();
});

for (const decision of ["approve", "deny"] as const) {
  document.querySelector<HTMLButtonElement>(`#${decision}`)!.addEventListener("click", async () => {
    if (!authorizationId) return;
    const { data, error } = decision === "approve"
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId);
    if (error || !data) { say(error?.message || "授权失败，请重试。"); return; }
    location.assign(data.redirect_url);
  });
}
void showConsent();

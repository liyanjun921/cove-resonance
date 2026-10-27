import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kmligdmvjenjjlvrpqha.supabase.co",
  "sb_publishable_8UA5IAna561eaG3zy1PYkA_oA91TTbp",
  { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } },
);
const authorizationId = new URLSearchParams(location.search).get("authorization_id");
const view = document.querySelector<HTMLElement>("#view")!;
const message = document.querySelector<HTMLElement>("#message")!;
const email = document.querySelector<HTMLInputElement>("#email")!;
const signIn = document.querySelector<HTMLButtonElement>("#sign-in")!;

function say(value: string) { message.textContent = value; }

async function showConsent() {
  if (!authorizationId || !/^[\w-]{8,200}$/.test(authorizationId)) {
    say("缺少有效的授权请求，请从 Work 连接页重新开始。"); return;
  }
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) { view.hidden = false; say("输入绑定邮箱，接收一次性登录链接。连接后通常无需重复验证。"); return; }
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
  const redirect = new URL("/oauth/consent", location.origin);
  redirect.searchParams.set("authorization_id", authorizationId!);
  const { error } = await supabase.auth.signInWithOtp({ email: address, options: {
    shouldCreateUser: true, emailRedirectTo: redirect.toString(),
  } });
  signIn.disabled = false;
  if (error) { say(error.message); return; }
  say("登录链接已发送。请在同一浏览器中打开邮件里的链接，回到此页后再确认连接。不要把链接发到聊天里。");
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

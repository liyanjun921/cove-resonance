"use strict";
const $ = id => document.getElementById(id);
let activePreview = null;

function message(txt) { $("status").textContent = txt; }
function showPanel(visible) {
  $("panel").classList.toggle("hidden", !visible);
  $("login").classList.toggle("hidden", visible);
}

async function callApi(path, method="GET", body=null, moreHeaders={}) {
  const headers = Object.assign({}, moreHeaders);
  if (method === "POST") headers["X-Snapshot-Action"] = "1";
  if (body && !(body instanceof Blob)) headers["Content-Type"] = "application/json";
  if (body && !(body instanceof Blob)) body = JSON.stringify(body);
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store", headers, body
  });
  const result = await response.json().catch(() => ({error:"response_unreadable"}));
  if (!response.ok) {
    if (response.status === 401) showPanel(false);
    throw new Error(result.error || result.status || "request_failed");
  }
  return result;
}

$("loginButton").addEventListener("click", async () => {
  const password = $("password").value;
  if (!password) return message("请输入私人密码。");
  $("loginButton").disabled = true;
  try {
    await callApi("/api/login", "POST", {secret: password});
    $("password").value = "";
    showPanel(true);
    message("已登录。这是一份手动授权申请箱，不是自动截屏工具。");
    await refresh();
  } catch(e) { message("无法登录：" + e.message); }
  finally { $("loginButton").disabled = false; }
});

async function toJpeg(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 20 * 1024 * 1024) throw new Error("图片太大，请先压缩");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const ratio = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(ok => canvas.toBlob(ok,"image/jpeg",0.79));
    if (!blob || blob.size > 5 * 1024 * 1024) throw new Error("图片转换失败或仍太大");
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

function button(label, cls, callback) {
  const el = document.createElement("button");
  el.textContent = label;
  if(cls) el.className=cls;
  el.addEventListener("click", callback);
  return el;
}

function requestNode(item) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "padding:12px 0;border-top:1px solid #dce6f0";
  const reason = document.createElement("div");
  reason.className = "reason";
  reason.textContent = item.reason;
  const subtitle = document.createElement("p");
  subtitle.textContent = "申请校验码：" + (item.approval_code || "旧版申请") + " · 有效期约 " + Math.max(0,Math.ceil(item.expires_in_seconds / 60)) + " 分钟。请与你的聊天窗口核对后再批准。";
  const file = document.createElement("input");
  file.type="file";
  file.accept="image/*";
  file.setAttribute("aria-label","选择你愿意分享的截图");
  const preview = document.createElement("img");
  preview.alt="仅本地预览，尚未上传";
  preview.style.cssText="display:none;width:100%;max-height:45vh;object-fit:contain;border-radius:15px;margin:9px 0";
  const actions = document.createElement("div");
  actions.className="controls";
  const approve = button("确认发送这一张", "primary", async () => {
    if (!activePreview || activePreview.id !== item.id) return message("请先选择并预览截图。");
    approve.disabled=true;
    deny.disabled=true;
    try {
      const ticket = await callApi("/api/requests/" + encodeURIComponent(item.id) + "/prepare","POST");
      await callApi("/api/requests/" + encodeURIComponent(item.id) + "/upload","POST",
        activePreview.blob, {"Content-Type":"image/jpeg","X-Upload-Ticket":ticket.upload_ticket});
      message("已按你的确认上传。GPT 最多可读取一次，之后服务器会立即删除。");
      activePreview=null;
      await refresh();
    } catch(e){ message("上传失败：" + e.message); }
    finally { approve.disabled=false;deny.disabled=false; }
  });
  approve.disabled=true;
  const deny = button("拒绝这次申请", "danger", async () => {
    deny.disabled=true;
    try {
      await callApi("/api/requests/" + encodeURIComponent(item.id) + "/deny","POST");
      if(activePreview && activePreview.id === item.id)activePreview=null;
      message("已拒绝，图片没有上传。");
      await refresh();
    } catch(e){ message("拒绝失败：" + e.message); }
    finally { deny.disabled=false; }
  });
  file.addEventListener("change", async () => {
    approve.disabled=true;
    preview.style.display="none";
    if(preview.src){URL.revokeObjectURL(preview.src);preview.removeAttribute("src");}
    try {
      const imageBlob = await toJpeg(file.files && file.files[0]);
      activePreview = {id:item.id,blob:imageBlob};
      preview.src=URL.createObjectURL(imageBlob);
      preview.style.display="block";
      approve.disabled=false;
      message("这只是本地预览。只有点击「确认发送这一张」，图片才会上传。");
    } catch(e){message("预览失败：" + e.message);}
  });
  actions.append(approve,deny);
  wrap.append(reason,subtitle,file,preview,actions);
  return wrap;
}

async function refresh(){
  try {
    const result=await callApi("/api/requests");
    const list = result.requests || [];
    $("count").textContent=String(list.length);
    $("empty").style.display=list.length ? "none" : "block";
    const area=$("requests");
    area.replaceChildren(...list.map(requestNode));
  }catch(e){if(e.message !== "login_required")message("暂时无法刷新：" + e.message);}
}
$("refresh").addEventListener("click",refresh);

function publicKeyToBytes(base64url){
  const safe=base64url.replace(/-/g,"+").replace(/_/g,"/");
  const decoded=atob(safe+"=".repeat((4-safe.length%4)%4));
  return Uint8Array.from(decoded,chr=>chr.charCodeAt(0));
}
$("notify").addEventListener("click", async () => {
  try{
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      throw new Error("当前浏览器不支持。请在 iPhone Safari 添加到主屏幕后打开。");
    if(!("Notification" in window))throw new Error("无法访问通知权限。请从 iPhone 主屏幕启动 PWA。");
    const config=await callApi("/api/vapid");
    if(!config.publicKey)throw new Error("服务端尚未配置 Web Push VAPID 密钥。");
    const registration=await navigator.serviceWorker.register("/sw.js",{scope:"/"});
    await navigator.serviceWorker.ready;
    const allowed=await Notification.requestPermission();
    if(allowed !== "granted")throw new Error("通知权限未获允许。");
    const subscription=await registration.pushManager.subscribe({
      userVisibleOnly:true,applicationServerKey:publicKeyToBytes(config.publicKey)
    });
    await callApi("/api/subscribe","POST",subscription.toJSON());
    $("pushState").textContent="已订阅请求提醒（服务重启后可能需重新订阅）。";
    message("提醒已启用。只有出现新的申请时才会推送，不包含申请理由。");
  }catch(e){message("无法启用提醒：" + e.message);}
});
refresh().then(() => {
  if(!$("login").classList.contains("hidden"))return;
  showPanel(true);
}).catch(() => {});
// Refresh only while app is visible. No automatic screen access.
setInterval(() => { if(document.visibilityState === "visible" &&
    !$("panel").classList.contains("hidden"))refresh(); },30000);

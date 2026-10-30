// This narrow database proxy keeps Supabase's service role key inside its
// managed Edge runtime. The caller holds a separate random bridge token.
const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function validOperation(path: unknown, method: unknown): path is string {
  if (typeof path !== "string" || typeof method !== "string" || path.length > 700) return false;
  const parsed = new URL(path, "https://internal.invalid/");
  if (parsed.origin !== "https://internal.invalid" || parsed.pathname.includes("..")) return false;
  if (path.startsWith("work_event_subscriptions?")) return ["GET", "POST", "DELETE"].includes(method);
  if (path.startsWith("work_event_deliveries?")) return ["POST", "PATCH"].includes(method);
  return path === "rpc/claim_work_event_deliveries" && method === "POST";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return respond(405, { error: "method_not_allowed" });
  const bearer = req.headers.get("authorization") ?? "";
  if (!bearer.startsWith("Bearer ") || bearer.length > 200) return respond(401, { error: "unauthorized" });
  const bytes = new TextEncoder().encode(bearer.slice(7));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const auth = await fetch(`${url}/rest/v1/work_event_bridge_auth?digest=eq.${digest}&select=digest&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!auth.ok || (await auth.json()).length !== 1) return respond(401, { error: "unauthorized" });

  let input: { path?: unknown; method?: unknown; body?: unknown; prefer?: unknown };
  try { input = await req.json(); } catch { return respond(400, { error: "invalid_json" }); }
  if (!validOperation(input.path, input.method)) return respond(400, { error: "invalid_operation" });
  const response = await fetch(`${url}/rest/v1/${input.path}`, {
    method: input.method as string,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json",
      ...(typeof input.prefer === "string" ? { Prefer: input.prefer } : {}),
    },
    ...(input.method === "GET" || input.method === "DELETE" ? {} : { body: JSON.stringify(input.body ?? {}) }),
  });
  const responseBody = response.status === 204 || response.status === 205 || response.status === 304
    ? null : await response.text();
  return new Response(responseBody, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
});

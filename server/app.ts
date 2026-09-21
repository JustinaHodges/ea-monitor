import { verifyTerminalSignature } from "../src/auth.ts";
import { handleAdminApi, parseJsonBody } from "../src/api.ts";
import { buildHeartbeatTradeFlags } from "../src/backfillFlags.ts";
import { ingestHeartbeat, ingestLog, ingestTrade } from "../src/ingest.ts";
import { checkLicense } from "../src/license.ts";
import type { Env, HeartbeatPayload, LogPayload, TradePayload } from "../src/types.ts";
import { json } from "../src/types.ts";
import { handleBackupApi } from "./backup.js";
import { handleBgUpload } from "./bgUpload.js";
import { serveStatic } from "./static.js";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: cors() });
  }

  try {
    const backupRes = await handleBackupApi(request, env);
    if (backupRes) return withCors(backupRes);

    if (url.pathname === "/api/v1/bg-upload" && request.method === "POST") {
      const lic = await checkLicense(env, request);
      if (lic.enforce && !lic.ok) {
        return withCors(json({ error: lic.reason || "未授权", license: lic }, 402));
      }
      return withCors(await handleBgUpload(request, env));
    }
    const ingestPath =
      url.pathname === "/api/v1/heartbeat" ||
      url.pathname === "/api/v1/trades" ||
      url.pathname === "/api/v1/logs";
    if (ingestPath && request.method === "POST") {
      const lic = await checkLicense(env, request);
      if (lic.enforce && !lic.ok) {
        return withCors(json({ error: lic.reason || "未授权", license: lic }, 402));
      }
      return withCors(await handleIngest(request, env));
    }
    if (url.pathname.startsWith("/api/")) {
      return withCors(await handleAdminApi(request, env));
    }
    // 分享短链 /s/xxxx → share.html
    if (url.pathname === "/s" || url.pathname.startsWith("/s/")) {
      const shareUrl = new URL(url.toString());
      shareUrl.pathname = "/share.html";
      const res = await serveStatic(shareUrl);
      return res ?? new Response("Not Found", { status: 404 });
    }
    const staticRes = await serveStatic(url);
    return staticRes ?? new Response("Not Found", { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return withCors(json({ error: message }, 500));
  }
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const terminalId = request.headers.get("X-EA-Id") || "";
  if (!terminalId) return json({ error: "missing X-EA-Id" }, 401);

  const row = await env.DB.prepare(`SELECT api_secret FROM terminals WHERE terminal_id = ?`)
    .bind(terminalId)
    .first<{ api_secret: string }>();
  if (!row?.api_secret) return json({ error: "unknown terminal" }, 401);

  const raw = await request.arrayBuffer();
  if (raw.byteLength > 256 * 1024) return json({ error: "payload too large" }, 413);

  const verified = await verifyTerminalSignature(request, raw, row.api_secret);
  if (!verified.ok) return json({ error: verified.error }, 401);

  const path = new URL(request.url).pathname;
  if (path === "/api/v1/heartbeat") {
    const prev = await env.DB.prepare(`SELECT last_seen FROM terminals WHERE terminal_id = ?`)
      .bind(terminalId)
      .first<{ last_seen: number | null }>();
    const lastSeenBefore = Number(prev?.last_seen || 0);

    const payload = await parseJsonBody<HeartbeatPayload>(raw);
    await ingestHeartbeat(env, terminalId, payload);

    const flags = await buildHeartbeatTradeFlags(env, terminalId, payload, lastSeenBefore);
    return json({
      ok: true,
      ...flags,
    });
  }
  if (path === "/api/v1/trades") {
    const payload = await parseJsonBody<TradePayload | { trades?: TradePayload[] }>(raw);
    const list = Array.isArray((payload as { trades?: TradePayload[] }).trades)
      ? (payload as { trades: TradePayload[] }).trades.slice(0, 40)
      : [payload as TradePayload];
    for (const t of list) await ingestTrade(env, terminalId, t);
    return json({ ok: true, n: list.length });
  }
  if (path === "/api/v1/logs") {
    const payload = await parseJsonBody<LogPayload>(raw);
    await ingestLog(env, terminalId, payload);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

function cors(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-EA-Id, X-EA-Timestamp, X-EA-Signature",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getAdminSessionId } from "../src/auth.ts";
import { validateAdminSession } from "../src/adminPass.ts";
import type { Env } from "../src/types.ts";
import { json } from "../src/types.ts";
import { SqliteDatabase } from "./db.js";

const KEEP_COUNT = Math.max(3, Number(process.env.BACKUP_KEEP || 14) || 14);

export function resolveDataDir(): string {
  return path.resolve(process.env.DATA_DIR || "./data");
}

export function resolveBackupsDir(): string {
  return path.join(resolveDataDir(), "backups");
}

function asSqlite(env: Env): SqliteDatabase {
  return env.DB as unknown as SqliteDatabase;
}

function safeName(name: string): string | null {
  const base = path.basename(String(name || ""));
  if (!/^ea-monitor-[\w.-]+\.db$/i.test(base)) return null;
  return base;
}

export async function createSqliteBackup(
  env: Env,
  label = "manual",
): Promise<{ file: string; size: number; mtime: number }> {
  const dir = resolveBackupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeLabel = String(label || "manual").replace(/[^\w.-]+/g, "_").slice(0, 32) || "manual";
  const file = `ea-monitor-${stamp}-${safeLabel}.db`;
  const dest = path.join(dir, file);
  await asSqlite(env).backupTo(dest);
  pruneOldBackups();
  const st = fs.statSync(dest);
  return { file, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
}

export function listSqliteBackups(): Array<{ file: string; size: number; mtime: number }> {
  const dir = resolveBackupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((file) => {
      const st = fs.statSync(path.join(dir, file));
      return { file, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function pruneOldBackups(keep = KEEP_COUNT): void {
  const rows = listSqliteBackups();
  for (const row of rows.slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(path.join(resolveBackupsDir(), row.file));
    } catch {
      /* ignore */
    }
  }
}

function fileResponse(filePath: string, downloadName: string): Response {
  const st = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  const webStream = Readable.toWeb(stream) as ReadableStream;
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(st.size),
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!(await validateAdminSession(env, getAdminSessionId(request)))) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

/** Node-only admin backup routes. Returns null if path not handled. */
export async function handleBackupApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathName = url.pathname;

  if (pathName === "/api/v1/admin/backups" && request.method === "GET") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    return json({
      keep: KEEP_COUNT,
      rows: listSqliteBackups(),
      hint: "??????????????????????I server/data/ea-monitor.db???????? -wal/-shm????????????",
    });
  }

  if (pathName === "/api/v1/admin/backup" && request.method === "POST") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as { label?: string };
    const row = await createSqliteBackup(env, body.label || "manual");
    return json({ ok: true, ...row });
  }

  if (pathName === "/api/v1/admin/backup/download" && request.method === "GET") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const want = safeName(url.searchParams.get("file") || "");
    if (want) {
      const full = path.join(resolveBackupsDir(), want);
      if (!fs.existsSync(full)) return json({ error: "backup not found" }, 404);
      return fileResponse(full, want);
    }
    // fresh consistent snapshot for immediate download
    const row = await createSqliteBackup(env, "download");
    return fileResponse(path.join(resolveBackupsDir(), row.file), row.file);
  }

  if (pathName.startsWith("/api/v1/admin/backups/") && request.method === "DELETE") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const want = safeName(decodeURIComponent(pathName.slice("/api/v1/admin/backups/".length)));
    if (!want) return json({ error: "bad name" }, 400);
    const full = path.join(resolveBackupsDir(), want);
    if (!fs.existsSync(full)) return json({ error: "not found" }, 404);
    fs.unlinkSync(full);
    return json({ ok: true, file: want });
  }

  return null;
}

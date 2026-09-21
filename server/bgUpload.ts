import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateAdminSession } from "../src/adminPass.ts";
import { getAdminSessionId } from "../src/auth.ts";
import { getUiSettings, saveUiSettings, type UiSettings } from "../src/settings.ts";
import type { Env } from "../src/types.ts";
import { json } from "../src/types.ts";
import { publicDir } from "./paths.js";

const PUBLIC_DIR = publicDir();
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "bg");

const SLOTS = [
  "bg_day_desktop",
  "bg_day_mobile",
  "bg_night_desktop",
  "bg_night_mobile",
] as const;

type Slot = (typeof SLOTS)[number];

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

function isSlot(v: string): v is Slot {
  return (SLOTS as readonly string[]).includes(v);
}

function sniffExt(buf: Buffer, mime: string, filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp4")) return ".mp4";
  if (lower.endsWith(".webm")) return ".webm";
  if (lower.endsWith(".mov")) return ".mov";
  if (lower.endsWith(".png")) return ".png";
  if (lower.endsWith(".webp")) return ".webp";
  if (lower.endsWith(".gif")) return ".gif";
  if (lower.endsWith(".avif")) return ".avif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return ".jpg";
  if (buf.length >= 12 && buf.subarray(4, 8).toString() === "ftyp") return ".mp4";
  if (buf.length >= 4 && buf.subarray(0, 4).toString() === "\x1aE\xdf\xa3") return ".webm";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") {
    return ".webp";
  }
  return EXT_BY_MIME[mime.split(";")[0].trim().toLowerCase()] || ".jpg";
}

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

/** 用户上传高清原图 */
export async function handleBgUpload(request: Request, env: Env): Promise<Response> {
  if (!(await validateAdminSession(env, getAdminSessionId(request)))) {
    return json({ error: "unauthorized" }, 401);
  }
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "bad form" }, 400);
  const slot = String(form.get("slot") || "");
  if (!isSlot(slot)) return json({ error: "bad slot" }, 400);
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "missing file" }, 400);
  const blob = file as File;
  const buf = Buffer.from(await blob.arrayBuffer());
  if (buf.byteLength < 100) return json({ error: "file too small" }, 400);
  if (buf.byteLength > 150 * 1024 * 1024) return json({ error: "file too large (max 150MB)" }, 413);
  const mime = (blob.type || "").toLowerCase();
  if (mime && !mime.startsWith("image/") && !mime.startsWith("video/")) {
    return json({ error: "仅支持图片或 mp4/webm 视频" }, 400);
  }
  const ext = sniffExt(buf, mime, blob.name || "");
  await ensureUploadDir();
  // 清掉同 slot 旧文件（含历史带时间戳的名字）
  for (const old of await fs.readdir(UPLOAD_DIR).catch(() => [] as string[])) {
    if (old.startsWith(`${slot}.`) || old.startsWith(`${slot}-`)) {
      await fs.unlink(path.join(UPLOAD_DIR, old)).catch(() => undefined);
    }
  }
  // 文件名带时间戳，避免浏览器/CDN 继续用旧图缓存
  const stamp = Date.now();
  const name = `${slot}-${stamp}${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), buf);
  const localPath = `/uploads/bg/${name}`;
  const saved = await saveUiSettings(env, { [slot]: localPath } as Partial<UiSettings>);
  return json({ ...saved, uploaded: `${localPath}?v=${stamp}`, slot, bytes: buf.byteLength });
}

/**
 * 保存外链后：把链接内容下载到本站（绕过防盗链）。
 * 注意：哲风 previewFileImg / getCroppingImg 本身就是预览图，不是官网「下载原图」。
 */
export async function cacheRemoteBackgrounds(env: Env, settings: UiSettings): Promise<UiSettings> {
  await ensureUploadDir();
  const patch: Partial<UiSettings> = {};
  for (const slot of SLOTS) {
    const url = settings[slot];
    if (!url || url.startsWith("/uploads/bg/")) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      const local = await downloadToCache(slot, url);
      if (local) patch[slot] = local;
    } catch (err) {
      console.error("[bg-cache]", slot, err);
    }
  }
  if (!Object.keys(patch).length) return settings;
  return saveUiSettings(env, patch);
}

async function downloadToCache(slot: Slot, url: string): Promise<string | null> {
  const upstream = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!upstream.ok) return null;
  const mime = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ab = await upstream.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.byteLength < 100 || buf.byteLength > 150 * 1024 * 1024) return null;
  if (mime && !mime.startsWith("image/") && !mime.startsWith("video/") && !looksLikeImage(buf) && !looksLikeVideo(buf)) return null;
  const ext = sniffExt(buf, mime, url);
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
  for (const old of await fs.readdir(UPLOAD_DIR).catch(() => [] as string[])) {
    if (old.startsWith(`${slot}.`) || old.startsWith(`${slot}-`)) {
      await fs.unlink(path.join(UPLOAD_DIR, old)).catch(() => undefined);
    }
  }
  const name = `${slot}-${hash}${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/bg/${name}`;
}

function looksLikeImage(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return true;
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === "RIFF") return true;
  return false;
}

function looksLikeVideo(buf: Buffer): boolean {
  if (buf.length >= 12 && buf.subarray(4, 8).toString() === "ftyp") return true;
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  return false;
}

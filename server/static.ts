import fs from "node:fs/promises";
import path from "node:path";
import { publicDir } from "./paths.js";

const PUBLIC_DIR = publicDir();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff2": "font/woff2",
};

function contentType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export async function serveStatic(url: URL): Promise<Response | null> {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  if (pathname === "/") pathname = "/index.html";

  const rel = pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return null;

  try {
    const data = await fs.readFile(filePath);
    const isUpload = pathname.startsWith("/uploads/");
    return new Response(data, {
      headers: {
        "Content-Type": contentType(filePath),
        // 上传背景用唯一文件名，可长期缓存；换图会换新 URL，不会卡旧图
        "Cache-Control": isUpload
          ? "public, max-age=31536000, immutable"
          : pathname.endsWith(".html")
            ? "no-cache"
            : "public, max-age=3600",
      },
    });
  } catch {
    return null;
  }
}

export const assetsFetcher: Fetcher = {
  fetch(request: Request): Promise<Response> {
    return serveStatic(new URL(request.url)).then((res) => res ?? new Response("Not Found", { status: 404 }));
  },
};

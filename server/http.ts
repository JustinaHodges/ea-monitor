import type { IncomingMessage, ServerResponse } from "node:http";

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      // 继续吞掉剩余数据，避免 nginx 看到 connection reset → 502
      req.resume();
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error("body too large") as Error & { statusCode?: number };
        err.statusCode = 413;
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

function maxBodyForUrl(urlPath: string): number {
  const pathOnly = urlPath.split("?")[0] || "/";
  if (pathOnly === "/api/v1/bg-upload") return 150 * 1024 * 1024;
  return 512 * 1024;
}

export async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host || "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
  const url = `${proto}://${host}${req.url || "/"}`;
  const method = req.method || "GET";

  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req, maxBodyForUrl(req.url || "/"));
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  return new Request(url, {
    method,
    headers,
    body: body?.length ? body : undefined,
    // @ts-expect-error Node Request supports duplex for streaming bodies
    duplex: body?.length ? "half" : undefined,
  });
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const chunk = Buffer.from(value);
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
    res.end();
  } catch (err) {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* ignore */
    }
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("download failed");
    } else {
      res.destroy(err instanceof Error ? err : undefined);
    }
  }
}

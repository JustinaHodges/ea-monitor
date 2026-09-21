/** 登录防爆破：按 IP + 账号滑动窗口限流（单机内存） */

type Bucket = { fails: number[]; lockedUntil: number };

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

function key(ip: string, username: string): string {
  return `${ip || "unknown"}|${String(username || "").trim().toLowerCase() || "-"}`;
}

function prune(b: Bucket, now: number): void {
  b.fails = b.fails.filter((t) => now - t < WINDOW_MS);
}

export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for") || "";
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

/** 登录前检查：是否仍在锁定期 */
export function assertLoginAllowed(ip: string, username: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const k = key(ip, username);
  const b = buckets.get(k);
  if (!b) return { ok: true };
  if (b.lockedUntil > now) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.lockedUntil - now) / 1000)) };
  }
  prune(b, now);
  if (b.fails.length >= MAX_FAILS) {
    b.lockedUntil = now + LOCK_MS;
    buckets.set(k, b);
    return { ok: false, retryAfter: Math.ceil(LOCK_MS / 1000) };
  }
  return { ok: true };
}

export function recordLoginFailure(ip: string, username: string): void {
  const now = Date.now();
  const k = key(ip, username);
  const b = buckets.get(k) || { fails: [], lockedUntil: 0 };
  prune(b, now);
  b.fails.push(now);
  if (b.fails.length >= MAX_FAILS) b.lockedUntil = now + LOCK_MS;
  buckets.set(k, b);
}

export function clearLoginFailures(ip: string, username: string): void {
  buckets.delete(key(ip, username));
}

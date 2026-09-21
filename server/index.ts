import "dotenv/config";
import http from "node:http";
import cron from "node-cron";
import { handleRequest } from "./app.js";
import { createSqliteBackup } from "./backup.js";
import { runOfflineCheck } from "../src/cron.ts";
import { createEnv } from "./env.js";
import { nodeToWebRequest, sendWebResponse } from "./http.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const env = createEnv();

const server = http.createServer(async (req, res) => {
  try {
    const request = await nodeToWebRequest(req);
    const response = await handleRequest(request, env);
    await sendWebResponse(res, response);
  } catch (err) {
    console.error("[http]", err);
    if (!res.headersSent) {
      const status =
        err && typeof err === "object" && "statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : err instanceof Error && err.message === "body too large"
            ? 413
            : 500;
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error:
            status === 413
              ? "file too large (max 150MB)"
              : err instanceof Error
                ? err.message
                : "internal error",
        }),
      );
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EA Monitor server listening on http://${HOST}:${PORT}`);
  console.log(`Static UI: ../public  |  SQLite: ${process.env.DATA_DIR || "./data"}/ea-monitor.db`);
  if (!env.ADMIN_TOKEN) console.warn("WARN: ADMIN_TOKEN is not set — admin login will fail.");
});

// 每 60 秒检查一次离线
const runCheck = () => runOfflineCheck(env).catch((err) => console.error("[cron]", err));
runCheck();
setInterval(runCheck, 60_000);
// 保留分钟级 cron 作为兜底（进程异常时也能看到调度痕迹）
cron.schedule("* * * * *", runCheck);

// 每天 03:10 自动备份 SQLite（保留份数见 BACKUP_KEEP，默认 14）
cron.schedule("10 3 * * *", () => {
  createSqliteBackup(env, "daily")
    .then((row) => console.log("[backup]", row.file, row.size))
    .catch((err) => console.error("[backup]", err));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

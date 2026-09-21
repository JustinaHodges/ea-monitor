import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 应用根目录（含 public/、schema.sql）
 * - 开发：server/*.ts → 上一级
 * - 客户包：server/dist/index.js → 上两级
 */
export function appRoot(importMetaUrl: string = import.meta.url): string {
  if (process.env.APP_ROOT) return path.resolve(process.env.APP_ROOT);
  const here = path.dirname(fileURLToPath(importMetaUrl));
  if (path.basename(here) === "dist") return path.resolve(here, "..", "..");
  return path.resolve(here, "..");
}

export function publicDir(importMetaUrl?: string): string {
  if (process.env.PUBLIC_DIR) return path.resolve(process.env.PUBLIC_DIR);
  return path.join(appRoot(importMetaUrl), "public");
}

export function schemaPath(importMetaUrl?: string): string {
  if (process.env.SCHEMA_PATH) return path.resolve(process.env.SCHEMA_PATH);
  return path.join(appRoot(importMetaUrl), "schema.sql");
}

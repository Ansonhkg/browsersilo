import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const uiRoot = resolve(process.cwd(), "dist", "ui");
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export async function serveAdminUi(
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const requested = pathname === "/" || pathname === "/control"
    ? "index.html"
    : pathname.replace(/^\//, "");
  const candidate = resolve(uiRoot, requested);
  const allowedPrefix = `${uiRoot}${sep}`;
  const assetPath = candidate.startsWith(allowedPrefix) ? candidate : "";
  let bytes: Buffer;
  let servedPath = assetPath;
  try {
    bytes = await readFile(assetPath);
  } catch {
    servedPath = resolve(uiRoot, "index.html");
    bytes = await readFile(servedPath);
  }
  const extension = extname(servedPath);
  response.writeHead(200, {
    "content-type": contentTypes[extension] ?? "application/octet-stream",
    "cache-control": servedPath.endsWith("index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
    "content-security-policy":
      "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(bytes);
}

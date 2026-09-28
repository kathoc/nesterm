import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(projectRoot, "dist");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const port = Number(option("--port", 4173));
const minutes = Number(option("--minutes", 20));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port は1〜65535の整数で指定してください");
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error("--minutes は0より大きい数（最大1440）で指定してください");

const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".txt", "text/plain; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const decoded = decodeURIComponent(url.pathname);
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const filename = path.resolve(root, relative);
    const allowed = filename === root || filename.startsWith(`${root}${path.sep}`);
    if (!allowed) throw Object.assign(new Error("Forbidden"), { code: "EACCES" });
    const info = await stat(filename);
    if (!info.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    response.writeHead(200, {
      "Content-Type": mime.get(path.extname(filename)) || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filename).pipe(response);
  } catch (error) {
    const forbidden = error.code === "EACCES";
    response.writeHead(forbidden ? 403 : 404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(forbidden ? "Forbidden\n" : "Not found\n");
  }
});

function stop(reason) {
  console.log(reason);
  server.close(() => process.exit(0));
}

server.listen(port, "127.0.0.1", () => {
  console.log(`NESTERM: http://127.0.0.1:${port}/`);
  console.log(`${minutes}分後に自動停止します`);
});

const timer = setTimeout(() => stop("時間上限に達したため停止します"), minutes * 60_000);
timer.unref();
process.once("SIGINT", () => stop("停止します"));
process.once("SIGTERM", () => stop("停止します"));

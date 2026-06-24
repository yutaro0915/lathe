import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const host = "127.0.0.1";
const root = resolve("storybook-static");
const basePort = Number(process.env.STORYBOOK_PORT ?? 6006);

const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

function fileForUrl(url) {
  const pathname = new URL(url ?? "/", `http://${host}`).pathname;
  const decoded = decodeURIComponent(pathname);
  const requested = normalize(join(root, decoded));
  if (relative(root, requested).startsWith("..")) {
    return null;
  }
  return requested;
}

function serveStatic(req, res) {
  void (async () => {
    let file = fileForUrl(req.url);
    if (!file) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let info;
    try {
      info = await stat(file);
      if (info.isDirectory()) {
        file = join(file, "index.html");
        info = await stat(file);
      }
    } catch {
      file = join(root, "index.html");
      info = await stat(file);
    }

    res.writeHead(200, {
      "content-length": info.size,
      "content-type": types.get(extname(file)) ?? "application/octet-stream",
    });
    createReadStream(file).pipe(res);
  })().catch((error) => {
    res.writeHead(500);
    res.end(String(error));
  });
}

function listen(port) {
  const server = createServer(serveStatic);
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolveListen(listen(port + 1));
        return;
      }
      rejectListen(error);
    });
    server.listen(port, host, () => resolveListen({ server, port }));
  });
}

function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  return new Promise((resolveRun) => {
    child.on("exit", (code, signal) => resolveRun({ code, signal }));
  });
}

const { server, port } = await listen(basePort);
const url = `http://${host}:${port}`;

try {
  const result = await run("pnpm", ["exec", "test-storybook", "--url", url, "--ci"]);
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
  }
} finally {
  server.close();
}

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const engine = require("./server-core");
const avatarInstaller = require("./avatar-package");
const avatarPublisher = require("./avatar-publisher");

const BASE_DIR = __dirname;
const STATIC_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/workspace.css": ["workspace.css", "text/css; charset=utf-8"],
  "/avatar.css": ["avatar.css", "text/css; charset=utf-8"],
  "/avatar.js": ["avatar.js", "text/javascript; charset=utf-8"],
  "/avatar-assets.js": ["avatar-assets.js", "text/javascript; charset=utf-8"],
  "/avatar-default.svg": ["avatar-default.svg", "image/svg+xml"],
  "/assets/avatars/sprite.avif": [path.join("assets", "avatars", "sprite.avif"), "image/avif"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/agents-core.js": ["agents-core.js", "text/javascript; charset=utf-8"],
  "/workspace.js": ["workspace.js", "text/javascript; charset=utf-8"]
});
const MAX_BODY_BYTES = 128 * 1024;

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let length = 0;
    let oversized = false;
    const chunks = [];
    req.on("data", chunk => {
      if (oversized) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        oversized = true;
        reject(Object.assign(new Error("Запрос слишком большой."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (_) { reject(Object.assign(new Error("Некорректный JSON."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function readZip(req) {
  return new Promise((resolve, reject) => {
    let length = 0, exceeded = false;
    const chunks = [];
    const expected = Number(req.headers["content-length"]);
    if (Number.isFinite(expected) && expected > avatarInstaller.MAX_ARCHIVE) {
      return reject(Object.assign(new Error("ZIP слишком большой (максимум 12 МБ)."), { status: 413 }));
    }
    req.on("data", chunk => {
      if (exceeded) return;
      length += chunk.length;
      if (length > avatarInstaller.MAX_ARCHIVE) {
        exceeded = true;
        reject(Object.assign(new Error("ZIP слишком большой (максимум 12 МБ)."), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on("end", () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const avatarRoot = options.avatarDirectory || BASE_DIR;
  let busy = 0;
  let avatarPublishing = false;
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const host = (req.headers.host || "").toLowerCase();
    if (!/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) {
      return json(res, 403, { error: "Доступ разрешён только с локального компьютера." });
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost;
      try { originHost = new URL(origin).host.toLowerCase(); }
      catch (_) { return json(res, 403, { error: "Неверный Origin." }); }
      if (originHost !== host) return json(res, 403, { error: "Запрещён сторонний запрос." });
    }
    const pathname = (req.url || "").split("?")[0];
    if (req.method === "GET" && pathname === "/api/status") {
      return json(res, 200, { configured: engine.configured(env), model: env.AMAYURENA_MODEL || "endpoint-selected" });
    }
    if (req.method === "GET" && pathname === "/api/avatar/publish/status") {
      return json(res, 200, avatarPublisher.status(avatarRoot, env));
    }
    if (req.method === "POST" && pathname === "/api/avatar/publish") {
      if (avatarPublishing) return json(res, 429, { error: "Публикация изображений уже выполняется." });
      if (req.headers["content-type"] !== "application/json") {
        return json(res, 415, { error: "Ожидался JSON-запрос." });
      }
      avatarPublishing = true;
      try {
        const payload = await readJson(req);
        if (!payload || payload.confirm !== "PUBLISH_AVATARS") {
          return json(res, 400, { error: "Публикация требует явного подтверждения." });
        }
        const result = await avatarPublisher.publishAvatars(avatarRoot, env, fetchImpl);
        return json(res, 200, result);
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.status ? error.message : "Не удалось подготовить публикацию в GitHub."
        });
      } finally {
        avatarPublishing = false;
      }
    }
    if (req.method === "POST" && pathname === "/api/avatar/install") {
      if (req.headers["content-type"] !== "application/zip") {
        return json(res, 415, { error: "Выберите ZIP-архив с 10 изображениями." });
      }
      try {
        const archive = await readZip(req);
        const result = avatarInstaller.installAvatarZip(archive, avatarRoot);
        return json(res, 200, result);
      } catch (error) {
        return json(res, error.status || 500,
          { error: error.status ? error.message : "Не удалось сохранить изображения в папке проекта." });
      }
    }
    if (req.method === "POST" && pathname === "/api/tools") {
      try {
        const body = await readJson(req);
        const result = engine.toolResult(body.name, body.args);
        return json(res, 200, { result });
      } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    }
    if (req.method === "POST" && pathname === "/api/chat") {
      if (busy >= 2) return json(res, 429, { error: "Два запроса уже выполняются. Повторите после их завершения." });
      busy++;
      try {
        const body = await readJson(req);
        const answer = await engine.chatCompletion(body, { env, fetchImpl });
        return json(res, 200, answer);
      } catch (e) {
        return json(res, e.status || 400, { error: e.message || "Ошибка обработки запроса." });
      } finally { busy--; }
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const imageMatch = /^\/assets\/avatars\/(pose-0[1-9]|pose-10)\.webp$/.exec(pathname);
      const file = STATIC_FILES[pathname] || (imageMatch ? [path.join("assets", "avatars", imageMatch[1] + ".webp"), "image/webp"] : null);
      if (file) {
        const filename = path.join(imageMatch ? avatarRoot : BASE_DIR, file[0]);
        try {
          const data = fs.readFileSync(filename);
          res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" });
          return res.end(req.method === "HEAD" ? undefined : data);
        } catch (_) { return json(res, imageMatch ? 404 : 500, { error: imageMatch ? "Изображение ещё не загружено." : "Файл приложения недоступен." }); }
      }
    }
    return json(res, 404, { error: "Не найдено." });
  });
}

function openBrowser(url) {
  if (process.platform !== "win32" || process.env.AMAYURENA_NO_BROWSER === "1") return;
  try {
    const processHandle = spawn("cmd.exe", ["/d", "/s", "/c", 'start "" "' + url + '"'], {
      detached: true, stdio: "ignore", windowsHide: true
    });
    processHandle.on("error", () => {});
    processHandle.unref();
  } catch (_) { /* The URL is printed even when a browser cannot be opened. */ }
}

if (require.main === module) {
  const port = process.env.AMAYURENA_PORT === undefined ? 0 : Number(process.env.AMAYURENA_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Неверный порт AMAYURENA_PORT."); process.exitCode = 1;
  } else {
    const server = createServer();
    server.on("error", error => {
      console.error("Не удалось запустить сервер:", error.message);
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + server.address().port + "/";
      console.log("Amayurena запущена: " + url);
      console.log("Cloud.ru: " + (engine.configured(process.env) ? "настроен" : "не настроен"));
      console.log("Для завершения нажмите Ctrl+C.");
      openBrowser(url);
    });
  }
}
module.exports = { createServer, readJson, readZip };

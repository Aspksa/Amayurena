"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const engine = require("./server-core");
const avatarInstaller = require("./avatar-package");
const avatarPublisher = require("./avatar-publisher");
const knowledge = require("./knowledge-core");
const knowledgeAdvanced = require("./knowledge-advanced-core");
const knowledgeMaintenance = require("./knowledge-maintenance");
const knowledgeBases = require("./knowledge-bases-core");
const knowledgeInsights = require("./knowledge-insights-core");
const updater = require("./update-worker");
const attachments = require("./knowledge-attachments");
const knowledgeMapCatalog = require("./knowledge-map-catalog");

const BASE_DIR = __dirname;
const STATIC_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/workspace.css": ["workspace.css", "text/css; charset=utf-8"],
  "/knowledge.css": ["knowledge.css", "text/css; charset=utf-8"],
  "/knowledge.js": ["knowledge.js", "text/javascript; charset=utf-8"],
  "/knowledge-insights.js": ["knowledge-insights.js", "text/javascript; charset=utf-8"],
  "/knowledge-native.js": ["knowledge-native.js", "text/javascript; charset=utf-8"],
  "/knowledge-editor-tools.js": ["knowledge-editor-tools.js", "text/javascript; charset=utf-8"],
  "/knowledge-document-outline.js": ["knowledge-document-outline.js", "text/javascript; charset=utf-8"],
  "/knowledge-bases-math.js": ["knowledge-bases-math.js", "text/javascript; charset=utf-8"],
  "/knowledge-bases-calendar.js": ["knowledge-bases-calendar.js", "text/javascript; charset=utf-8"],
  "/knowledge-advanced.js": ["knowledge-advanced.js", "text/javascript; charset=utf-8"],
  "/knowledge-canvas-layout.js": ["knowledge-canvas-layout.js", "text/javascript; charset=utf-8"],
  "/knowledge-canvas-enhance.js": ["knowledge-canvas-enhance.js", "text/javascript; charset=utf-8"],
  "/knowledge-markdown.js": ["knowledge-markdown.js", "text/javascript; charset=utf-8"],
  "/knowledge-advanced.css": ["knowledge-advanced.css", "text/css; charset=utf-8"],
  "/avatar.css": ["avatar.css", "text/css; charset=utf-8"],
  "/avatar.js": ["avatar.js", "text/javascript; charset=utf-8"],
  "/avatar-assets.js": ["avatar-assets.js", "text/javascript; charset=utf-8"],
  "/avatar-default.svg": ["avatar-default.svg", "image/svg+xml"],
  "/assets/avatars/sprite.avif": [path.join("assets", "avatars", "sprite.avif"), "image/avif"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/update-ui.js": ["update-ui.js", "text/javascript; charset=utf-8"],
  "/agents-core.js": ["agents-core.js", "text/javascript; charset=utf-8"],
  "/chat-sessions.js": ["chat-sessions.js", "text/javascript; charset=utf-8"],
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

function readBinary(req,limit=attachments.MAX_BYTES){
  return new Promise((resolve,reject)=>{
    let size=0,exceeded=false;
    const chunks=[];
    req.on("data",chunk=>{
      if(exceeded)return;
      size+=chunk.length;
      if(size>limit){
        exceeded=true;
        reject(Object.assign(new Error("Вложение больше 5 МиБ."),{status:413}));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end",()=>{if(!exceeded)resolve(Buffer.concat(chunks));});
    req.on("error",reject);
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
  const knowledgeRoot = options.knowledgeDirectory || path.join(BASE_DIR, "data", "knowledge");
  const historyRoot = options.knowledgeHistoryDirectory || (options.knowledgeDirectory ? path.join(knowledgeRoot, ".history") : path.join(BASE_DIR, "data", "knowledge-history"));
  const canvasRoot = options.knowledgeCanvasDirectory || (options.knowledgeDirectory ? path.join(knowledgeRoot, ".canvases") : path.join(BASE_DIR, "data", "canvases"));
  const basesRoot = options.knowledgeBasesDirectory || (options.knowledgeDirectory ? path.join(path.dirname(knowledgeRoot), ".knowledge-bases") : path.join(BASE_DIR, "data", "knowledge-bases"));
  const maintenanceRoot = options.knowledgeDataDirectory || (options.knowledgeDirectory ? path.join(knowledgeRoot, ".workspace") : path.join(BASE_DIR, "data"));
  const attachmentsRoot = options.knowledgeAttachmentsDirectory ||
    (options.knowledgeDirectory ? path.join(path.dirname(knowledgeRoot),".knowledge-attachments") :
      path.join(BASE_DIR,"data","knowledge-attachments"));
  const maintenance = { notesRoot: knowledgeRoot, historyRoot, canvasRoot, basesRoot, attachmentsRoot,
    trashRoot: path.join(maintenanceRoot, "trash"), backupsRoot: path.join(maintenanceRoot, "backups") };
  let busy = 0;
  let avatarPublishing = false;
  const server = http.createServer(async (req, res) => {
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
    if(req.method==="GET"&&pathname==="/api/update/check"){
      try{
        return json(res,200,await updater.check(options.updateFetchImpl||fetch,BASE_DIR));
      }catch(e){return json(res,503,{error:"Не удалось проверить обновление: "+e.message});}
    }
    if(req.method==="POST"&&pathname==="/api/update/install"){
      if(process.platform!=="win32"||require.main!==module||env.AMAYURENA_NO_SELF_UPDATE==="1")
        return json(res,501,{error:"Автоустановка доступна только в локальном запуске Windows."});
      try{
        if(req.headers["content-type"]!=="application/json")return json(res,415,{error:"Ожидался JSON."});
        const body=await readJson(req);
        if(!body||body.confirm!=="INSTALL_VERIFIED_RELEASE")return json(res,400,{error:"Не подтверждена установка."});
        const latest=await updater.check(options.updateFetchImpl||fetch,BASE_DIR);
        if(!latest.available)return json(res,409,{error:latest.reason||"Доступного обновления нет."});
        const logDir=path.join(BASE_DIR,".updates");
        fs.mkdirSync(logDir,{recursive:true});
        const log=fs.openSync(path.join(logDir,"updater.log"),"a",0o600);
        let child;
        try{
          child=spawn(process.execPath,[path.join(BASE_DIR,"update-worker.js"),"install","--wait-pid="+process.pid,
            "--expected-tag="+latest.latest],{
            detached:true,windowsHide:true,stdio:["ignore",log,log],cwd:BASE_DIR
          });
        }finally{fs.closeSync(log);}
        if(!child.pid)return json(res,500,{error:"Не удалось запустить установщик."});
        child.on("error",()=>{});
        child.unref();
        json(res,202,{started:true,tag:latest.latest,
          message:"Сервер завершает работу для установки. Результат: .updates/updater.log"});
        setImmediate(()=>server.close(()=>process.exit(0)));
        return;
      }catch(e){return json(res,500,{error:"Не удалось начать обновление: "+e.message});}
    }
    if (req.method === "GET" && pathname === "/api/status") {
      return json(res, 200, { configured: engine.configured(env), model: env.AMAYURENA_MODEL || "endpoint-selected" });
    }
    if (pathname === "/api/knowledge" && req.method === "GET") {
      try { return json(res, 200, knowledge.list(knowledgeRoot)); }
      catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Ошибка чтения базы знаний." }); }
    }
    if(pathname==="/api/knowledge/attachments"&&req.method==="GET"){
      try{
        const q=new URL(req.url,"http://localhost").searchParams;
        return json(res,200,{items:attachments.list(attachmentsRoot,knowledgeRoot,q.get("path"))});
      }catch(e){return json(res,e.status||500,{error:e.status?e.message:"Вложения недоступны."});}
    }
    if(pathname==="/api/knowledge/attachment"&&req.method==="POST"){
      try{
        if(req.headers["content-type"]!=="application/octet-stream")return json(res,415,{error:"Ожидался двоичный файл."});
        const q=new URL(req.url,"http://localhost").searchParams;
        const data=await readBinary(req);
        return json(res,201,attachments.save(attachmentsRoot,knowledgeRoot,q.get("path"),q.get("name"),data));
      }catch(e){return json(res,e.status||500,{error:e.status?e.message:"Не удалось сохранить вложение."});}
    }
    if(pathname==="/api/knowledge/attachment"&&req.method==="GET"){
      try{
        const id=new URL(req.url,"http://localhost").searchParams.get("id");
        const file=attachments.open(attachmentsRoot,id);
        res.writeHead(200,{"Content-Type":"application/octet-stream",
          "Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(file.name),
          "Content-Length":file.bytes.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
        return res.end(file.bytes);
      }catch(e){return json(res,e.status||500,{error:e.status?e.message:"Вложение недоступно."});}
    }
    if (pathname === "/api/knowledge/search" && req.method === "GET") {
      try {
        const q = new URL(req.url, "http://localhost").searchParams.get("q");
        return json(res, 200, knowledgeMaintenance.search(knowledgeRoot, q));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Ошибка поиска." }); }
    }
    if (pathname === "/api/knowledge/trash" && req.method === "GET") {
      try { return json(res, 200, { items: knowledgeMaintenance.trashList(maintenance) }); }
      catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Корзина недоступна." }); }
    }
    if (pathname === "/api/knowledge/trash/restore" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON." });
        const body = await readJson(req);
        return json(res, 200, knowledgeMaintenance.trashRestore(maintenance, body && body.id));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось восстановить заметку." }); }
    }
    if (pathname === "/api/knowledge/backups" && req.method === "GET") {
      try { return json(res, 200, { items: knowledgeMaintenance.backups(maintenance) }); }
      catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось прочитать копии." }); }
    }
    if (pathname === "/api/knowledge/backup/create" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON." });
        const body = await readJson(req);
        if (!body || body.confirm !== "CREATE_BACKUP") return json(res, 400, { error: "Подтвердите создание копии." });
        return json(res, 201, knowledgeMaintenance.backup(maintenance));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось создать копию." }); }
    }
    if (pathname === "/api/knowledge/backup/restore" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON." });
        const body = await readJson(req);
        if (!body || body.confirm !== "RESTORE_BACKUP") return json(res, 400, { error: "Подтвердите восстановление." });
        return json(res, 200, knowledgeMaintenance.restoreBackup(maintenance, body.id));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось восстановить копию." }); }
    }
    if (pathname === "/api/knowledge/note/move" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON." });
        const body = await readJson(req);
        return json(res, 200, knowledgeMaintenance.renameNote(maintenance, body && body.from, body && body.to));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось переместить заметку." }); }
    }
    if (pathname === "/api/knowledge/folder/move" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON." });
        const body = await readJson(req);
        return json(res, 200, knowledgeMaintenance.moveFolder(maintenance, body && body.from, body && body.to));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось переместить папку." }); }
    }
    if (pathname === "/api/knowledge/map/catalog" && req.method === "GET") {
      try {
        const q=new URL(req.url,"http://localhost").searchParams;
        return json(res,200,knowledgeMapCatalog.view(knowledgeRoot,{
          folder:q.get("folder")||"",q:q.get("q")||"",
          page:q.has("page")?Number(q.get("page")):0,
          size:q.has("size")?Number(q.get("size")):120
        }));
      }catch(e){return json(res,e.status||500,{error:e.status?e.message:"Не удалось прочитать каталог."});}
    }
    if (pathname === "/api/knowledge/map/neighbors" && req.method === "GET") {
      try{
        const q=new URL(req.url,"http://localhost").searchParams;
        return json(res,200,knowledgeMapCatalog.neighbors(knowledgeRoot,q.get("path"),{
          limit:q.has("limit")?Number(q.get("limit")):120
        }));
      }catch(e){return json(res,e.status||500,{error:e.status?e.message:"Не удалось прочитать соседние заметки."});}
    }
    if (pathname === "/api/knowledge/map/timeline" && req.method === "GET") {
      try {
        const q=new URL(req.url,"http://localhost").searchParams;
        return json(res,200,knowledgeMapCatalog.timeline(knowledgeRoot,historyRoot,q.get("path")));
      }catch(e){return json(res,e.status||500,{error:e.status?e.message:"Не удалось получить историю."});}
    }
    if (pathname === "/api/knowledge/insights" && req.method === "GET") {
      try { return json(res,200,knowledgeInsights.analyze(knowledgeRoot,canvasRoot,historyRoot)); }
      catch(e) { return json(res,e.status||500,{error:e.status?e.message:"Не удалось построить карту знаний."}); }
    }
    if (pathname === "/api/knowledge/insights/accept" && req.method === "POST") {
      try {
        if(req.headers["content-type"]!=="application/json") return json(res,415,{error:"Ожидался JSON."});
        const body=await readJson(req);
        return json(res,200,knowledgeInsights.accept(knowledgeRoot,historyRoot,canvasRoot,body));
      } catch(e) { return json(res,e.status||500,{error:e.status?e.message:"Не удалось сохранить предложенную связь."}); }
    }
    if (pathname === "/api/knowledge/graph" && req.method === "GET") {
      try { return json(res, 200, knowledge.graph(knowledgeRoot)); }
      catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Ошибка построения графа." }); }
    }
    if (pathname === "/api/knowledge/bases/settings" && req.method === "GET") {
      try { return json(res, 200, knowledgeBases.loadSettings(basesRoot)); }
      catch (e) { return json(res, e.status || 500, {error:e.status ? e.message : "Ошибка настроек Bases."}); }
    }
    if (pathname === "/api/knowledge/bases/settings" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res,415,{error:"Ожидался JSON."});
        const body=await readJson(req);
        return json(res,200,knowledgeBases.saveSettings(basesRoot,body && body.settings,body && body.expectedSha));
      } catch (e) { return json(res, e.status || 500, {error:e.status ? e.message : "Настройки Bases не сохранены."}); }
    }
    if (pathname === "/api/knowledge/bases/property" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res,415,{error:"Ожидался JSON."});
        const body=await readJson(req);
        return json(res,200,knowledgeBases.patchProperty(knowledgeRoot,historyRoot,
          body && body.path,body && body.key,body && body.type,body && body.value,body && body.expectedSha));
      } catch (e) { return json(res, e.status || 500, {error:e.status ? e.message : "Свойство заметки не сохранено."}); }
    }
    if (pathname === "/api/knowledge/bases" && req.method === "GET") {
      try { return json(res, 200, knowledgeAdvanced.bases(knowledgeRoot)); }
      catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось открыть таблицу Bases." }); }
    }
    if (pathname === "/api/knowledge/history" && req.method === "GET") {
      try {
        const note = new URL(req.url, "http://localhost").searchParams.get("path");
        return json(res, 200, { versions: knowledgeAdvanced.history(historyRoot, knowledge.normalizePath(note)) });
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Ошибка истории." }); }
    }
    if (pathname === "/api/knowledge/history/version" && req.method === "GET") {
      try {
        const q = new URL(req.url, "http://localhost").searchParams;
        return json(res, 200, knowledgeAdvanced.readVersion(historyRoot, knowledge.normalizePath(q.get("path")), q.get("id")));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Версия недоступна." }); }
    }
    if (pathname === "/api/knowledge/history/restore" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON." });
        const body = await readJson(req);
        return json(res, 200, knowledgeAdvanced.restoreNote(knowledgeRoot, historyRoot, body && body.path, body && body.id));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось восстановить заметку." }); }
    }
    if (pathname === "/api/knowledge/canvases" && req.method === "GET") {
      try { return json(res, 200, { boards: knowledgeAdvanced.listCanvases(canvasRoot) }); }
      catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось прочитать доски." }); }
    }
    if (pathname === "/api/knowledge/canvas" && ["GET", "POST", "DELETE"].includes(req.method)) {
      try {
        const q = new URL(req.url, "http://localhost").searchParams;
        if (req.method === "GET") return json(res, 200, knowledgeAdvanced.readCanvas(canvasRoot, q.get("name")));
        if (req.method === "DELETE") return json(res, 200, knowledgeAdvanced.deleteCanvas(canvasRoot, q.get("name"),
          q.has("expectedSha") ? q.get("expectedSha") : undefined));
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON." });
        const body = await readJson(req);
        return json(res, 200, knowledgeAdvanced.saveCanvas(canvasRoot, body && body.name, body && body.board,
          body && Object.prototype.hasOwnProperty.call(body, "expectedSha") ? body.expectedSha : undefined));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Ошибка Canvas." }); }
    }
    if (pathname === "/api/knowledge/note/create" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON-запрос." });
        const body = await readJson(req);
        return json(res, 201, knowledge.create(knowledgeRoot, body && body.path, body && body.content));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Не удалось создать заметку." }); }
    }
    if (pathname === "/api/knowledge/note" && ["GET", "POST", "DELETE"].includes(req.method)) {
      try {
        const search = new URL(req.url, "http://localhost").searchParams;
        if (req.method === "GET") {
          const note = knowledge.read(knowledgeRoot, search.get("path"));
          return json(res, 200, { ...note, sha: knowledgeMaintenance.sha(note.content) });
        }
        if (req.method === "DELETE") return json(res, 200, knowledgeMaintenance.trashNote(maintenance, search.get("path")));
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON-запрос." });
        const body = await readJson(req);
        if (body && typeof body.expectedSha === "string") {
          let current;
          try { current = knowledge.read(knowledgeRoot, body.path).content; }
          catch (e) { if (e.status !== 404) throw e; throw knowledge.problem("Заметка была удалена или перемещена. Сохранение отменено.", 409); }
          if (knowledgeMaintenance.sha(current) !== body.expectedSha) {
            throw knowledge.problem("Заметка изменена в другом окне. Ваши изменения не перезаписаны.", 409);
          }
        }
        const result = knowledgeAdvanced.saveNote(knowledgeRoot, historyRoot, body && body.path, body && body.content);
        return json(res, 200, { ...result, sha: knowledgeMaintenance.sha(body.content) });
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Ошибка работы с заметкой." }); }
    }
    if (pathname === "/api/knowledge/folder" && req.method === "POST") {
      try {
        if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Ожидался JSON-запрос." });
        const body = await readJson(req);
        return json(res, 200, knowledge.makeFolder(knowledgeRoot, body && body.path));
      } catch (e) { return json(res, e.status || 500, { error: e.status ? e.message : "Ошибка создания папки." }); }
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
  return server;
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
      const pidDir=path.join(BASE_DIR,".updates");
      fs.mkdirSync(pidDir,{recursive:true});
      const pidFile=path.join(pidDir,"server.pid");
      fs.writeFileSync(pidFile,String(process.pid),{mode:0o600});
      process.on("exit",()=>{
        try{
          if(fs.existsSync(pidFile)&&fs.readFileSync(pidFile,"utf8").trim()===String(process.pid))
            fs.unlinkSync(pidFile);
        }catch(_){}
      });
      const url = "http://127.0.0.1:" + server.address().port + "/";
      console.log("Amayurena запущена: " + url);
      console.log("Cloud.ru: " + (engine.configured(process.env) ? "настроен" : "не настроен"));
      console.log("Для завершения нажмите Ctrl+C.");
      openBrowser(url);
    });
  }
}
module.exports = { createServer, readJson, readZip };

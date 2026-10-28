"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./knowledge-core");
const advanced = require("./knowledge-advanced-core");

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
const VOLUMES = ["knowledge", "history", "canvases", "trash"];

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function safeDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("Недопустимая папка хранения.", 500);
  return dir;
}
function safeName(name) {
  if (typeof name !== "string" || !/^[0-9]{13}-[a-f0-9-]{8,50}$/.test(name)) {
    throw fail("Недопустимый идентификатор.");
  }
  return name;
}
function safeFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail("Ссылка или специальный файл запрещены.");
  return stat;
}
function sha(content) { return crypto.createHash("sha256").update(content).digest("hex"); }
function atomicJson(file, value) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function stores(spec) {
  return {
    knowledge: spec.notesRoot, history: spec.historyRoot, canvases: spec.canvasRoot,
    trash: spec.trashRoot, backups: spec.backupsRoot
  };
}
function search(notesRoot, raw) {
  const term = typeof raw === "string" ? raw.trim() : "";
  if (!term || term.length > 120) throw fail("Введите запрос до 120 символов.");
  const query = term.toLocaleLowerCase("ru");
  const results = [];
  for (const note of core.list(notesRoot).notes) {
    const content = core.read(notesRoot, note.path).content;
    const lowered = content.toLocaleLowerCase("ru");
    const at = lowered.indexOf(query);
    const pathMatch = note.path.toLocaleLowerCase("ru").includes(query);
    if (at < 0 && !pathMatch) continue;
    const start = at < 0 ? 0 : Math.max(0, at - 75);
    const snippet = content.slice(start, Math.min(content.length, start + 260))
      .replace(/[\r\n\t]+/g, " ");
    results.push({ path: note.path, title: note.title, snippet, offset: at, updatedAt: note.updatedAt });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return { query: term, results, truncated: results.length === MAX_SEARCH_RESULTS };
}
function entryFile(trashRoot, id) { return path.join(safeDir(trashRoot), safeName(id) + ".json"); }
function trashNote(spec, requested) {
  const note = core.read(spec.notesRoot, requested);
  const id = Date.now().toString().padStart(13, "0") + "-" + crypto.randomUUID();
  const entry = { id, path: note.path, deletedAt: new Date().toISOString(), content: note.content };
  atomicJson(entryFile(spec.trashRoot, id), entry);
  try {
    // History remains available even after deletion; the trash entry is the primary recovery source.
    advanced.deleteNote(spec.notesRoot, spec.historyRoot, note.path);
  } catch (error) {
    fs.unlinkSync(entryFile(spec.trashRoot, id));
    throw error;
  }
  return { id, path: note.path, deletedAt: entry.deletedAt };
}
function trashList(spec) {
  safeDir(spec.trashRoot);
  return fs.readdirSync(spec.trashRoot).filter(name => /^[0-9]{13}-[a-f0-9-]{8,50}\.json$/.test(name))
    .sort().reverse().map(name => {
      const entry = JSON.parse(fs.readFileSync(entryFile(spec.trashRoot, name.slice(0,-5)), "utf8"));
      return { id: entry.id, path: entry.path, deletedAt: entry.deletedAt };
    });
}
function trashRestore(spec, id) {
  const file = entryFile(spec.trashRoot, id);
  if (!fs.existsSync(file)) throw fail("Запись в корзине не найдена.", 404);
  safeFile(file);
  const item = JSON.parse(fs.readFileSync(file, "utf8"));
  if (item.id !== id) throw fail("Запись корзины повреждена.");
  const result = core.create(spec.notesRoot, item.path, item.content);
  fs.unlinkSync(file);
  return result;
}
function ensureVacant(folder) {
  if (fs.existsSync(folder)) throw fail("Такое имя уже существует.", 409);
}

function rebaseHistory(spec, mapping) {
  for (const [oldPath, newPath] of mapping) {
    const oldDir = path.join(spec.historyRoot, sha(oldPath));
    if (!fs.existsSync(oldDir)) continue;
    const newDir = path.join(spec.historyRoot, sha(newPath));
    ensureVacant(newDir);
    for (const name of fs.readdirSync(oldDir)) {
      if (!/^[0-9]{13}-[a-f0-9]{12}\.json$/.test(name)) throw fail("Неподдерживаемый файл истории.");
      const filename = path.join(oldDir, name);
      safeFile(filename);
      const value = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (value.path !== oldPath) throw fail("История не соответствует заметке.");
      value.path = newPath;
      atomicJson(filename, value);
    }
    fs.renameSync(oldDir, newDir);
  }
}
function updateReferences(spec, mapping) {
  const replacements = new Map(mapping.map(([from, to]) => [
    from.replace(/\.md$/i, "").toLocaleLowerCase("ru"), to.replace(/\.md$/i, "")
  ]));
  let changedNotes = 0, changedBoards = 0;
  for (const note of core.list(spec.notesRoot).notes) {
    const old = core.read(spec.notesRoot, note.path).content;
    const updated = old.replace(/\[\[([^\]\r\n]{1,250})\]\]/g, (whole, target) => {
      const pipe = target.indexOf("|");
      const base = pipe < 0 ? target : target.slice(0, pipe);
      const hashAt = base.indexOf("#");
      const name = (hashAt < 0 ? base : base.slice(0, hashAt)).trim().replace(/\.md$/i, "");
      const replacement = replacements.get(name.toLocaleLowerCase("ru"));
      if (!replacement) return whole;
      const anchor = hashAt < 0 ? "" : base.slice(hashAt);
      const alias = pipe < 0 ? "" : target.slice(pipe);
      return "[[" + replacement + anchor + alias + "]]";
    });
    if (updated !== old) {
      advanced.saveNote(spec.notesRoot, spec.historyRoot, note.path, updated);
      changedNotes++;
    }
  }
  for (const item of advanced.listCanvases(spec.canvasRoot)) {
    const board = advanced.readCanvas(spec.canvasRoot, item.name);
    let touched = false;
    for (const card of board.nodes) {
      const target = mapping.find(([from]) => card.type === "file" && card.file === from);
      if (target) { card.file = target[1]; touched = true; }
    }
    if (touched) { advanced.saveCanvas(spec.canvasRoot, item.name, board); changedBoards++; }
  }
  return { changedNotes, changedBoards };
}

function renameNote(spec, oldPath, nextPath) {
  const from = core.normalizePath(oldPath), to = core.normalizePath(nextPath);
  if (from === to) return { from, to, unchanged: true };
  core.read(spec.notesRoot, from);
  const source = path.join(spec.notesRoot, ...from.split("/"));
  const dest = path.join(spec.notesRoot, ...to.split("/"));
  ensureVacant(dest);
  // Restrict path segments to actual directories, never follow symlinks.
  const parent = to.split("/").slice(0, -1);
  let at = safeDir(spec.notesRoot);
  for (const part of parent) {
    at = path.join(at, part);
    if (!fs.existsSync(at)) fs.mkdirSync(at);
    if (!fs.lstatSync(at).isDirectory() || fs.lstatSync(at).isSymbolicLink()) throw fail("Небезопасная папка.");
  }
  fs.renameSync(source, dest);
  rebaseHistory(spec, [[from, to]]);
  return { from, to, ...updateReferences(spec, [[from, to]]) };
}
function moveFolder(spec, oldPath, nextPath) {
  const from = core.normalizePath(oldPath, true), to = core.normalizePath(nextPath, true);
  if (from === to) return { from, to, unchanged: true };
  if (to.startsWith(from + "/")) throw fail("Нельзя переместить папку внутрь самой себя.");
  const source = path.join(spec.notesRoot, ...from.split("/"));
  if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) {
    throw fail("Папка не найдена.", 404);
  }
  const dest = path.join(spec.notesRoot, ...to.split("/"));
  ensureVacant(dest);
  const names = to.split("/").slice(0, -1);
  let target = safeDir(spec.notesRoot);
  for (const name of names) {
    target = path.join(target, name);
    if (!fs.existsSync(target)) fs.mkdirSync(target);
    if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) throw fail("Небезопасная папка.");
  }
  // Reject nested symlinks before moving the folder.
  function verify(dir) {
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw fail("Папка содержит символическую ссылку.");
      if (stat.isDirectory()) verify(full);
      else if (!stat.isFile()) throw fail("Недопустимое содержимое папки.");
    }
  }
  verify(source);
  const moved = core.list(spec.notesRoot).notes
    .filter(note => note.path.startsWith(from + "/"))
    .map(note => [note.path, to + note.path.slice(from.length)]);
  fs.renameSync(source, dest);
  rebaseHistory(spec, moved);
  return { from, to, moved: moved.length, ...updateReferences(spec, moved) };
}
function copyTree(src, dst, report, rel = "") {
  safeDir(dst);
  if (!fs.existsSync(src)) return;
  if (!fs.lstatSync(src).isDirectory() || fs.lstatSync(src).isSymbolicLink()) throw fail("Небезопасный источник резервной копии.");
  for (const entry of fs.readdirSync(src)) {
    if (rel === "knowledge" && entry.startsWith(".")) continue; // ignores embedded hidden private folders
    const from = path.join(src, entry), to = path.join(dst, entry), info = fs.lstatSync(from);
    if (info.isSymbolicLink()) throw fail("Резервное копирование ссылок запрещено.");
    if (info.isDirectory()) copyTree(from, to, report, rel + "/" + entry);
    else if (info.isFile()) {
      report.total += info.size;
      if (report.total > MAX_BACKUP_BYTES) throw fail("Объём резервной копии превышает 256 МиБ.", 413);
      const content = fs.readFileSync(from);
      fs.writeFileSync(to, content, { flag: "wx", mode: 0o600 });
      report.files.push({ path: rel + "/" + entry, bytes: content.length, sha256: sha(content) });
    } else throw fail("Недопустимое содержимое резервной копии.");
  }
}
function backup(spec) {
  const folder = safeDir(spec.backupsRoot);
  const id = Date.now().toString().padStart(13, "0") + "-" + crypto.randomUUID();
  const pending = path.join(folder, "." + id + ".pending"), dest = path.join(folder, id);
  const dirs = stores(spec);
  fs.mkdirSync(pending);
  const report = { files: [], total: 0 };
  try {
    for (const name of VOLUMES) copyTree(dirs[name], path.join(pending, name), report, name);
    const manifest = { id, createdAt: new Date().toISOString(), count: report.files.length,
      bytes: report.total, files: report.files };
    atomicJson(path.join(pending, "manifest.json"), manifest);
    fs.renameSync(pending, dest);
    return { id, createdAt: manifest.createdAt, count: manifest.count, bytes: manifest.bytes };
  } finally { if (fs.existsSync(pending)) fs.rmSync(pending, { recursive: true, force: true }); }
}
function verifyBackup(spec, id) {
  const folder = path.join(safeDir(spec.backupsRoot), safeName(id));
  if (!fs.existsSync(folder)) throw fail("Резервная копия не найдена.", 404);
  if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw fail("Неверная копия.");
  const manifestPath = path.join(folder, "manifest.json");
  safeFile(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.id !== id || !Array.isArray(manifest.files) || manifest.files.length > 60000) throw fail("Повреждённый манифест.");
  let total = 0;
  for (const item of manifest.files) {
    if (typeof item.path !== "string" || !VOLUMES.some(v => item.path.startsWith(v + "/")) ||
        item.path.includes("\\") || item.path.split("/").some(s => !s || s === "." || s === "..")) throw fail("Небезопасный путь архива.");
    const filename = path.join(folder, ...item.path.split("/"));
    const data = fs.readFileSync(filename);
    safeFile(filename);
    total += data.length;
    if (total > MAX_BACKUP_BYTES || data.length !== item.bytes || sha(data) !== item.sha256) throw fail("Не совпала контрольная сумма резервной копии.");
  }
  if (total !== manifest.bytes || manifest.files.length !== manifest.count) throw fail("Резервная копия повреждена.");
  return { folder, manifest };
}
function backups(spec) {
  safeDir(spec.backupsRoot);
  return fs.readdirSync(spec.backupsRoot).filter(s => /^[0-9]{13}-[a-f0-9-]{8,50}$/.test(s))
    .sort().reverse().flatMap(id => {
      try {
        const { manifest } = verifyBackup(spec, id);
        return [{ id, createdAt: manifest.createdAt, count: manifest.count, bytes: manifest.bytes }];
      } catch (_) { return []; }
    });
}
function restoreBackup(spec, id) {
  const { folder } = verifyBackup(spec, id);
  const dirs = stores(spec);
  const stage = {}, previous = {}, installed = [];
  const key = crypto.randomUUID();
  try {
    // Prepare all four volumes before touching live data.
    for (const name of VOLUMES) {
      stage[name] = dirs[name] + ".restore-" + key;
      previous[name] = dirs[name] + ".previous-" + key;
      if (fs.existsSync(stage[name]) || fs.existsSync(previous[name])) throw fail("Временная папка уже существует.");
      copyTree(path.join(folder, name), stage[name], { files: [], total: 0 }, name);
    }
    for (const name of VOLUMES) {
      if (fs.existsSync(dirs[name])) fs.renameSync(dirs[name], previous[name]);
      try { fs.renameSync(stage[name], dirs[name]); installed.push(name); }
      catch (error) {
        if (fs.existsSync(previous[name])) fs.renameSync(previous[name], dirs[name]);
        throw error;
      }
    }
    for (const name of VOLUMES) if (fs.existsSync(previous[name])) {
      try { fs.rmSync(previous[name], { recursive: true, force: true }); }
      catch (_) { /* Recovery was installed successfully; preserve old copy on cleanup failure. */ }
    }
    return { restored: id };
  } catch (error) {
    for (const name of installed.reverse()) {
      if (fs.existsSync(dirs[name])) fs.rmSync(dirs[name], { recursive: true, force: true });
      if (fs.existsSync(previous[name])) fs.renameSync(previous[name], dirs[name]);
    }
    throw error;
  } finally {
    for (const name of VOLUMES) if (stage[name] && fs.existsSync(stage[name]))
      fs.rmSync(stage[name], { recursive: true, force: true });
  }
}
module.exports = { search, trashNote, trashList, trashRestore, renameNote, moveFolder,
  backup, backups, restoreBackup, verifyBackup, sha };

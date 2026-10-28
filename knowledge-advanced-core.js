"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const knowledge = require("./knowledge-core");

const MAX_HISTORY = 20;
const MAX_CANVAS_NODES = 60;
const MAX_CANVAS_EDGES = 120;

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function dirSafe(folder) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("Небезопасное хранилище.", 500);
  return folder;
}
function writeAtomic(filename, content) {
  const temp = filename + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, filename);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}
function noteHistoryFolder(root, relative, create = true) {
  const valid = knowledge.normalizePath(relative);
  if (create) dirSafe(root);
  const folder = path.join(root, crypto.createHash("sha256").update(valid).digest("hex"));
  if (create) dirSafe(folder);
  if (fs.existsSync(folder)) dirSafe(folder);
  return folder;
}
function history(root, notePath) {
  const folder = noteHistoryFolder(root, notePath, false);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => /^[0-9]{13}-[a-f0-9]{12}\.json$/.test(name))
    .sort().reverse().map(name => {
      const full = path.join(folder, name);
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 160000) return null;
      const record = JSON.parse(fs.readFileSync(full, "utf8"));
      return { id: name.slice(0, -5), at: record.at, bytes: Buffer.byteLength(record.content, "utf8") };
    }).filter(Boolean);
}
function snapshot(root, notePath, content) {
  const folder = noteHistoryFolder(root, notePath);
  const id = Date.now().toString().padStart(13, "0") + "-" + crypto.randomBytes(6).toString("hex");
  writeAtomic(path.join(folder, id + ".json"), JSON.stringify({
    path: notePath, at: new Date().toISOString(), content
  }));
  const records = history(root, notePath);
  for (const record of records.slice(MAX_HISTORY)) fs.unlinkSync(path.join(folder, record.id + ".json"));
  return id;
}
function readVersion(root, notePath, id) {
  if (typeof id !== "string" || !/^[0-9]{13}-[a-f0-9]{12}$/.test(id)) throw fail("Неверная версия.");
  const filename = path.join(noteHistoryFolder(root, notePath, false), id + ".json");
  if (!fs.existsSync(filename)) throw fail("Версия не найдена.", 404);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 160000) throw fail("Версия повреждена.");
  const record = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (record.path !== notePath || typeof record.content !== "string") throw fail("Версия повреждена.");
  return { id, at: record.at, content: record.content };
}
function saveNote(noteRoot, historyRoot, notePath, content) {
  const valid = knowledge.normalizePath(notePath);
  let old;
  try { old = knowledge.read(noteRoot, valid).content; }
  catch (e) { if (e.status !== 404) throw e; }
  if (old === content) return { path: valid, unchanged: true };
  // Validate length before saving any snapshot; old content stays available if validation fails.
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > knowledge.MAX_NOTE_BYTES) {
    throw fail("Заметка превышает 128 КБ.", 413);
  }
  if (old !== undefined) snapshot(historyRoot, valid, old);
  return knowledge.save(noteRoot, valid, content);
}
function deleteNote(noteRoot, historyRoot, notePath) {
  const note = knowledge.read(noteRoot, notePath);
  snapshot(historyRoot, note.path, note.content);
  return knowledge.remove(noteRoot, note.path);
}
function restoreNote(noteRoot, historyRoot, notePath, id) {
  const valid = knowledge.normalizePath(notePath);
  const record = readVersion(historyRoot, valid, id);
  return saveNote(noteRoot, historyRoot, valid, record.content);
}
function canvasName(name) {
  if (typeof name !== "string" || name.length > 70 || name.includes("/") || name.includes("\\")) throw fail("Неверное имя доски.");
  knowledge.normalizePath(name + ".md");
  return name;
}
function canvasFile(root, name) {
  dirSafe(root);
  const filename = path.join(root, canvasName(name) + ".canvas.json");
  if (fs.existsSync(filename)) {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw fail("Недопустимая доска.");
  }
  return filename;
}
function validCanvas(name, data) {
  canvasName(name);
  if (!data || typeof data !== "object" || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw fail("Неправильный формат Canvas.");
  if (data.nodes.length > MAX_CANVAS_NODES || data.edges.length > MAX_CANVAS_EDGES) throw fail("Превышен размер доски.", 413);
  const ids = new Set();
  const nodes = data.nodes.map(n => {
    if (!n || !/^[\w-]{1,64}$/.test(n.id) || ids.has(n.id) ||
        !["text", "file"].includes(n.type) || !Number.isInteger(n.x) || !Number.isInteger(n.y) ||
        n.x < 0 || n.y < 0 || n.x > 3200 || n.y > 2400) throw fail("Недопустимая карточка Canvas.");
    ids.add(n.id);
    if (n.type === "file") return { id: n.id, type: n.type, x: n.x, y: n.y, file: knowledge.normalizePath(n.file) };
    if (typeof n.text !== "string" || n.text.length > 2500) throw fail("Слишком большой текст карточки.");
    return { id: n.id, type: n.type, x: n.x, y: n.y, text: n.text };
  });
  const seen = new Set();
  const edges = data.edges.map(e => {
    if (!e || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) throw fail("Неверная связь Canvas.");
    const key = e.from + ":" + e.to;
    if (seen.has(key)) throw fail("Дублирующаяся связь Canvas.");
    seen.add(key);
    return { from: e.from, to: e.to };
  });
  const normalized = { name, nodes, edges, updatedAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 115000) throw fail("Canvas слишком большой.", 413);
  return normalized;
}
function listCanvases(root) {
  dirSafe(root);
  return fs.readdirSync(root).filter(f => f.endsWith(".canvas.json")).flatMap(f => {
    const name = f.slice(0, -".canvas.json".length);
    try {
      const filename = canvasFile(root, name);
      const stat = fs.lstatSync(filename);
      return [{ name, updatedAt: stat.mtime.toISOString() }];
    } catch (_) { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
function readCanvas(root, name) {
  const filename = canvasFile(root, name);
  if (!fs.existsSync(filename)) throw fail("Доска не найдена.", 404);
  if (fs.statSync(filename).size > 115000) throw fail("Canvas слишком большой.", 413);
  const data = JSON.parse(fs.readFileSync(filename, "utf8"));
  return { ...validCanvas(name, data), updatedAt: data.updatedAt || "" };
}
function saveCanvas(root, name, data) {
  const next = validCanvas(name, data);
  writeAtomic(canvasFile(root, name), JSON.stringify(next, null, 2));
  return next;
}
function deleteCanvas(root, name) {
  const filename = canvasFile(root, name);
  if (!fs.existsSync(filename)) throw fail("Доска не найдена.", 404);
  fs.unlinkSync(filename);
  return { deleted: name };
}
function properties(content) {
  const result = Object.create(null);
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return result;
  const end = lines.slice(1, 61).indexOf("---");
  if (end < 0) return result;
  for (const line of lines.slice(1, end + 1)) {
    const match = /^([a-zA-Zа-яА-ЯёЁ][\wа-яА-ЯёЁ-]{0,39}):\s*(.{0,250})$/.exec(line);
    if (!match || ["constructor", "prototype", "__proto__"].includes(match[1])) continue;
    let value = match[2].replace(/^["']|["']$/g, "");
    if (/^\[[^\[\]]*\]$/.test(value)) value = value.slice(1, -1).split(",").map(x => x.trim()).filter(Boolean);
    result[match[1]] = value;
  }
  return result;
}
function bases(root) {
  const index = knowledge.list(root);
  const columns = new Set(["title", "folder", "updatedAt"]);
  const rows = index.notes.map(note => {
    const props = properties(knowledge.read(root, note.path).content);
    Object.keys(props).forEach(key => columns.add(key));
    return { path: note.path, title: note.title, folder: note.folder, updatedAt: note.updatedAt, properties: props };
  });
  return { columns: [...columns], rows };
}
module.exports = { history, snapshot, readVersion, saveNote, deleteNote, restoreNote,
  listCanvases, readCanvas, saveCanvas, deleteCanvas, properties, bases, validCanvas };

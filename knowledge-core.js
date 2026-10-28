"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_NOTE_BYTES = 128 * 1024;
const MAX_NOTES = 3000;
const INVALID = /[<>:"\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizePath(input, folder = false) {
  if (typeof input !== "string" || !input || input.length > 360 ||
      input.startsWith("/") || input.includes("\\") || input.includes("//")) {
    throw problem("Недопустимый путь.");
  }
  const parts = input.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.startsWith(".") ||
        part.endsWith(".") || part.endsWith(" ") || INVALID.test(part) || RESERVED.test(part) ||
        Buffer.byteLength(part, "utf8") > 200) {
      throw problem("Недопустимое имя файла или папки.");
    }
  }
  if (!folder && !/\.md$/i.test(parts[parts.length - 1])) {
    throw problem("Поддерживаются только заметки .md.");
  }
  return parts.join("/");
}

function vault(root) {
  fs.mkdirSync(root, { recursive: true });
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw problem("Папка знаний недоступна.", 500);
  }
  return root;
}

function secureTarget(root, relative, createParents = false) {
  const names = relative.split("/");
  let current = vault(root);
  for (const part of names.slice(0, -1)) {
    current = path.join(current, part);
    if (createParents && !fs.existsSync(current)) fs.mkdirSync(current);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if (error.code === "ENOENT") throw problem("Папка не найдена.", 404);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw problem("Нельзя открывать ссылки или файлы вместо папок.", 400);
    }
  }
  return path.join(current, names[names.length - 1]);
}

function checkedFile(filename) {
  let info;
  try { info = fs.lstatSync(filename); }
  catch (error) {
    if (error.code === "ENOENT") throw problem("Заметка не найдена.", 404);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw problem("Недопустимый тип файла.");
  if (info.size > MAX_NOTE_BYTES) throw problem("Заметка превышает ограничение 128 КБ.", 413);
  return info;
}

function references(content) {
  const links = [];
  const seen = new Set();
  for (const match of content.matchAll(/\[\[([^\]\r\n]{1,250})\]\]/g)) {
    const target = match[1].split("|")[0].split("#")[0].trim().replace(/\.md$/i, "");
    if (target && !seen.has(target)) { seen.add(target); links.push(target); }
  }
  return links;
}

function list(root) {
  vault(root);
  const notes = [], folders = [];
  function visit(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      try { normalizePath(relative, entry.isDirectory()); }
      catch (_) { continue; }
      if (entry.isDirectory()) {
        folders.push(relative);
        visit(path.join(dir, entry.name), relative);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        if (notes.length >= MAX_NOTES) throw problem("В хранилище слишком много заметок.", 413);
        const filename = path.join(dir, entry.name);
        const info = fs.lstatSync(filename);
        if (info.size > MAX_NOTE_BYTES) continue;
        const content = fs.readFileSync(filename, "utf8");
        notes.push({
          path: relative,
          title: entry.name.replace(/\.md$/i, ""),
          folder: prefix,
          bytes: info.size,
          updatedAt: info.mtime.toISOString(),
          excerpt: content.replace(/[#*_\[\]\r\n]/g, " ").slice(0, 180),
          links: references(content)
        });
      }
    }
  }
  visit(root, "");
  notes.sort((a, b) => a.path.localeCompare(b.path, "ru"));
  folders.sort((a, b) => a.localeCompare(b, "ru"));
  return { notes, folders };
}

function read(root, requested) {
  const relative = normalizePath(requested);
  const filename = secureTarget(root, relative);
  checkedFile(filename);
  return { path: relative, content: fs.readFileSync(filename, "utf8") };
}

function save(root, requested, content) {
  const relative = normalizePath(requested);
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_NOTE_BYTES) {
    throw problem("Текст должен быть строкой не длиннее 128 КБ.", 413);
  }
  const filename = secureTarget(root, relative, true);
  if (fs.existsSync(filename)) checkedFile(filename);
  const temporary = path.join(path.dirname(filename), ".amayu-" + crypto.randomUUID() + ".tmp");
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { path: relative, bytes: Buffer.byteLength(content, "utf8"), links: references(content) };
}

function remove(root, requested) {
  const relative = normalizePath(requested);
  const filename = secureTarget(root, relative);
  checkedFile(filename);
  fs.unlinkSync(filename);
  return { deleted: relative };
}

function makeFolder(root, requested) {
  const relative = normalizePath(requested, true);
  const filename = secureTarget(root, relative, true);
  if (fs.existsSync(filename)) {
    if (!fs.lstatSync(filename).isDirectory() || fs.lstatSync(filename).isSymbolicLink()) {
      throw problem("Имя уже используется файлом.");
    }
  } else fs.mkdirSync(filename);
  return { folder: relative };
}

function graph(root) {
  const { notes } = list(root);
  const paths = new Set(notes.map(note => note.path.toLocaleLowerCase("ru")));
  const titles = new Map();
  for (const note of notes) {
    const title = note.title.toLocaleLowerCase("ru");
    if (!titles.has(title)) titles.set(title, []);
    titles.get(title).push(note.path);
  }
  const edges = [], missing = [];
  for (const note of notes) for (const link of note.links) {
    const named = link.toLocaleLowerCase("ru");
    const exact = (link.endsWith(".md") ? link : link + ".md").toLocaleLowerCase("ru");
    const relative = (note.folder ? note.folder + "/" : "") + exact;
    let target = notes.find(item => item.path.toLocaleLowerCase("ru") === exact ||
      item.path.toLocaleLowerCase("ru") === relative);
    if (!target && (titles.get(named) || []).length === 1) {
      const p = titles.get(named)[0];
      target = notes.find(item => item.path === p);
    }
    if (target) edges.push({ from: note.path, to: target.path });
    else missing.push({ from: note.path, target: link });
  }
  return { nodes: notes.map(({ path: p, title, folder }) => ({ path: p, title, folder })), edges, missing };
}

module.exports = { MAX_NOTE_BYTES, normalizePath, references, list, read, save, remove, makeFolder, graph, problem };

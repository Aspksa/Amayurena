"use strict";
(function (root, factory) {
  const value = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = value;
  if (root) root.AmayurenaEditorTools = value;
})(typeof window !== "undefined" ? window : null, function () {
  const MAX_TABS = 12, MAX_RECENT = 20;
  function pathOk(x) {
    return typeof x === "string" && x.length > 0 && x.length <= 360 &&
      !x.startsWith("/") && !x.includes("\\") && !x.includes("..") && /\.md$/i.test(x);
  }
  function uniquePaths(list, limit) {
    return [...new Set((Array.isArray(list) ? list : []).filter(pathOk))].slice(0, limit);
  }
  function workspace(storage) {
    const read = key => {
      try { const v = JSON.parse(storage.getItem("amayu.editor." + key)); return Array.isArray(v) ? v : []; }
      catch (_) { return []; }
    };
    const data = {
      tabs: uniquePaths(read("tabs"), MAX_TABS),
      favorites: uniquePaths(read("favorites"), 1000),
      pinned: uniquePaths(read("pinned"), MAX_TABS),
      recent: uniquePaths(read("recent"), MAX_RECENT)
    };
    const persist = () => {
      for (const [key, value] of Object.entries(data)) {
        try { storage.setItem("amayu.editor." + key, JSON.stringify(value)); } catch (_) { /* optional */ }
      }
    };
    const toggle = (key, path) => {
      if (!pathOk(path)) throw new Error("Недопустимый путь.");
      const index = data[key].indexOf(path);
      if (index >= 0) data[key].splice(index, 1);
      else data[key].unshift(path);
      if (key === "pinned" && data.pinned.length > MAX_TABS) data.pinned.length = MAX_TABS;
      if (key === "favorites" && data.favorites.length > 1000) data.favorites.length = 1000;
      persist();
      return index < 0;
    };
    return {
      state: data,
      open(path) {
        if (!pathOk(path)) throw new Error("Недопустимый путь.");
        if (!data.tabs.includes(path)) {
          if (data.tabs.length >= MAX_TABS) throw new Error("Открыто 12 вкладок. Закройте одну из них.");
          data.tabs.push(path);
        }
        data.recent = [path, ...data.recent.filter(x => x !== path)].slice(0, MAX_RECENT);
        persist();
      },
      close(path) { data.tabs = data.tabs.filter(x => x !== path); persist(); },
      favorite(path) { return toggle("favorites", path); },
      pin(path) { return toggle("pinned", path); },
      changePath(from, to, folder = false) {
        const rename = value => folder ? (value.startsWith(from + "/") ? to + value.slice(from.length) : value) : (value === from ? to : value);
        for (const key of Object.keys(data)) data[key] = [...new Set(data[key].map(rename))];
        persist();
      },
      forget(path) {
        for (const key of ["tabs", "pinned", "favorites", "recent"]) data[key] = data[key].filter(x => x !== path);
        persist();
      },
      reconcile(paths) {
        const existing = new Set(paths);
        for (const key of ["tabs", "pinned", "favorites", "recent"]) data[key] = data[key].filter(x => existing.has(x));
        persist();
      }
    };
  }
  function formatSelection(source, start, end, action) {
    if (typeof source !== "string" || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > source.length) throw new Error("Неверная область текста.");
    const selection = source.slice(start, end);
    const wrap = (a, b = a, fallback = "текст") => ({
      content: source.slice(0, start) + a + (selection || fallback) + b + source.slice(end),
      start: start + a.length, end: start + a.length + (selection || fallback).length
    });
    if (action === "bold") return wrap("**");
    if (action === "italic") return wrap("*");
    if (action === "code") return wrap(String.fromCharCode(96), String.fromCharCode(96), "код");
    if (action === "wikilink") return wrap("[[", "]]", "Название заметки");
    if (action === "link") return wrap("[", "](https://example.com)", "подпись");
    if (["heading", "bullet", "task", "quote"].includes(action)) {
      const prefix = { heading: "## ", bullet: "- ", task: "- [ ] ", quote: "> " }[action];
      const from = source.lastIndexOf("\n", start - 1) + 1;
      const to = end === start ? source.indexOf("\n", end) : source.indexOf("\n", end - 1);
      const lineEnd = to < 0 ? source.length : to;
      const block = source.slice(from, lineEnd);
      const transformed = block.split("\n").map(line => prefix + line).join("\n");
      return { content: source.slice(0, from) + transformed + source.slice(lineEnd),
        start: start + prefix.length, end: end + prefix.length * block.split("\n").length };
    }
    throw new Error("Неизвестная команда форматирования.");
  }
  return { workspace, formatSelection, pathOk };
});

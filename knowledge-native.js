"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AmayurenaNative = api;
})(typeof window !== "undefined" ? window : null, function () {
  const TEMPLATES = Object.freeze({
    blank: "Чистая заметка",
    idea: "Идея",
    project: "Проект",
    task: "Задача",
    research: "Исследование"
  });
  const invalidChars = /[<>:"\\|?*\u0000-\u001f]/;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  function segment(value) {
    if (typeof value !== "string") throw new Error("Введите название.");
    const text = value.trim();
    if (!text || text === "." || text === ".." || text.startsWith(".") ||
        text.endsWith(".") || text.endsWith(" ") || /[\\/]/.test(text) ||
        invalidChars.test(text) || reserved.test(text) ||
        BufferLength(text) > 195) throw new Error("Недопустимое имя. Используйте обычные буквы, цифры, пробелы и дефисы.");
    return text;
  }
  function BufferLength(value) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
    return unescape(encodeURIComponent(value)).length;
  }
  function buildNote(name, folder, template) {
    if (!Object.prototype.hasOwnProperty.call(TEMPLATES, template)) {
      throw new Error("Неизвестный шаблон.");
    }
    if (typeof name !== "string") throw new Error("Введите название.");
    const title = segment(name.trim().replace(/\.md$/i, ""));
    const parts = folder ? folder.split("/").map(segment) : [];
    const filename = title + ".md";
    const filePath = [...parts, filename].join("/");
    if (filePath.length > 360) throw new Error("Слишком длинный путь.");
    const heading = "# " + title + "\n\n";
    const templates = {
      blank: heading,
      idea: "---\ntype: idea\nstatus: Черновик\n---\n" + heading +
        "## Описание идеи\n\n## Почему это важно\n\n## Следующие шаги\n\n- [ ] Первый шаг\n",
      project: "---\ntype: project\nstatus: Планируется\n---\n" + heading +
        "## Цель\n\n## План\n\n- [ ] Первый этап\n\n## Связанные знания\n\n",
      task: "---\ntype: task\nstatus: Открыта\n---\n" + heading +
        "## Что нужно сделать\n\n- [ ] Выполнить задачу\n\n## Результат\n\n",
      research: "---\ntype: research\nstatus: Изучается\n---\n" + heading +
        "## Вопрос\n\n## Источники\n\n## Наблюдения\n\n## Выводы\n\n"
    };
    return { path: filePath, title, content: templates[template] };
  }
  return { TEMPLATES, buildNote };
});
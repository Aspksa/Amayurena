(function () {
  "use strict";
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function inline(parent, source, resolve, open) {
    const pattern = /\[\[([^\]\r\n]{1,250})\]\]|\[([^\]\r\n]{1,120})\]\((https?:\/\/[^\s)]{1,500})\)|\x60([^\x60\n]+)\x60|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g;
    let offset = 0, match;
    while ((match = pattern.exec(source))) {
      if (match.index > offset) parent.append(document.createTextNode(source.slice(offset, match.index)));
      let item;
      if (match[1]) {
        const [target, title] = match[1].split("|");
        const file = resolve(target);
        item = el("button", "knowledge-wikilink" + (file ? "" : " missing"));
        item.type = "button";
        item.textContent = title || target.split("#")[0];
        item.title = file || "Заметка не найдена";
        if (file) item.addEventListener("click", () => open(file));
      } else if (match[2]) {
        item = el("a");
        item.textContent = match[2];
        // Only absolute HTTP(S) links; HTML is never injected into the preview.
        try {
          const url = new URL(match[3]);
          if (url.protocol === "https:" || url.protocol === "http:") {
            item.href = url.href;
            item.target = "_blank";
            item.rel = "noopener noreferrer";
          }
        } catch (_) { /* invalid URL remains plain label */ }
      } else if (match[4]) {
        item = el("code"); item.textContent = match[4];
      } else if (match[5]) {
        item = el("strong"); item.textContent = match[5];
      } else if (match[6]) {
        item = el("del"); item.textContent = match[6];
      } else {
        item = el("em"); item.textContent = match[7];
      }
      parent.append(item);
      offset = pattern.lastIndex;
    }
    if (offset < source.length) parent.append(document.createTextNode(source.slice(offset)));
  }
  function render(container, content, resolve, open) {
    container.replaceChildren();
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    // Display YAML properties in Bases; omit the metadata header from rendered prose.
    if (lines[0] === "---") {
      const close = lines.slice(1, 61).indexOf("---");
      if (close >= 0) i = close + 2;
    }
    while (i < lines.length) {
      const raw = lines[i], trimmed = raw.trim();
      if (!trimmed) { i++; continue; }
      if (/^ {0,3}(\x60{3,}|~{3,})/.test(raw)) {
        const marker = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)/.exec(raw);
        const fence = marker[1][0].repeat(marker[1].length);
        const lang = marker[2].trim().slice(0, 35);
        i++;
        const code = [];
        while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
        if (i < lines.length) i++;
        const pre = el("pre"), inner = el("code");
        if (lang) inner.dataset.language = lang;
        inner.textContent = code.join("\n");
        pre.append(inner); container.append(pre); continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        const h = el("h" + heading[1].length);
        inline(h, heading[2], resolve, open);
        container.append(h); i++; continue;
      }
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { container.append(el("hr")); i++; continue; }
      if (/^>\s?/.test(trimmed)) {
        const quote = el("blockquote");
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          const p = el("p"); inline(p, lines[i].trim().replace(/^>\s?/, ""), resolve, open);
          quote.append(p); i++;
        }
        container.append(quote); continue;
      }
      const tableSep = i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1]) && trimmed.includes("|");
      if (tableSep) {
        const table = el("table"), thead = el("thead"), tr = el("tr");
        function cells(line) { return line.replace(/^\||\|$/g, "").split("|").map(s => s.trim()); }
        for (const value of cells(raw)) { const th = el("th"); inline(th, value, resolve, open); tr.append(th); }
        thead.append(tr); table.append(thead); i += 2;
        const tbody = el("tbody");
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          const row = el("tr");
          for (const value of cells(lines[i])) { const td = el("td"); inline(td, value, resolve, open); row.append(td); }
          tbody.append(row); i++;
        }
        table.append(tbody); container.append(table); continue;
      }
      if (/^(?:[-*+] |\d+[.)] )/.test(trimmed)) {
        const ordered = /^\d+[.)] /.test(trimmed);
        const list = el(ordered ? "ol" : "ul");
        while (i < lines.length && /^(?:[-*+] |\d+[.)] )/.test(lines[i].trim())) {
          const current = lines[i].trim();
          const li = el("li");
          const body = current.replace(/^(?:[-*+] |\d+[.)] )/, "");
          const check = /^\[([ xX])\]\s+/.exec(body);
          if (check) {
            const checkbox = el("input");
            checkbox.type = "checkbox"; checkbox.disabled = true; checkbox.checked = check[1].toLowerCase() === "x";
            li.append(checkbox); inline(li, body.slice(check[0].length), resolve, open);
          } else inline(li, body, resolve, open);
          list.append(li); i++;
        }
        container.append(list); continue;
      }
      const paragraph = el("p");
      let first = true;
      while (i < lines.length && lines[i].trim() &&
        !/^(?:#{1,6}\s|>|\x60{3}|~{3}|[-*+] |\d+[.)] )/.test(lines[i].trim())) {
        if (!first) paragraph.append(el("br"));
        inline(paragraph, lines[i++], resolve, open);
        first = false;
      }
      if (!first) container.append(paragraph);
      else { i++; }
    }
  }
  window.AmayurenaMarkdown = { render };
})();

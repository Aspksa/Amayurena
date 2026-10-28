"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function browserShim() {
  class Node {
    constructor(tag, value = "") {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.listeners = {};
      this.textContent = value;
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  const document = {
    createElement: name => new Node(name),
    createTextNode: text => new Node("#text", text)
  };
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, "..", "knowledge-markdown.js"), "utf8");
  vm.runInNewContext(source, { document, window, URL }, { timeout: 1000 });
  const walk = (parent, result = []) => {
    result.push(parent);
    for (const child of parent.children) walk(child, result);
    return result;
  };
  return { render: window.AmayurenaMarkdown.render, node: () => new Node("root"), walk };
}

test("Markdown preview renders a safe DOM without interpreting raw HTML", () => {
  const { render, node, walk } = browserShim();
  const root = node();
  const markdown = "# Hello\n<script>alert(1)</script>\n\n**bold** and " + String.fromCharCode(96) + "inline" + String.fromCharCode(96);
  render(root, markdown, () => "", () => {});
  const nodes = walk(root);
  assert.ok(nodes.some(n => n.tag === "h1"));
  assert.ok(nodes.some(n => n.tag === "strong" && n.textContent === "bold"));
  assert.ok(nodes.some(n => n.tag === "code" && n.textContent === "inline"));
  assert.equal(nodes.some(n => n.tag === "script"), false);
  assert.ok(nodes.some(n => n.tag === "#text" && n.textContent.includes("<script>")));
});

test("Markdown tables, code, quotes, lists and wiki links are rendered structurally", () => {
  const { render, node, walk } = browserShim();
  const root = node();
  render(root, "---\nstatus: draft\n---\n## Заголовок\n\n| a | b |\n|---|---|\n| x | y |\n\n- [x] Готово\n> Цитата\n\n~~~js\nconst x = 1;\n~~~\n\n[[Тема|Связь]]",
    name => name === "Тема" ? "Тема.md" : "", () => {});
  const nodes = walk(root);
  for (const tag of ["h2", "table", "th", "td", "input", "blockquote", "pre", "button"]) {
    assert.ok(nodes.some(n => n.tag === tag), "missing " + tag);
  }
  assert.ok(nodes.some(n => n.tag === "code" && n.textContent.includes("const x")));
  assert.ok(nodes.some(n => n.tag === "button" && n.textContent === "Связь"));
  assert.equal(nodes.some(n => n.textContent === "status: draft"), false);
});

test("Markdown links cannot generate javascript: href", () => {
  const { render, node, walk } = browserShim();
  const root = node();
  render(root, "[bad](javascript:alert(1)) [good](https://example.com/path)", () => "", () => {});
  const anchors = walk(root).filter(n => n.tag === "a");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, "https://example.com/path");
  assert.equal(anchors[0].rel, "noopener noreferrer");
});

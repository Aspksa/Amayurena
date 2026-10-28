"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const helper=require("../knowledge-document-outline");
test("heading outline preserves levels, Unicode and duplicate slugs",()=>{
 const content="# Привет\n## Введение\nТекст\n### Введение\n# Конец";
 const r=helper.analyze(content);
 assert.deepEqual(r.headings.map(x=>x.level),[1,2,3,1]);
 assert.deepEqual(r.headings.map(x=>x.slug),["привет","введение","введение-2","конец"]);
 assert.equal(r.headings[1].line,2);
 assert.equal(helper.lineOffset(content,4),27);
});
test("code fences do not produce ghost sections",()=>{
 const text="# Real\n"+String.fromCharCode(96).repeat(3)+"md\n# Ignore\n"+String.fromCharCode(96).repeat(3)+"\n## More";
 assert.deepEqual(helper.analyze(text).headings.map(x=>x.title),["Real","More"]);
 assert.equal(helper.analyze("a\nb").headings.length,0);
});
test("scroll mapping clamps and ignores negative/infinite distances",()=>{
 assert.equal(helper.progressToPixels(.5,1000,400),300);
 assert.equal(helper.progressToPixels(-9,800,300),0);
 assert.equal(helper.progressToPixels(50,800,300),500);
 assert.equal(helper.progressToPixels(NaN,800,300),0);
});
test("knowledge workspace has split controls and outline without breaking Canvas/Bases",()=>{
 const h=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
 const js=fs.readFileSync(path.join(__dirname,"..","knowledge.js"),"utf8");
 for(const id of ["knowledge-editor-view-split","knowledge-editor-outline","knowledge-outline-list",
 "knowledge-editor-sync","knowledge-layout-density","knowledge-bases-tab","knowledge-canvas-tab"])
   assert.ok(h.includes('id="'+id+'"'),id);
 assert.match(js,/function renderOutline/);
 assert.match(js,/session|preferences\.v2/);
});

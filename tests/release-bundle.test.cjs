"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawnSync}=require("node:child_process");
const builder=require("../scripts/release-bundle.cjs");
const core=require("../update-core");

test("release includes index.html, every referenced client script and no user data",()=>{
  const files=builder.releaseFiles();
  for(const mandatory of builder.REQUIRED)assert.ok(files.includes(mandatory),mandatory);
  assert.ok(files.includes("knowledge-advanced.js"));
  assert.ok(files.includes("update-ui.js"));
  assert.ok(files.includes("index.html"));
  assert.ok(files.includes("Amayurena-Update.bat"));
  assert.equal(files.some(x=>x.startsWith("data/")||x.startsWith(".updates/")),false);
  assert.equal(files.some(x=>x.startsWith("tests/")||x.startsWith("scripts/")),false);
  assert.equal(files.some(x=>x.includes("\\")),false);
  for(const file of files)assert.equal(core.safePath(file),file);
});

test("release builder refuses missing referenced scripts",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-package-invalid-"));
  try{
    for(const required of builder.REQUIRED)fs.writeFileSync(path.join(root,required),"placeholder");
    fs.writeFileSync(path.join(root,"index.html"),'<script defer src="./missing.js"></script>');
    assert.throws(()=>builder.releaseFiles(root),/отсутствующий файл/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("release builder emits zip whose bytes match every source file",{
  skip:spawnSync("zip",["-v"],{stdio:"ignore"}).status!==0
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-bundle-"));
  try{
    const archive=path.join(dir,"Amayurena-update.zip");
    const built=builder.build(archive);
    const inspected=builder.inspectZip(archive);
    assert.deepEqual(inspected,built);
    const digest=fs.readFileSync(archive+".sha256","utf8");
    assert.ok(digest.includes(built.sha256));
    assert.equal(core.unpack(fs.readFileSync(archive)).get("index.html").equals(
      fs.readFileSync(path.join(__dirname,"..","index.html"))),true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

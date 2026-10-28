"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const core=require("../update-core");
const updater=require("../update-worker");
const {makeZip}=require("./helpers/zip-builder.cjs");
const {createServer}=require("../server");
function fixture(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-updater-"));
 try{return fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const packageFiles=(version="0.18.1")=>[
 {name:"project-version.json",content:Buffer.from(JSON.stringify({version}))},
 {name:"server.js",content:Buffer.from('"use strict";\n// New server\n')},
 {name:"index.html",content:Buffer.from("<!doctype html><title>New version</title>")},
 {name:"Amayurena.bat",content:Buffer.from("@echo off\r\n")},
 {name:"update-worker.js",content:Buffer.from('"use strict";\n')},
 {name:"assets/avatars/example.svg",content:Buffer.from("<svg/>")}
];
function fakeRelease(buffer,tag="v0.18.1"){
 return {tag_name:tag,prerelease:false,draft:false,
  assets:[{name:"Amayurena-update.zip",size:buffer.length,
   digest:"sha256:"+core.sha(buffer),
   browser_download_url:"https://github.com/Aspksa/Amayurena/releases/download/"+tag+"/Amayurena-update.zip"}]};
}
test("version comparisons reject downgrades, prerelease and invalid tags",()=>{
 assert.equal(core.compare("v0.18.2","0.18.0"),1);
 assert.equal(core.compare("v0.18.0","0.18.0"),0);
 assert.equal(core.compare("0.17.99","0.18.0"),-1);
 assert.throws(()=>core.version("v1.2.3-beta"));
 assert.throws(()=>core.version("1.02.3"));
});
test("only an official stable GitHub asset with digest is installable",()=>{
 const zip=makeZip(packageFiles());
 const release=fakeRelease(zip);
 assert.equal(core.releaseAsset(release,"0.18.0").available,true);
 assert.equal(core.releaseAsset(release,"0.18.2").available,false);
 assert.throws(()=>core.releaseAsset({...release,prerelease:true},"0.18.0"));
 assert.throws(()=>core.releaseAsset({...release,assets:[{...release.assets[0],digest:""}]},"0.18.0"));
 assert.throws(()=>core.releaseAsset({...release,assets:[{...release.assets[0],
  browser_download_url:"https://untrusted.example/file.zip"}]},"0.18.0"));
});
test("ZIP extraction verifies required files, checksum, traversal, symlinks and duplicates",()=>{
 const zip=makeZip(packageFiles());
 const files=core.unpack(zip);
 assert.equal(files.get("server.js").toString().includes("New server"),true);
 assert.equal(core.verifyPackage(files,"v0.18.1").version,"0.18.1");
 assert.throws(()=>core.verifyPackage(files,"v0.18.2"));
 assert.throws(()=>core.unpack(makeZip(packageFiles().concat([{name:"../data/secret.js",content:Buffer.from("bad")}]))));
 assert.throws(()=>core.unpack(makeZip(packageFiles().concat([{name:".env",content:Buffer.from("SECRET")}]))));
 assert.throws(()=>core.unpack(makeZip(packageFiles().concat([{name:"server.js",content:Buffer.from("duplicate")}]))));
 const corrupted=Buffer.from(zip);
 const dataAt=30+Buffer.byteLength("project-version.json");
 corrupted[dataAt]^=1;
 assert.throws(()=>core.unpack(corrupted));
});
test("installer backs up and replaces only application files, never user data",()=>fixture(root=>{
 const files=core.unpack(makeZip(packageFiles()));
 fs.mkdirSync(path.join(root,"data","knowledge"),{recursive:true});
 fs.writeFileSync(path.join(root,"data","knowledge","Important.md"),"MY KNOWLEDGE");
 fs.writeFileSync(path.join(root,"server.js"),"OLD SERVER");
 fs.writeFileSync(path.join(root,"project-version.json"),JSON.stringify({version:"0.18.0"}));
 const result=core.install(root,files,"v0.18.1");
 assert.equal(result.installed,true);
 assert.match(fs.readFileSync(path.join(root,"server.js"),"utf8"),/New server/);
 assert.equal(fs.readFileSync(path.join(root,"data","knowledge","Important.md"),"utf8"),"MY KNOWLEDGE");
 assert.equal(fs.readFileSync(path.join(root,".updates","backups",result.backup,"server.js"),"utf8"),"OLD SERVER");
 assert.equal(fs.existsSync(path.join(root,".updates","recovery.json")),false);
}));
test("interrupted update recovery restores originals and removes new files",()=>fixture(root=>{
 const updates=path.join(root,".updates"),backup=path.join(updates,"backups","backup-abc");
 fs.mkdirSync(backup,{recursive:true});
 fs.writeFileSync(path.join(backup,"server.js"),"ORIGINAL");
 fs.writeFileSync(path.join(root,"server.js"),"BROKEN");
 fs.writeFileSync(path.join(root,"extra.js"),"NEW FILE");
 fs.writeFileSync(path.join(updates,"recovery.json"),JSON.stringify({
  tag:"v0.18.1",backup:"backup-abc",files:[
    {name:"server.js",existed:true},{name:"extra.js",existed:false}
  ]
 }));
 const result=core.restore(root);
 assert.equal(result.restored,true);
 assert.equal(fs.readFileSync(path.join(root,"server.js"),"utf8"),"ORIGINAL");
 assert.equal(fs.existsSync(path.join(root,"extra.js")),false);
 assert.equal(core.restore(root).restored,false);
}));
test("download rejects bytes that differ from official release digest",async()=>{
 const zip=makeZip(packageFiles()),asset=core.releaseAsset(fakeRelease(zip),"0.18.0");
 const fake=async()=>({ok:true,status:200,headers:{get:()=>String(zip.length)},
  arrayBuffer:async()=>Buffer.from(zip)});
 assert.equal((await updater.download(asset,fake)).length,zip.length);
 const changed=async()=>({...await fake(),arrayBuffer:async()=>Buffer.from("tampered")});
 await assert.rejects(updater.download(asset,changed),/SHA-256/);
});
test("no GitHub releases is a safe no-update outcome and local update endpoint reports it",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-updater-http-"));
 const stub=async()=>({status:404,ok:false});
 const server=createServer({env:{},knowledgeDirectory:path.join(root,"notes"),updateFetchImpl:stub});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const origin="http://127.0.0.1:"+server.address().port;
  let r=await fetch(origin+"/api/update/check");
  assert.equal(r.status,200);
  assert.equal((await r.json()).available,false);
  r=await fetch(origin+"/api/update/install",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({confirm:"INSTALL_VERIFIED_RELEASE"})});
  assert.equal(r.status,501); // self-install disabled in test process
  r=await fetch(origin+"/update-ui.js");
  assert.equal(r.status,200);
  r=await fetch(origin+"/update-core.js");
  assert.equal(r.status,404);
 }finally{await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});}
});
test("Windows launcher has interrupted-update recovery and release workflow only after tests",()=>{
 const bat=fs.readFileSync(path.join(__dirname,"..","Amayurena.bat"),"utf8");
 const updateBat=fs.readFileSync(path.join(__dirname,"..","Amayurena-Update.bat"),"utf8");
 const workflow=fs.readFileSync(path.join(__dirname,"..",".github/workflows/publish-release.yml"),"utf8");
 assert.match(bat,/recovery\.json/);
 assert.match(updateBat,/update-worker\.js" install/);
 assert.match(workflow,/node --test tests\/\*\.test\.cjs/);
 assert.match(workflow,/gh release create/);
});

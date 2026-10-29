"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const updater = require("../update-core");

const ROOT = path.resolve(__dirname, "..");
const ROOT_FILE = /^[A-Za-z0-9_-]+\.(?:js|css|html|bat|md|json|svg)$/i;
const AVATAR_FILE = /^assets\/avatars\/[A-Za-z0-9_-]+\.(?:webp|avif|svg|png)$/i;
const REQUIRED = ["index.html","server.js","update-worker.js","project-version.json","Amayurena.bat"];

function releaseFiles(root=ROOT) {
  const entries = fs.readdirSync(root, {withFileTypes:true});
  const files = entries.filter(e=>e.isFile() && ROOT_FILE.test(e.name))
    .map(e=>e.name);
  const avatarRoot = path.join(root,"assets","avatars");
  if(fs.existsSync(avatarRoot)){
    for(const name of fs.readdirSync(avatarRoot)){
      const rel = "assets/avatars/" + name;
      if(AVATAR_FILE.test(rel)) files.push(rel);
    }
  }
  for(const file of files){
    const stat=fs.lstatSync(path.join(root,...file.split("/")));
    if(!stat.isFile() || stat.isSymbolicLink())throw Error("Небезопасный файл выпуска: "+file);
    updater.safePath(file);
  }
  for(const file of REQUIRED){
    if(!files.includes(file))throw Error("Отсутствует обязательный файл выпуска: "+file);
  }
  const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
  const referenced=[...html.matchAll(/(?:src|href)="\.\/([A-Za-z0-9_-]+\.(?:js|css))"/g)].map(m=>m[1]);
  for(const file of referenced)if(!files.includes(file))throw Error("HTML ссылается на отсутствующий файл: "+file);
  return files.sort();
}
function inspectZip(filename,root=ROOT) {
  const bytes=fs.readFileSync(filename);
  const contents=updater.unpack(bytes);
  const expected=releaseFiles(root);
  if(contents.size!==expected.length || expected.some(x=>!contents.has(x))){
    const missing=expected.filter(x=>!contents.has(x));
    const extra=[...contents.keys()].filter(x=>!expected.includes(x));
    throw Error("Состав архива не совпадает с приложением: отсутствуют "+
      missing.join(", ")+"; лишние "+extra.join(", "));
  }
  for(const rel of expected){
    const actual=contents.get(rel),original=fs.readFileSync(path.join(root,...rel.split("/")));
    if(!actual.equals(original))throw Error("Файл архива отличается от исходника: "+rel);
  }
  const manifest=JSON.parse(contents.get("project-version.json").toString("utf8"));
  updater.verifyPackage(contents,"v"+manifest.version);
  const digest=crypto.createHash("sha256").update(bytes).digest("hex");
  return {files:expected.length,bytes:bytes.length,sha256:digest,version:manifest.version};
}
function build(filename,root=ROOT) {
  const files=releaseFiles(root);
  const absolute=path.resolve(filename);
  fs.mkdirSync(path.dirname(absolute),{recursive:true});
  if(fs.existsSync(absolute))fs.unlinkSync(absolute);
  execFileSync("zip",["-q","-X","-9",absolute,...files],{cwd:root,timeout:120000});
  const result=inspectZip(absolute,root);
  fs.writeFileSync(absolute+".sha256",result.sha256+"  "+path.relative(process.cwd(),absolute).replace(/\\/g,"/")+"\n");
  return result;
}
if(require.main===module){
  try{
    const verification=process.argv[2]==="--verify";
    const filename=verification?process.argv[3]:process.argv[2];
    if(!filename)throw Error("Укажите путь ZIP.");
    console.log(JSON.stringify(verification?inspectZip(filename):build(filename),null,2));
  }catch(e){console.error("Проверка выпуска: "+e.message);process.exitCode=1;}
}
module.exports={releaseFiles,inspectZip,build,REQUIRED};

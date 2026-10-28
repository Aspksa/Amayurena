"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vault = require("./knowledge-core");
const advanced = require("./knowledge-advanced-core");
const TYPES = ["text", "number", "date", "checkbox", "select", "tags"];
const RESERVED = new Set(["title", "folder", "updatedAt", "__proto__", "prototype", "constructor"]);
const fieldPattern = /^[a-zA-Zа-яА-ЯёЁ][\wа-яА-ЯёЁ-]{0,39}$/;
function problem(message,status=400) { return Object.assign(new Error(message),{status}); }
function dir(root) {
  fs.mkdirSync(root,{recursive:true});
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw problem("Недопустимое хранилище Bases.");
  return root;
}
function configPath(root) {
  const file=path.join(dir(root),"views.json");
  if (fs.existsSync(file)) {
    const stat=fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>64000) throw problem("Настройки Bases повреждены.");
  }
  return file;
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeField(key) {
  if (typeof key!=="string" || !fieldPattern.test(key) || RESERVED.has(key)) throw problem("Недопустимое имя поля.");
  return key;
}
function formatValue(type, value) {
  if (!TYPES.includes(type)) throw problem("Неизвестный тип поля.");
  if (type==="checkbox") {
    if (typeof value!=="boolean") throw problem("Нужен переключатель да/нет.");
    return String(value);
  }
  if (type==="number") {
    if (typeof value!=="number" || !Number.isFinite(value) || Math.abs(value)>1e12) throw problem("Введите конечное число.");
    return String(value);
  }
  if (type==="date") {
    if (typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(value)) || new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value)
      throw problem("Дата должна иметь формат ГГГГ-ММ-ДД.");
    return value;
  }
  if (type==="tags") {
    if (!Array.isArray(value) || value.length>15 || value.some(x=>
      typeof x!=="string" || !x.trim() || x.length>40 || /[\r\n,\[\]#]/.test(x))) throw problem("Неверный список меток.");
    return "["+value.map(x=>x.trim()).join(", ")+"]";
  }
  if (typeof value!=="string" || value.length>200 || /[\r\n\u0000-\u001f]/.test(value)) throw problem("Неверный текст поля.");
  if (type==="select" && !value.trim()) throw problem("Выберите непустое значение.");
  return JSON.stringify(value);
}
function frontmatterEdit(content, key, formatted) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const text=content.replace(/\r\n/g,"\n");
  const lines=text.split("\n");
  let result;
  if (lines[0]==="---") {
    const end=lines.slice(1,61).indexOf("---")+1;
    if (!end) throw problem("Не удалось найти закрывающий раздел свойств (---).");
    const header=lines.slice(1,end);
    const matches=header.map((line,i)=>line.startsWith(key+":")?i:-1).filter(i=>i>=0);
    if (matches.length>1) throw problem("Повторяющееся поле в заметке.");
    if (matches.length) header[matches[0]]=key+": "+formatted;
    else {
      if (header.length>=58) throw problem("Превышен размер заголовка свойств.");
      header.push(key+": "+formatted);
    }
    result=["---",...header,"---",...lines.slice(end+1)].join("\n");
  } else result=["---",key+": "+formatted,"---",...lines].join("\n");
  return newline==="\r\n" ? result.replace(/\n/g,"\r\n") : result;
}
function patchProperty(noteRoot, historyRoot, notePath, key, type, value, expectedSha) {
  safeField(key);
  if (typeof expectedSha!=="string" || !/^[a-f0-9]{64}$/.test(expectedSha)) throw problem("Не задана версия заметки.");
  const current=vault.read(noteRoot,notePath);
  if (digest(current.content)!==expectedSha) throw problem("Заметка изменилась. Обновите таблицу перед записью.",409);
  const formatted=formatValue(type,value);
  const next=frontmatterEdit(current.content,key,formatted);
  const result=advanced.saveNote(noteRoot,historyRoot,notePath,next);
  return {path:result.path,sha:digest(next),key,type,value,unchanged:!!result.unchanged};
}
function defaults(){return {types:{},views:[]};}
function validateSettings(data) {
  if (!data || typeof data!=="object" || Array.isArray(data) || !data.types || typeof data.types!=="object" ||
      Array.isArray(data.types) || !Array.isArray(data.views) || data.views.length>30) throw problem("Неверные настройки Bases.");
  const types=Object.create(null);
  if (Object.keys(data.types).length>50) throw problem("Слишком много полей.");
  for (const [key,value] of Object.entries(data.types)) {
    safeField(key);
    if (!TYPES.includes(value)) throw problem("Неизвестный тип поля.");
    types[key]=value;
  }
  const ids=new Set(), views=[];
  for (const view of data.views) {
    if (!view || typeof view!=="object" || typeof view.id!=="string" ||
        !/^[a-z0-9-]{1,50}$/.test(view.id) || ids.has(view.id) ||
        typeof view.name!=="string" || !view.name.trim() || view.name.length>65 ||
        !["table","cards"].includes(view.layout) ||
        !["asc","desc"].includes(view.direction) ||
        typeof view.sort!=="string" || view.sort.length>40 ||
        typeof view.group!=="string" || view.group.length>40 ||
        typeof view.filterField!=="string" || view.filterField.length>40 ||
        typeof view.filterValue!=="string" || view.filterValue.length>120) throw problem("Неверный сохранённый вид.");
    for (const name of [view.sort,view.group,view.filterField]) if (name && !RESERVED.has(name)) safeField(name);
    ids.add(view.id);
    views.push({id:view.id,name:view.name.trim(),layout:view.layout,sort:view.sort,
      direction:view.direction,group:view.group,filterField:view.filterField,filterValue:view.filterValue});
  }
  return {types,views};
}
function loadSettings(root) {
  const file=configPath(root);
  if (!fs.existsSync(file)) return {...defaults(),sha:digest(JSON.stringify(defaults()))};
  const raw=fs.readFileSync(file,"utf8");
  const next=validateSettings(JSON.parse(raw));
  return {...next,sha:digest(raw)};
}
function saveSettings(root,payload,expectedSha) {
  const existing=loadSettings(root);
  if (existing.sha!==expectedSha) throw problem("Настройки были изменены. Обновите страницу.",409);
  const validated=validateSettings(payload);
  const filename=configPath(root),raw=JSON.stringify(validated,null,2);
  if (Buffer.byteLength(raw,"utf8")>64000) throw problem("Слишком большие настройки.");
  const tmp=filename+"."+crypto.randomUUID()+".tmp";
  try {
    fs.writeFileSync(tmp,raw,{flag:"wx",mode:0o600});
    fs.renameSync(tmp,filename);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return {...validated,sha:digest(raw)};
}
module.exports={TYPES,digest,safeField,formatValue,frontmatterEdit,patchProperty,
  validateSettings,loadSettings,saveSettings};

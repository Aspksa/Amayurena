"use strict";

// Intentionally accepts only the ten fixed kitune pose filenames; no general-purpose extraction.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");

const MAX_ARCHIVE = 12 * 1024 * 1024;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 30 * 1024 * 1024;
const POSE_NAMES = Object.freeze(Array.from({ length: 10 }, (_, index) =>
  "pose-" + String(index + 1).padStart(2, "0") + ".webp"
));
const ALLOWED = new Set(POSE_NAMES.map(name => "assets/avatars/" + name));
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}
function ensure(condition, message) { if (!condition) fail(message); }
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function validWebp(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 16 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.readUInt32LE(4) + 8 === buffer.length &&
    buffer.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16));
}
function unpackAvatarZip(archive) {
  ensure(Buffer.isBuffer(archive) && archive.length >= 22, "Некорректный ZIP.");
  ensure(archive.length <= MAX_ARCHIVE, "ZIP превышает 12 МБ.");
  const min = Math.max(0, archive.length - 65557);
  let eocd = -1;
  for (let i = archive.length - 22; i >= min; i--) {
    if (archive.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + archive.readUInt16LE(i + 20) === archive.length) { eocd = i; break; }
  }
  ensure(eocd >= 0, "Не найден конец ZIP.");
  const disk = archive.readUInt16LE(eocd + 4), diskCD = archive.readUInt16LE(eocd + 6);
  const countDisk = archive.readUInt16LE(eocd + 8), count = archive.readUInt16LE(eocd + 10);
  const cdSize = archive.readUInt32LE(eocd + 12), cdOffset = archive.readUInt32LE(eocd + 16);
  ensure(disk === 0 && diskCD === 0 && countDisk === count, "Многотомные ZIP не поддерживаются.");
  ensure(count >= 10 && count <= 11 && cdOffset + cdSize === eocd, "ZIP должен содержать ровно 10 поз и необязательный README.");
  const output = new Map();
  let total = 0, cursor = cdOffset;
  for (let i = 0; i < count; i++) {
    ensure(cursor + 46 <= eocd && archive.readUInt32LE(cursor) === 0x02014b50, "Повреждён каталог ZIP.");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLen = archive.readUInt16LE(cursor + 28);
    const extraLen = archive.readUInt16LE(cursor + 30);
    const commentLen = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLen + extraLen + commentLen;
    ensure(end <= eocd, "Повреждены метаданные ZIP.");
    const name = archive.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    cursor = end;
    ensure((flags & 1) === 0 && (flags & 0x40) === 0, "Зашифрованные ZIP не поддерживаются.");
    ensure(method === 0 || method === 8, "Неподдерживаемое сжатие ZIP.");
    ensure(ALLOWED.has(name) || name === "READ_ME.txt", "ZIP содержит недопустимые файлы.");
    ensure(compressedSize <= MAX_FILE && uncompressedSize <= MAX_FILE, "Изображение слишком большое.");
    ensure(offset + 30 <= cdOffset && archive.readUInt32LE(offset) === 0x04034b50, "Повреждён заголовок файла.");
    const localNameLen = archive.readUInt16LE(offset + 26);
    const localExtraLen = archive.readUInt16LE(offset + 28);
    const localName = archive.toString("utf8", offset + 30, offset + 30 + localNameLen);
    ensure(localName === name && archive.readUInt16LE(offset + 8) === method, "Имя файла ZIP не совпадает.");
    const start = offset + 30 + localNameLen + localExtraLen;
    ensure(start + compressedSize <= cdOffset, "ZIP содержит повреждённый файл.");
    const compressed = archive.subarray(start, start + compressedSize);
    let decoded;
    try {
      decoded = method === 8
        ? zlib.inflateRawSync(compressed, { maxOutputLength: MAX_FILE })
        : Buffer.from(compressed);
    } catch (_) { fail("Повреждены сжатые данные ZIP."); }
    ensure(decoded.length === uncompressedSize && crc32(decoded) === crc, "Контрольная сумма файла не совпадает.");
    if (ALLOWED.has(name)) {
      const basename = name.split("/").at(-1);
      ensure(!output.has(basename), "Повторяющееся изображение.");
      ensure(validWebp(decoded), "Изображение не является корректным WebP.");
      total += decoded.length;
      ensure(total <= MAX_TOTAL, "ZIP содержит слишком много данных.");
      output.set(basename, decoded);
    }
  }
  ensure(cursor === eocd, "Лишние данные в каталоге ZIP.");
  ensure(output.size === POSE_NAMES.length, "Не хватает изображений: нужны все 10 поз.");
  for (const name of POSE_NAMES) ensure(output.has(name), "Отсутствует " + name);
  return output;
}

function installAvatarZip(archive, rootDir) {
  const images = unpackAvatarZip(archive);
  const root = path.resolve(rootDir);
  const destination = path.join(root, "assets", "avatars");
  fs.mkdirSync(destination, { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, ".amayurena-avatar-"));
  const completed = [];
  const backedUp = [];
  try {
    for (const [name, buffer] of images) fs.writeFileSync(path.join(temp, name), buffer, { flag: "wx" });
    for (const name of POSE_NAMES) {
      const target = path.join(destination, name);
      if (fs.existsSync(target)) {
        fs.renameSync(target, path.join(temp, "backup-" + name));
        backedUp.push(name);
      }
      fs.renameSync(path.join(temp, name), target);
      completed.push(name);
    }
    return { installed: POSE_NAMES.length, directory: "assets/avatars" };
  } catch (error) {
    for (const name of completed) {
      try { fs.unlinkSync(path.join(destination, name)); } catch (_) {}
    }
    for (const name of backedUp) {
      try { fs.renameSync(path.join(temp, "backup-" + name), path.join(destination, name)); } catch (_) {}
    }
    throw error;
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {}
  }
}
module.exports = { POSE_NAMES, MAX_ARCHIVE, crc32, validWebp, unpackAvatarZip, installAvatarZip };

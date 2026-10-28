"use strict";
const zlib = require("node:zlib");
const { crc32, POSE_NAMES } = require("../../avatar-package");

function fakeWebp(marker = 0) {
  const result = Buffer.alloc(20);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(12, 4);
  result.write("WEBPVP8X", 8, "ascii");
  result.writeUInt32LE(marker >>> 0, 16);
  return result;
}
function makeZip(entries = POSE_NAMES.map((name, index) => ({
  name: "assets/avatars/" + name, content: fakeWebp(index)
}))) {
  const files = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const original = entry.content;
    const method = entry.method === 0 ? 0 : 8;
    const compressed = method === 8 ? zlib.deflateRawSync(original) : original;
    const crc = crc32(original);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(original.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    directory.push(cd, name);
    offset += local.length + name.length + compressed.length;
  }
  const directoryBuffer = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directoryBuffer, end]);
}
module.exports = { makeZip, fakeWebp };

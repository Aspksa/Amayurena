"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  POSE_NAMES, unpackAvatarZip, installAvatarZip, validWebp
} = require("../avatar-package");
const { makeZip, fakeWebp } = require("./helpers/zip-builder.cjs");

test("extracts exactly ten validated WebP images from deflated ZIP", () => {
  const images = unpackAvatarZip(makeZip());
  assert.equal(images.size, 10);
  for (const name of POSE_NAMES) assert.equal(validWebp(images.get(name)), true);
});
test("supports optional README in user image archive", () => {
  const entries = POSE_NAMES.map((name, i) => ({ name: "assets/avatars/" + name, content: fakeWebp(i) }));
  entries.push({ name: "READ_ME.txt", content: Buffer.from("Installation instructions") });
  assert.equal(unpackAvatarZip(makeZip(entries)).size, 10);
});
test("rejects unexpected paths, duplicates and missing poses", () => {
  const entries = POSE_NAMES.map((name, i) => ({ name: "assets/avatars/" + name, content: fakeWebp(i) }));
  for (const wrong of ["../server.js", "assets/avatars/pose-11.webp", "assets/avatars/../../.env"]) {
    const altered = entries.map(x => ({ ...x }));
    altered[0].name = wrong;
    assert.throws(() => unpackAvatarZip(makeZip(altered)), /недопустимые/);
  }
  const duplicate = entries.map(x => ({ ...x }));
  duplicate[9].name = duplicate[0].name;
  assert.throws(() => unpackAvatarZip(makeZip(duplicate)), /Повторяющееся/);
  assert.throws(() => unpackAvatarZip(makeZip(entries.slice(0, 9))), /ровно 10/);
});
test("rejects corrupted CRC and image magic", () => {
  const archive = makeZip();
  archive[40] ^= 0xff;
  assert.throws(() => unpackAvatarZip(archive), /поврежден|сумма|ZIP/i);
  const entries = POSE_NAMES.map(name => ({ name: "assets/avatars/" + name, content: fakeWebp(2) }));
  entries[3].content = Buffer.alloc(20);
  assert.throws(() => unpackAvatarZip(makeZip(entries)), /WebP/);
});
test("installs ten images into local project and replaces previous files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amayurena-zip-test-"));
  try {
    const directory = path.join(root, "assets", "avatars");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "pose-01.webp"), Buffer.from("old"));
    assert.deepEqual(installAvatarZip(makeZip(), root),
      { installed: 10, directory: "assets/avatars" });
    for (const name of POSE_NAMES) assert.equal(validWebp(fs.readFileSync(path.join(directory, name))), true);
    assert.notEqual(fs.readFileSync(path.join(directory, "pose-01.webp")).toString(), "old");
    assert.deepEqual(fs.readdirSync(root).sort(), ["assets"]);
    const untouched = fs.readFileSync(path.join(directory, "pose-01.webp"));
    assert.throws(() => installAvatarZip(Buffer.from("not zip"), root));
    assert.deepEqual(fs.readFileSync(path.join(directory, "pose-01.webp")), untouched);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

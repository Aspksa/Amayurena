"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadAvatar(overrides = {}) {
  const window = {};
  const context = {
    window,
    document: { readyState: "loading", addEventListener() {} },
    localStorage: { getItem: () => null },
    ...overrides
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "avatar.js"), "utf8"), context,
    { filename: "avatar.js" });
  return window.AmayurenaAvatar;
}
test("avatar has ten named poses", () => {
  const api = loadAvatar();
  assert.equal(api.poses.length, 10);
  assert.equal(api.poses[0][1], "pose-01");
  assert.equal(api.poses[9][1], "pose-10");
});
test("avatar state defaults to safe settings", () => {
  const state = loadAvatar().validate(null);
  assert.equal(state.pose, 0);
  assert.equal(state.hidden, false);
  assert.equal(state.animation, "breathe");
});
test("invalid persisted state cannot inject effects or animation names", () => {
  const state = loadAvatar().validate({
    pose: 100, animation: "javascript:alert(1)",
    effects: ["glow", "evil", "sparkles"],
    size: 20000, position: { x: "x", y: 10 }
  });
  assert.equal(state.pose, 0);
  assert.equal(state.size, 350);
  assert.equal(state.animation, "breathe");
  assert.deepEqual(Array.from(state.effects), ["glow", "sparkles"]);
  assert.equal(state.position, null);
});
test("avatar settings retain valid animation, size, and position", () => {
  const state = loadAvatar().validate({
    pose: 8, size: 195, animation: "bow", effects: ["halo"],
    position: { x: 400, y: 120 }, hidden: true
  });
  assert.equal(state.pose, 8);
  assert.equal(state.animation, "bow");
  assert.equal(state.hidden, true);
  assert.equal(state.position.x, 400);
});
test("image asset paths are constrained and imports require supported formats", async () => {
  const window = {};
  const context = { window, localStorage: { getItem: () => null } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "avatar-assets.js"), "utf8"), context);
  assert.equal(window.AmayurenaAvatarAssets.length, 10);
  assert.match(window.AmayurenaAvatarAssets[0], /pose-01\.webp/);
  await assert.rejects(() => window.AmayurenaAvatarAssetsApi.importImage(
    { type: "text/html", size: 40 }, 0), /PNG/);
});

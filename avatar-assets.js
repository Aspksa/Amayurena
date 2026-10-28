(function () {
  "use strict";
  const KEY = "amayurena.avatar-images.v1";
  const fallback = "./avatar-default.svg";
  const paths = Array.from({ length: 10 }, (_, i) => "./assets/avatars/pose-" + String(i + 1).padStart(2, "0") + ".webp");
  let saved = {};
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) saved = value;
  } catch (_) { /* Storage can be blocked: built-in fallback still works. */ }
  function isValidDataUrl(url) {
    return typeof url === "string" && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(url) && url.length < 1200000;
  }
  const assets = paths.map((path, i) => isValidDataUrl(saved[i]) ? saved[i] : path);
  function fallbackToPlaceholder(element) {
    element.onerror = null;
    element.src = fallback;
  }
  function ensureImage(element, index) {
    element.onerror = () => fallbackToPlaceholder(element);
    element.src = assets[index] || fallback;
  }
  async function importImage(file, index) {
    if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 12 * 1024 * 1024) {
      throw new Error("Допустимы PNG, JPEG или WebP размером до 12 МБ.");
    }
    if (!Number.isInteger(index) || index < 0 || index >= 10) throw new Error("Некорректная позиция.");
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      const side = 720;
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Не удалось подготовить изображение.");
      const scale = Math.min(side / bitmap.width, side / bitmap.height);
      const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
      ctx.clearRect(0, 0, side, side);
      ctx.drawImage(bitmap, Math.round((side-w)/2), Math.round((side-h)/2), w, h);
      const data = canvas.toDataURL("image/webp", 0.77);
      if (!isValidDataUrl(data)) throw new Error("Изображение слишком большое.");
      const next = { ...saved, [index]: data };
      try { localStorage.setItem(KEY, JSON.stringify(next)); }
      catch (_) { throw new Error("Недостаточно места в хранилище браузера. Сохраните изображения в папке assets/avatars."); }
      saved = next;
      assets[index] = data;
    } finally { bitmap.close(); }
  }
  function reloadInstalled() {
    saved = {};
    try { localStorage.removeItem(KEY); } catch (_) {}
    const now = Date.now();
    for (let i = 0; i < assets.length; i++) assets[i] = paths[i] + "?updated=" + now;
  }
  window.AmayurenaAvatarAssets = assets;
  window.AmayurenaAvatarAssetsApi = { importImage, ensureImage, reloadInstalled, fallback, paths };
})();

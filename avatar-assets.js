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
  // Eight unique frames correspond to ten selectable poses; 6 repeats 1, 7 repeats 5.
  // This compact atlas is bundled with the app. If full-size WebP is installed later,
  // the full-size image takes precedence. Browser-specific uploads take highest priority.
  const atlasMap = Object.freeze([0, 1, 2, 3, 4, 0, 4, 5, 6, 7]);
  const spriteUrl = "./assets/avatars/sprite.avif";
  const frameSize = 192;
  let spritePromise = null;

  function loadEmbeddedPoses() {
    if (spritePromise) return spritePromise;
    spritePromise = new Promise((resolve, reject) => {
      const atlas = new Image();
      atlas.onload = () => {
        try {
          if (atlas.naturalWidth !== frameSize * 4 || atlas.naturalHeight !== frameSize * 2) {
            throw new Error("Неверный размер встроенного набора аватаров.");
          }
          const canvas = document.createElement("canvas");
          canvas.width = frameSize;
          canvas.height = frameSize;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Не удалось отобразить встроенные изображения.");
          const frames = [];
          for (let i = 0; i < 10; i++) {
            const cell = atlasMap[i];
            ctx.clearRect(0, 0, frameSize, frameSize);
            ctx.drawImage(atlas, (cell % 4) * frameSize, Math.floor(cell / 4) * frameSize,
              frameSize, frameSize, 0, 0, frameSize, frameSize);
            frames.push(canvas.toDataURL("image/png"));
          }
          resolve(frames);
        } catch (error) { reject(error); }
      };
      atlas.onerror = () => reject(new Error("Встроенный набор изображений недоступен."));
      atlas.src = spriteUrl;
    });
    return spritePromise;
  }

  function fallbackToPlaceholder(element) {
    element.onerror = null;
    element.src = fallback;
  }
  function ensureImage(element, index) {
    const path = assets[index] || fallback;
    element.onerror = () => {
      element.onerror = null;
      loadEmbeddedPoses().then(frames => {
        if (element.getAttribute("src") !== path) return; // Selection changed while loading.
        element.onerror = () => fallbackToPlaceholder(element);
        element.src = frames[index] || fallback;
      }).catch(() => {
        if (element.getAttribute("src") === path) fallbackToPlaceholder(element);
      });
    };
    element.src = path;
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
  window.AmayurenaAvatarAssetsApi = { importImage, ensureImage, reloadInstalled, loadEmbeddedPoses, fallback, paths, spriteUrl };
})();

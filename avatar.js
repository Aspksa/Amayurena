(function () {
  "use strict";

  const STORAGE_KEY = "amayurena.avatar.v1";
  const AVATARS = Object.freeze([
    ["Сидит", "pose-01"], ["Протягивает руки", "pose-02"],
    ["Приглашает", "pose-03"], ["Поклон в сторону", "pose-04"],
    ["Глубокий поклон", "pose-05"], ["Сидит спокойно", "pose-06"],
    ["Поклон", "pose-07"], ["Смущается", "pose-08"],
    ["Подмигивает", "pose-09"], ["Танцует", "pose-10"]
  ]);
  const EFFECTS = Object.freeze(["glow", "sparkles", "halo"]);
  const ANIMATIONS = Object.freeze(["none", "breathe", "float", "bow", "wave"]);
  const LABELS = {
    glow: "Золотое сияние", sparkles: "Искры", halo: "Мягкая аура",
    none: "Без анимации", breathe: "Дыхание", float: "Плавное движение",
    bow: "Поклон", wave: "Приветствие"
  };
  const defaults = () => ({
    pose: 0, size: 225, effects: ["glow"], animation: "breathe",
    hidden: false, position: null
  });
  function validate(raw) {
    const result = defaults();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
    if (Number.isInteger(raw.pose) && raw.pose >= 0 && raw.pose < AVATARS.length) result.pose = raw.pose;
    if (Number.isFinite(raw.size)) result.size = Math.max(110, Math.min(350, Math.round(raw.size)));
    if (Array.isArray(raw.effects)) result.effects = EFFECTS.filter(x => raw.effects.includes(x));
    if (ANIMATIONS.includes(raw.animation)) result.animation = raw.animation;
    result.hidden = raw.hidden === true;
    if (raw.position && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y)) {
      result.position = { x: raw.position.x, y: raw.position.y };
    }
    return result;
  }
  function load() {
    try { return validate(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
    catch (_) { return defaults(); }
  }
  let state = load();
  let draft = validate(state);
  let dragging = null;
  let suppressClick = false;
  let menu = null;
  let contextMenu = null;
  let dialog = null;
  let trigger = null;
  let image = null;
  let resizeObserver = null;
  let lastFocus = null;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(label, handler, className) {
    const el = node("button", className || "am-menu-button", label);
    el.type = "button";
    el.addEventListener("click", handler);
    return el;
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (_) { showMessage("Не удалось сохранить настройки аватара."); }
  }
  function showMessage(message) {
    const status = document.getElementById("am-avatar-status");
    if (status) status.textContent = message;
  }
  function hideMenus() {
    menu.hidden = true;
    contextMenu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }
  function clampPosition() {
    const width = trigger.offsetWidth || state.size;
    const height = trigger.offsetHeight || state.size;
    const defaultPosition = {
      x: Math.max(0, window.innerWidth - width - 24),
      y: Math.max(0, window.innerHeight - height - 24)
    };
    const pos = state.position || defaultPosition;
    const clamped = {
      x: Math.max(0, Math.min(Math.round(pos.x), Math.max(0, window.innerWidth - width))),
      y: Math.max(0, Math.min(Math.round(pos.y), Math.max(0, window.innerHeight - height)))
    };
    trigger.style.left = clamped.x + "px";
    trigger.style.top = clamped.y + "px";
    return clamped;
  }
  function render() {
    const selected = AVATARS[state.pose];
    const assets = window.AmayurenaAvatarAssets || [];
    image.src = typeof assets[state.pose] === "string" ? assets[state.pose] : "";
    image.alt = "Амаюрэна — " + selected[0];
    trigger.title = "Амаюрэна: левый клик — меню, правый — настройки; перетащите для перемещения";
    trigger.setAttribute("aria-label", "Амаюрэна. Открыть быстрое меню");
    trigger.style.width = state.size + "px";
    trigger.style.height = state.size + "px";
    trigger.className = "am-avatar-trigger am-anim-" + state.animation;
    for (const effect of EFFECTS) trigger.classList.toggle("am-effect-" + effect, state.effects.includes(effect));
    trigger.hidden = state.hidden;
    const restore = document.getElementById("am-avatar-restore");
    if (restore) restore.hidden = !state.hidden;
    requestAnimationFrame(clampPosition);
    if (!menu.hidden || !contextMenu.hidden) alignMenus();
  }
  function alignPopup(popup, x, y) {
    popup.hidden = false;
    const rect = popup.getBoundingClientRect();
    popup.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
    popup.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
  }
  function alignMenus() {
    const rect = trigger.getBoundingClientRect();
    if (!menu.hidden) alignPopup(menu, rect.left - 14, rect.top - 12);
    if (!contextMenu.hidden) alignPopup(contextMenu, rect.left - 14, rect.top - 12);
  }
  function openMenu() {
    const wasVisible = !menu.hidden;
    hideMenus();
    if (!wasVisible) {
      const rect = trigger.getBoundingClientRect();
      alignPopup(menu, rect.left - 210, rect.top + 15);
      trigger.setAttribute("aria-expanded", "true");
    }
  }
  function openContext(event) {
    event.preventDefault();
    hideMenus();
    alignPopup(contextMenu, event.clientX, event.clientY);
    contextMenu.querySelector("button").focus();
  }
  function navigateTo(page) {
    hideMenus();
    window.location.hash = page;
    window.dispatchEvent(new CustomEvent("amayurena:avatar-action", { detail: { action: page } }));
  }
  function openSettings(tab) {
    hideMenus();
    draft = validate(state);
    buildSettings();
    selectTab(tab || "avatars");
    lastFocus = document.activeElement;
    dialog.showModal();
  }
  function selectTab(tab) {
    const tabs = dialog.querySelectorAll("[data-am-tab]");
    const panels = dialog.querySelectorAll("[data-am-panel]");
    tabs.forEach(t => {
      const active = t.dataset.amTab === tab;
      t.setAttribute("aria-selected", String(active));
      t.tabIndex = active ? 0 : -1;
    });
    panels.forEach(p => { p.hidden = p.dataset.amPanel !== tab; });
  }
  function preview() {
    const assets = window.AmayurenaAvatarAssets || [];
    const p = document.getElementById("am-avatar-preview-img");
    p.src = assets[draft.pose] || "";
    p.alt = AVATARS[draft.pose][0];
    const frame = document.getElementById("am-avatar-preview");
    frame.className = "am-settings-preview am-anim-" + draft.animation;
    for (const effect of EFFECTS) frame.classList.toggle("am-effect-" + effect, draft.effects.includes(effect));
    dialog.querySelectorAll("[data-am-pose]").forEach(el => {
      el.setAttribute("aria-pressed", String(Number(el.dataset.amPose) === draft.pose));
    });
  }
  function buildSettings() {
    const gallery = document.getElementById("am-avatar-gallery");
    gallery.replaceChildren();
    const assets = window.AmayurenaAvatarAssets || [];
    AVATARS.forEach(([label], i) => {
      const item = button("", () => { draft.pose = i; preview(); }, "am-pose-option");
      item.dataset.amPose = String(i);
      item.setAttribute("aria-label", "Выбрать: " + label);
      const thumbnail = node("img");
      thumbnail.src = assets[i] || "";
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      item.append(thumbnail, node("span", "", label));
      gallery.append(item);
    });
    const effectList = document.getElementById("am-avatar-effects");
    effectList.replaceChildren();
    EFFECTS.forEach(effect => {
      const label = node("label", "am-check");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = draft.effects.includes(effect);
      checkbox.addEventListener("change", () => {
        draft.effects = checkbox.checked ? [...draft.effects, effect] : draft.effects.filter(x => x !== effect);
        preview();
      });
      label.append(checkbox, node("span", "", LABELS[effect]));
      effectList.append(label);
    });
    const animationList = document.getElementById("am-avatar-animations");
    animationList.replaceChildren();
    ANIMATIONS.forEach(animation => {
      const label = node("label", "am-check");
      const radio = node("input");
      radio.type = "radio";
      radio.name = "am-avatar-animation";
      radio.checked = draft.animation === animation;
      radio.addEventListener("change", () => { draft.animation = animation; preview(); });
      label.append(radio, node("span", "", LABELS[animation]));
      animationList.append(label);
    });
    const size = document.getElementById("am-avatar-size");
    size.value = String(draft.size);
    document.getElementById("am-avatar-size-value").textContent = draft.size + " px";
    size.oninput = () => {
      draft.size = Number(size.value);
      document.getElementById("am-avatar-size-value").textContent = draft.size + " px";
    };
    preview();
  }
  function createSettings() {
    dialog = node("dialog", "am-avatar-dialog");
    dialog.id = "am-avatar-settings";
    dialog.setAttribute("aria-labelledby", "am-avatar-settings-title");
    const header = node("header", "am-dialog-header");
    header.append(node("h2", "", "Настройки аватара"),
      button("×", () => dialog.close(), "am-close"));
    header.querySelector("h2").id = "am-avatar-settings-title";
    header.querySelector("button").setAttribute("aria-label", "Закрыть настройки");
    const tabs = node("div", "am-settings-tabs");
    for (const [key, text] of [["avatars", "Выбор аватара"], ["effects", "Эффекты"], ["animation", "Анимация"]]) {
      const tab = button(text, () => selectTab(key), "am-settings-tab");
      tab.dataset.amTab = key;
      tab.setAttribute("role", "tab");
      tabs.append(tab);
    }
    tabs.setAttribute("role", "tablist");
    const body = node("div", "am-dialog-body");
    const left = node("div", "am-dialog-left");
    for (const [key, contentId] of [["avatars", "am-avatar-gallery"], ["effects", "am-avatar-effects"], ["animation", "am-avatar-animations"]]) {
      const panel = node("div", "am-settings-panel");
      panel.dataset.amPanel = key;
      const inner = node("div", key === "avatars" ? "am-avatar-gallery" : "am-option-list");
      inner.id = contentId;
      panel.append(inner);
      if (key === "avatars") {
        const sizeLabel = node("label", "am-size-label", "Размер аватара");
        const sizeOutput = node("output", "", "");
        sizeOutput.id = "am-avatar-size-value";
        const size = node("input"); size.type = "range"; size.min = "110"; size.max = "350"; size.step = "5";
        size.id = "am-avatar-size";
        sizeLabel.append(sizeOutput, size);
        panel.append(sizeLabel);
      }
      left.append(panel);
    }
    const right = node("div", "am-dialog-right");
    right.append(node("h3", "", "Предпросмотр"));
    const frame = node("div", "am-settings-preview");
    frame.id = "am-avatar-preview";
    const previewImage = node("img");
    previewImage.id = "am-avatar-preview-img";
    frame.append(previewImage);
    right.append(frame, node("p", "am-help-text",
      "Анимация создаётся CSS-эффектами. Исходные изображения не изменяются."));
    body.append(left, right);
    const footer = node("footer", "am-dialog-footer");
    footer.append(button("Отмена", () => dialog.close(), "am-secondary"),
      button("Применить", () => {
        state = validate(draft); save(); render(); dialog.close();
      }, "am-primary"));
    dialog.append(header, tabs, body, footer);
    dialog.addEventListener("close", () => { if (lastFocus?.isConnected) lastFocus.focus(); });
    document.body.append(dialog);
  }
  function initialize() {
    if (document.getElementById("am-avatar-trigger")) return;
    trigger = button("", openMenu, "am-avatar-trigger");
    trigger.id = "am-avatar-trigger";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    image = node("img", "am-avatar-image");
    image.draggable = false;
    trigger.append(image, node("span", "am-avatar-shine"));
    const status = node("span", "am-sr-only", "");
    status.id = "am-avatar-status";
    status.setAttribute("role", "status");
    trigger.append(status);
    document.body.append(trigger);

    menu = node("div", "am-avatar-popup am-quick-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.append(node("div", "am-menu-title", "Амаюрэна"));
    menu.append(button("Чат с агентом", () => navigateTo("agents-chat")),
      button("Агенты", () => navigateTo("agents")),
      button("Главная", () => navigateTo("home")),
      button("Настройки аватара", () => openSettings("avatars")));
    document.body.append(menu);

    contextMenu = node("div", "am-avatar-popup am-context-menu");
    contextMenu.hidden = true;
    contextMenu.setAttribute("role", "menu");
    contextMenu.append(button("Выбрать аватар", () => openSettings("avatars")),
      button("Эффекты", () => openSettings("effects")),
      button("Анимация", () => openSettings("animation")),
      button("Скрыть аватар", () => {
        state.hidden = true; save(); hideMenus(); render();
      }),
      button("Сбросить положение", () => {
        state.position = null; save(); hideMenus(); render();
      }));
    document.body.append(contextMenu);

    const restore = button("🦊 Показать аватар", () => {
      state.hidden = false; save(); render();
    }, "am-avatar-restore");
    restore.id = "am-avatar-restore";
    document.body.append(restore);

    createSettings();
    trigger.addEventListener("contextmenu", openContext);
    trigger.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const rect = trigger.getBoundingClientRect();
      dragging = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
        x: rect.left, y: rect.top, moved: false };
      trigger.setPointerCapture(event.pointerId);
    });
    trigger.addEventListener("pointermove", event => {
      if (!dragging || dragging.id !== event.pointerId) return;
      const dx = event.clientX - dragging.startX, dy = event.clientY - dragging.startY;
      if (Math.hypot(dx, dy) > 7) dragging.moved = true;
      if (!dragging.moved) return;
      state.position = { x: dragging.x + dx, y: dragging.y + dy };
      trigger.classList.add("am-dragging");
      clampPosition();
    });
    function finishDrag(event) {
      if (!dragging || dragging.id !== event.pointerId) return;
      if (dragging.moved) {
        state.position = clampPosition(); save(); hideMenus(); suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
      }
      dragging = null;
      trigger.classList.remove("am-dragging");
    }
    trigger.addEventListener("pointerup", finishDrag);
    trigger.addEventListener("pointercancel", finishDrag);
    trigger.addEventListener("click", event => {
      if (suppressClick) { event.stopImmediatePropagation(); event.preventDefault(); }
    }, true);
    document.addEventListener("pointerdown", event => {
      if (!trigger.contains(event.target) && !menu.contains(event.target) && !contextMenu.contains(event.target)) hideMenus();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") hideMenus();
    });
    window.addEventListener("resize", () => {
      if (state.position) state.position = clampPosition();
      clampPosition(); if (!menu.hidden || !contextMenu.hidden) alignMenus();
    });
    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(() => clampPosition());
      resizeObserver.observe(trigger);
    }
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
  window.AmayurenaAvatar = { validate, defaults, poses: AVATARS };
})();

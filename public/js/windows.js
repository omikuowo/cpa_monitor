// 窗口管理：拖拽排序、收纳到程序坞（神奇效果）、放大，状态保存在当前浏览器。
import { $, $$, SPRING, escapeHtml, reducedMotion } from "./ui.js";

const STORAGE_KEY = "cpa:windows:v3";
const TITLES = { quota: "Codex 额度", "auth-files": "认证文件", logs: "日志" };
const ICONS = { quota: "ph-gauge", "auth-files": "ph-files", logs: "ph-terminal-window" };

let workspace;
let dock;
let busy = false;

export function initWindows() {
  workspace = $("#workspace");
  dock = $("#dock");
  restore();

  for (const panel of panels()) {
    panel.querySelectorAll("[data-window-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const action = button.dataset.windowAction;
        if (action === "minimize") minimize(panel);
        if (action === "close") minimize(panel, { genie: false });
        if (action === "maximize") toggleMaximize(panel);
      });
    });
    const handle = panel.querySelector("[data-drag-handle]");
    handle.addEventListener("dblclick", (event) => {
      if (!event.target.closest("[data-window-action]")) toggleMaximize(panel);
    });
    handle.addEventListener("pointerdown", (event) => startDrag(event, panel));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const maximized = $(".window-panel.maximized");
      if (maximized && !document.body.classList.contains("modal-open")) toggleMaximize(maximized);
    }
  });
  renderDock(false);
}

function panels() {
  return $$(".window-panel", workspace);
}

function save() {
  const state = {
    order: panels().map((panel) => panel.dataset.window),
    minimized: panels().filter((panel) => panel.dataset.minimized === "true").map((panel) => panel.dataset.window),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function restore() {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {}
  if (!state) return;
  const anchor = panels()[0]?.previousElementSibling;
  const ordered = (state.order || []).map((id) => $(`.window-panel[data-window="${id}"]`, workspace)).filter(Boolean);
  let cursor = anchor;
  for (const panel of ordered) {
    cursor.after(panel);
    cursor = panel;
  }
  for (const id of state.minimized || []) {
    const panel = $(`.window-panel[data-window="${id}"]`, workspace);
    if (panel) panel.dataset.minimized = "true";
  }
}

// ---------- 程序坞 ----------

function renderDock(animate = true) {
  const items = panels().filter((panel) => panel.dataset.minimized === "true" && !panel.dataset.componentHidden);
  const previous = new Set($$("[data-restore]", dock).map((button) => button.dataset.restore));
  dock.innerHTML = items
    .map(
      (panel) => `<button type="button" data-restore="${panel.dataset.window}" title="${escapeHtml(TITLES[panel.dataset.window])}">
        <i class="ph-bold ${ICONS[panel.dataset.window] || "ph-app-window"}"></i>
        <span>${escapeHtml(TITLES[panel.dataset.window] || panel.dataset.window)}</span>
      </button>`,
    )
    .join("");
  const wasHidden = dock.hidden;
  dock.hidden = items.length === 0;
  $$("[data-restore]", dock).forEach((button) => {
    button.addEventListener("click", () => restoreWindow(button.dataset.restore, button));
    if (animate && !reducedMotion() && !previous.has(button.dataset.restore)) {
      button.animate([{ transform: "scale(0.3)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 560, easing: SPRING });
    }
  });
  if (animate && wasHidden && !dock.hidden && !reducedMotion()) {
    dock.animate([{ transform: "translate(-50%, 140%)" }, { transform: "translate(-50%, 0)" }], { duration: 620, easing: SPRING });
  }
}

export function syncComponentVisibility(components) {
  for (const section of $$("[data-component]", workspace)) {
    const hidden = components[section.dataset.component] === false;
    if (hidden) section.dataset.componentHidden = "1";
    else delete section.dataset.componentHidden;
    applyVisibility(section);
  }
  renderDock(false);
}

function applyVisibility(section) {
  section.hidden = Boolean(section.dataset.componentHidden) || section.dataset.minimized === "true";
}

function dockSlotRect(id) {
  const button = dock && !dock.hidden ? $(`[data-restore="${id}"]`, dock) : null;
  if (button) return button.getBoundingClientRect();
  const width = 56;
  return { left: window.innerWidth / 2 - width / 2, top: window.innerHeight - 70, width, height: 44 };
}

// ---------- 收纳 / 还原 ----------

async function minimize(panel, { genie = true } = {}) {
  if (busy) return;
  busy = true;
  if (panel.classList.contains("maximized")) setMaximized(panel, false);
  const from = panel.getBoundingClientRect();
  const clone = makeGhost(panel, from);
  panel.dataset.minimized = "true";
  applyVisibility(panel);
  const siblings = flipPrepare();
  renderDock();
  flipPlay(siblings);
  save();

  if (!reducedMotion()) {
    const to = dockSlotRect(panel.dataset.window);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const sx = to.width / from.width;
    const sy = to.height / from.height;
    const keyframes = genie
      ? [
          { transform: "none", opacity: 1, filter: "blur(0)", borderRadius: "16px" },
          { transform: `translate(${dx * 0.45}px, ${dy * 0.7}px) scale(${0.5 + sx / 2}, ${0.35 + sy})`, opacity: 0.85, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0, filter: "blur(2px)", borderRadius: "40px" },
        ]
      : [
          { transform: "none", opacity: 1 },
          { transform: "scale(0.92)", opacity: 0 },
        ];
    await clone
      .animate(keyframes, { duration: genie ? 520 : 240, easing: genie ? "cubic-bezier(0.55, 0, 0.3, 1)" : "ease-in", fill: "forwards" })
      .finished.catch(() => {});
    const button = $(`[data-restore="${panel.dataset.window}"]`, dock);
    button?.animate([{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 480, easing: SPRING });
  }
  clone.remove();
  busy = false;
}

async function restoreWindow(id, button) {
  const panel = $(`.window-panel[data-window="${id}"]`, workspace);
  if (!panel || busy) return;
  busy = true;
  const from = button?.getBoundingClientRect() || dockSlotRect(id);
  const siblings = flipPrepare();
  panel.dataset.minimized = "false";
  applyVisibility(panel);
  renderDock();
  flipPlay(siblings);
  save();
  panel.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });

  if (!reducedMotion()) {
    const to = panel.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    await panel
      .animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 0, borderRadius: "40px" },
          { transform: "none", opacity: 1, borderRadius: "16px" },
        ],
        { duration: 640, easing: SPRING },
      )
      .finished.catch(() => {});
  }
  busy = false;
}

function makeGhost(panel, rect) {
  const ghost = panel.cloneNode(true);
  ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  ghost.removeAttribute("data-window");
  ghost.classList.add("window-ghost");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: 0,
    zIndex: 900,
    pointerEvents: "none",
    transformOrigin: "center",
  });
  document.body.appendChild(ghost);
  return ghost;
}

// ---------- 放大 ----------

function setMaximized(panel, value) {
  panel.classList.toggle("maximized", value);
  document.body.classList.toggle("has-maximized", Boolean($(".window-panel.maximized")));
}

async function toggleMaximize(panel) {
  if (busy) return;
  busy = true;
  const from = panel.getBoundingClientRect();
  setMaximized(panel, !panel.classList.contains("maximized"));
  const to = panel.getBoundingClientRect();
  if (!reducedMotion()) {
    await panel
      .animate(
        [
          {
            transformOrigin: "top left",
            transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
          },
          { transformOrigin: "top left", transform: "none" },
        ],
        { duration: 560, easing: SPRING },
      )
      .finished.catch(() => {});
  }
  busy = false;
}

// ---------- 拖拽排序（指针事件 + FLIP） ----------

function flipPrepare() {
  return panels()
    .concat($$("[data-component]:not(.window-panel)", workspace))
    .filter((panel) => !panel.hidden)
    .map((panel) => ({ panel, rect: panel.getBoundingClientRect() }));
}

function flipPlay(items, skip) {
  if (reducedMotion()) return;
  for (const { panel, rect } of items) {
    if (panel === skip || panel.hidden) continue;
    const next = panel.getBoundingClientRect();
    const dy = rect.top - next.top;
    const dx = rect.left - next.left;
    if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
    panel.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 520, easing: SPRING });
  }
}

function startDrag(event, panel) {
  if (event.button !== 0 || event.target.closest("[data-window-action]") || panel.classList.contains("maximized")) return;
  if (matchMedia("(pointer: coarse)").matches) return;
  const startY = event.clientY;
  const startX = event.clientX;
  const baseTop = panel.offsetTop;
  let dragging = false;

  const onMove = (moveEvent) => {
    const dy = moveEvent.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dy, moveEvent.clientX - startX) < 6) return;
      dragging = true;
      panel.classList.add("dragging");
      document.body.classList.add("is-dragging");
    }
    moveEvent.preventDefault();
    // 用布局位置（offsetTop）判断，避免受 FLIP 动画中的 transform 干扰。
    const pointerY = moveEvent.clientY - workspace.getBoundingClientRect().top;
    const others = panels().filter((item) => item !== panel && !item.hidden);
    const target = others.find((item) => pointerY < item.offsetTop + item.offsetHeight / 2) || null;
    const currentNext = nextVisible(panel);
    if (target !== currentNext) {
      const snapshot = flipPrepare();
      if (target) target.before(panel);
      else others[others.length - 1]?.after(panel);
      flipPlay(snapshot, panel);
    }
    panel.style.transform = `translateY(${dy - (panel.offsetTop - baseTop)}px) scale(1.015)`;
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!dragging) return;
    panel.classList.remove("dragging");
    document.body.classList.remove("is-dragging");
    const from = panel.style.transform;
    panel.style.transform = "";
    if (!reducedMotion()) panel.animate([{ transform: from }, { transform: "none" }], { duration: 560, easing: SPRING });
    save();
  };

  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function nextVisible(panel) {
  let node = panel.nextElementSibling;
  while (node && (!node.classList.contains("window-panel") || node.hidden)) node = node.nextElementSibling;
  return node;
}


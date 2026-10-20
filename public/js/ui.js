// 通用 UI 工具：弹窗、提示、数字动画、格式化。

export const SPRING = "linear(0, 0.0188, 0.0676, 0.1366, 0.2179, 0.3052, 0.3939, 0.4803, 0.5621, 0.6375, 0.7056, 0.7658, 0.8183, 0.8631, 0.9007, 0.9318, 0.9569, 0.9768, 0.9922, 1.0037, 1.012, 1.0176, 1.0211, 1.0229, 1.0234, 1.0229, 1.0218, 1.0201, 1.0182, 1.0162, 1.0141, 1.0121, 1.0102, 1.0084, 1.0068, 1.0054, 1.0042, 1.0032, 1.0023, 1.0016, 1)";
export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function shorten(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function formatRelative(value) {
  if (!value) return "尚未检测";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 45_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return formatTime(value);
}

export function formatReset(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = date.getTime() - Date.now();
  if (diff > 0 && diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.round((diff % 3_600_000) / 60_000);
    return hours ? `${hours} 小时 ${minutes} 分后重置` : `${minutes} 分钟后重置`;
  }
  return `${date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} 重置`;
}

// ---------- 数字滚动 ----------

export function countTo(element, value, { duration = 700 } = {}) {
  if (!element) return;
  const target = Number(value) || 0;
  const from = Number(element.dataset.count || 0);
  element.dataset.count = String(target);
  if (from === target || reducedMotion()) {
    element.textContent = String(target);
    return;
  }
  const start = performance.now();
  cancelAnimationFrame(Number(element.dataset.raf || 0));
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 4);
    element.textContent = String(Math.round(from + (target - from) * eased));
    if (t < 1) element.dataset.raf = String(requestAnimationFrame(tick));
  };
  element.dataset.raf = String(requestAnimationFrame(tick));
  if (from !== target) {
    element.animate([{ transform: "scale(1.08)" }, { transform: "scale(1)" }], { duration: 600, easing: SPRING });
  }
}

// ---------- 弹窗（sheet） ----------

const openModals = new Set();

export function openModal(modal) {
  if (!modal || !modal.hidden) return;
  modal.hidden = false;
  openModals.add(modal);
  document.body.classList.add("modal-open");
  const sheet = modal.querySelector(".sheet");
  const backdrop = modal.querySelector(".modal-backdrop");
  if (!reducedMotion()) {
    backdrop?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: EASE_OUT });
    sheet?.animate(
      [
        { opacity: 0, transform: "translateY(24px) scale(0.94)", filter: "blur(6px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 560, easing: SPRING },
    );
  }
  requestAnimationFrame(() => modal.querySelector("input:not([type=checkbox]), select, button.primary")?.focus({ preventScroll: true }));
}

export async function closeModal(modal) {
  if (!modal || modal.hidden || modal.dataset.closing) return;
  modal.dataset.closing = "1";
  const sheet = modal.querySelector(".sheet");
  const backdrop = modal.querySelector(".modal-backdrop");
  if (!reducedMotion()) {
    await Promise.all([
      backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease", fill: "forwards" }).finished,
      sheet?.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(12px) scale(0.96)" },
        ],
        { duration: 220, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
      ).finished,
    ]).catch(() => {});
    sheet?.getAnimations().forEach((animation) => animation.cancel());
    backdrop?.getAnimations().forEach((animation) => animation.cancel());
  }
  modal.hidden = true;
  delete modal.dataset.closing;
  openModals.delete(modal);
  if (openModals.size === 0) document.body.classList.remove("modal-open");
}

export function bindModal(modal) {
  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]") && !modal.dataset.locked) closeModal(modal);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const last = [...openModals].pop();
  if (last && !last.dataset.locked) closeModal(last);
});

export function shake(element) {
  element?.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-10px)" },
      { transform: "translateX(8px)" },
      { transform: "translateX(-5px)" },
      { transform: "translateX(3px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 420, easing: "ease-out" },
  );
}

// ---------- 提示（灵动岛风格） ----------

export function toast(message, type = "info", { duration = 2600 } = {}) {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const icons = { info: "ph-info", ok: "ph-check-circle", error: "ph-warning-circle", warn: "ph-warning" };
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.innerHTML = `<i class="ph-bold ${icons[type] || icons.info}"></i><span>${escapeHtml(message)}</span>`;
  stack.appendChild(item);
  if (!reducedMotion()) {
    item.animate(
      [
        { opacity: 0, transform: "translateY(-16px) scale(0.6)", filter: "blur(4px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 620, easing: SPRING },
    );
  }
  setTimeout(async () => {
    if (!reducedMotion()) {
      await item
        .animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px) scale(0.85)" }], {
          duration: 240,
          easing: "ease-in",
          fill: "forwards",
        })
        .finished.catch(() => {});
    }
    item.remove();
  }, duration);
}

// ---------- 分段控件 ----------

export function initSegmented(root, onChange) {
  const thumb = root.querySelector(".segmented-thumb");
  const move = (button, animate = true) => {
    if (!thumb || !button) return;
    const left = button.offsetLeft;
    const width = button.offsetWidth;
    if (!animate || reducedMotion() || !thumb.style.width) {
      thumb.style.transform = `translateX(${left}px)`;
      thumb.style.width = `${width}px`;
      return;
    }
    thumb.style.transition = `transform 520ms ${SPRING}, width 520ms ${SPRING}`;
    thumb.style.transform = `translateX(${left}px)`;
    thumb.style.width = `${width}px`;
  };
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    setValue(button.dataset.value);
    onChange(button.dataset.value);
  });
  const setValue = (value, animate = true) => {
    const button = root.querySelector(`button[data-value="${value}"]`) || root.querySelector("button[data-value]");
    root.querySelectorAll("button[data-value]").forEach((item) => item.classList.toggle("active", item === button));
    move(button, animate);
  };
  new ResizeObserver(() => move(root.querySelector("button.active"), false)).observe(root);
  return { setValue };
}

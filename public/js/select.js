// 苹果风格的下拉菜单：保留原生 <select> 作为数据源（value / change 事件不变），
// 只替换外观和交互。菜单挂在 body 上，不会被面板或弹窗的 overflow 裁掉。
import { SPRING, escapeHtml, reducedMotion } from "./ui.js";

const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
let openMenu = null;

export function enhanceSelects(root = document) {
  root.querySelectorAll("select:not([data-enhanced])").forEach(enhance);
}

function enhance(select) {
  select.dataset.enhanced = "1";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = `select-trigger ${select.className}`.trim();
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (select.getAttribute("aria-label")) trigger.setAttribute("aria-label", select.getAttribute("aria-label"));
  trigger.innerHTML = `<span class="select-value"></span><i class="select-chevron" aria-hidden="true"></i>`;
  select.classList.add("select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.after(trigger);

  const sync = () => {
    const option = select.options[select.selectedIndex];
    trigger.querySelector(".select-value").textContent = option ? option.textContent : "";
    trigger.disabled = select.disabled;
  };

  // 代码里直接赋值 select.value 不会触发事件，这里拦截一下以保持显示同步。
  Object.defineProperty(select, "value", {
    configurable: true,
    get: () => valueDescriptor.get.call(select),
    set: (value) => {
      valueDescriptor.set.call(select, value);
      sync();
    },
  });
  select.addEventListener("change", sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
  select.closest("label")?.addEventListener("click", (event) => {
    if (event.target !== trigger && !trigger.contains(event.target)) event.preventDefault();
  });

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (openMenu?.select === select) closeMenu();
    else open(select, trigger);
  });
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      open(select, trigger);
    }
  });
  sync();
}

function open(select, trigger) {
  closeMenu(true);
  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  menu.innerHTML =
    `<span class="select-highlight"></span>` +
    [...select.options]
      .map(
        (option, index) => `<button type="button" role="option" class="select-option${option.selected ? " selected" : ""}"
          data-index="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}>
          <i class="select-check" aria-hidden="true"></i><span>${escapeHtml(option.textContent)}</span>
        </button>`,
      )
      .join("");
  document.body.appendChild(menu);
  trigger.setAttribute("aria-expanded", "true");
  trigger.classList.add("open");

  // 定位：默认在按钮下方，空间不够时翻到上方。
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(rect.width, menu.offsetWidth);
  const height = menu.offsetHeight;
  const below = window.innerHeight - rect.bottom - 12;
  const placeAbove = below < height && rect.top > below;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const top = placeAbove ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px`, minWidth: `${width}px`, maxHeight: `${Math.max(160, placeAbove ? rect.top - 14 : below)}px` });
  menu.style.transformOrigin = `${rect.left + rect.width / 2 - left}px ${placeAbove ? "100%" : "0"}`;

  const options = [...menu.querySelectorAll(".select-option:not([disabled])")];
  const highlight = menu.querySelector(".select-highlight");
  let active = options.find((item) => item.classList.contains("selected")) || options[0];

  const moveHighlight = (item, animate = true) => {
    if (!item) return;
    active = item;
    options.forEach((option) => option.classList.toggle("active", option === item));
    highlight.style.transition = animate && !reducedMotion() ? `transform 420ms ${SPRING}, height 420ms ${SPRING}, opacity 200ms` : "none";
    highlight.style.transform = `translateY(${item.offsetTop}px)`;
    highlight.style.height = `${item.offsetHeight}px`;
    highlight.style.opacity = "1";
    // 只滚动菜单本身，避免 scrollIntoView 连带滚动页面导致菜单被关闭。
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop - 5;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight + 5;
    }
  };
  moveHighlight(active, false);

  const choose = (item) => {
    const index = Number(item.dataset.index);
    if (select.selectedIndex !== index) {
      valueDescriptor.set.call(select, select.options[index].value);
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // 像 macOS 一样，选中后高亮闪一下再收起。
    if (!reducedMotion()) highlight.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 140, easing: "steps(2, jump-none)" });
    setTimeout(() => closeMenu(), reducedMotion() ? 0 : 140);
    trigger.focus({ preventScroll: true });
  };

  menu.addEventListener("pointermove", (event) => {
    const item = event.target.closest(".select-option:not([disabled])");
    if (item && item !== active) moveHighlight(item);
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest(".select-option:not([disabled])");
    if (item) choose(item);
  });

  const onKey = (event) => {
    const index = options.indexOf(active);
    if (event.key === "ArrowDown") moveHighlight(options[Math.min(options.length - 1, index + 1)]);
    else if (event.key === "ArrowUp") moveHighlight(options[Math.max(0, index - 1)]);
    else if (event.key === "Home") moveHighlight(options[0]);
    else if (event.key === "End") moveHighlight(options[options.length - 1]);
    else if (event.key === "Enter" || event.key === " ") choose(active);
    else if (event.key === "Escape" || event.key === "Tab") {
      closeMenu();
      trigger.focus({ preventScroll: true });
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onOutside = (event) => {
    if (!menu.contains(event.target) && event.target !== trigger) closeMenu();
  };
  const anchorTop = trigger.getBoundingClientRect().top;
  const onViewport = (event) => {
    if (event.type === "scroll" && (menu.contains(event.target) || Math.abs(trigger.getBoundingClientRect().top - anchorTop) < 2)) return;
    closeMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);

  openMenu = {
    select,
    menu,
    trigger,
    cleanup() {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
    },
  };

  if (!reducedMotion()) {
    menu.animate(
      [
        { opacity: 0, transform: `translateY(${placeAbove ? 8 : -8}px) scale(0.9)`, filter: "blur(4px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 520, easing: SPRING },
    );
    options.forEach((item, index) =>
      item.animate([{ opacity: 0, transform: `translateY(${placeAbove ? 4 : -4}px)` }, { opacity: 1, transform: "none" }], {
        duration: 360,
        delay: 30 + Math.min(index, 10) * 18,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      }),
    );
  }
}

function closeMenu(immediate = false) {
  if (!openMenu) return;
  const { menu, trigger, cleanup } = openMenu;
  openMenu = null;
  cleanup();
  trigger.setAttribute("aria-expanded", "false");
  trigger.classList.remove("open");
  if (immediate || reducedMotion()) {
    menu.remove();
    return;
  }
  menu.style.pointerEvents = "none";
  menu
    .animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96)" }], {
      duration: 160,
      easing: "cubic-bezier(0.4, 0, 1, 1)",
      fill: "forwards",
    })
    .finished.catch(() => {})
    .finally(() => menu.remove());
}

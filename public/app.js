import { api } from "./js/api.js";
import { $, $$, SPRING, bindModal, closeModal, escapeHtml, initSegmented, openModal, reducedMotion, shake, toast } from "./js/ui.js";
import { log, matchesStatus, renderInstanceChips, renderOverview, renderQuota, renderTable } from "./js/render.js";
import { initWindows, syncComponentVisibility } from "./js/windows.js";
import { initSettings, openSettings } from "./js/settings.js";
import { runSetup } from "./js/setup.js";
import { enhanceSelects } from "./js/select.js";

const FILTER_KEY = "cpa:filters:v3";

const state = {
  boot: null,
  settings: null,
  view: { instances: [], summary: {}, listedAt: null, checkedAt: null },
  filters: { instance: "", status: "", search: "", page: 1, pageSize: 25, showAllQuota: false },
  checking: false,
};

let segmented;

main().catch((error) => {
  console.error(error);
  setStatus("error", error.message);
  toast(error.message, "error", { duration: 5000 });
  document.body.classList.remove("booting");
});

async function main() {
  restoreFilters();
  bindStatic();
  enhanceSelects();
  initWindows();

  let boot = await api.bootstrap();
  if (!boot.initialized) {
    document.body.classList.remove("booting");
    const result = await runSetup(boot);
    boot = await api.bootstrap();
    applyBoot(boot);
    await loadSnapshot();
    revealWorkspace();
    if (result.autoCheck) runCheck();
    return;
  }

  applyBoot(boot);
  if (boot.settings.access === "private" && !boot.admin) {
    document.body.classList.remove("booting");
    setStatus("idle", "需要登录");
    openLogin({ locked: true });
    return;
  }

  await loadSnapshot();
  revealWorkspace();
}

function applyBoot(boot) {
  state.boot = boot;
  state.settings = boot.settings;
  document.body.classList.toggle("is-admin", boot.admin);
  document.title = boot.settings.siteName;
  $("#siteName").textContent = boot.settings.siteName;
  syncComponentVisibility(boot.settings.components);
  updateAccountButton();
  updateCheckButton();
  initSettingsOnce(boot);
}

let settingsReady = false;
function initSettingsOnce(boot) {
  if (settingsReady) return;
  settingsReady = true;
  initSettings({
    version: boot.version,
    envPassword: boot.passwordFromEnv,
    saved: async () => {
      applyBoot(await api.bootstrap());
      await loadSnapshot();
    },
    logout: logout,
  });
}

function revealWorkspace() {
  document.body.classList.remove("booting");
  if (reducedMotion()) return;
  $$("#workspace > :not([hidden])").forEach((section, index) => {
    section.animate(
      [
        { opacity: 0, transform: "translateY(24px) scale(0.985)", filter: "blur(6px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 760, delay: 60 + index * 70, easing: SPRING, fill: "backwards" },
    );
  });
}

// ---------- 数据 ----------

async function loadSnapshot() {
  try {
    state.view = await api.snapshot();
    render();
    const s = state.view.summary;
    setStatus(state.view.instances.some((item) => item.ok === false) ? "warn" : "ok", state.view.checkedAt ? "在线" : "待检测");
    log("load", `已加载 ${s.total} 个认证文件`);
  } catch (error) {
    if (error.status === 401) {
      openLogin({ locked: state.settings?.access === "private" });
      return;
    }
    setStatus("error", "加载失败");
    log("error", error.message);
    toast(error.message, "error");
  }
}

async function runCheck() {
  if (state.checking) return;
  if (!state.boot?.admin && !state.settings?.allowCheck) {
    openLogin();
    return;
  }
  state.checking = true;
  updateCheckButton();
  setProgress(0.04);
  const instanceId = state.filters.instance;
  try {
    log("scan", instanceId ? `正在拉取实例 ${instanceId} 的认证文件` : "正在拉取全部实例的认证文件");
    const scanned = await api.scan(instanceId);
    state.view = scanned.view;
    render();
    if (scanned.cached) log("cache", "列表使用缓存");

    const total = scanned.plan.reduce((sum, item) => sum + item.total, 0);
    const batch = state.settings.batchSize || 40;
    let done = 0;
    let checked = 0;
    setProgress(total ? 0.08 : 1);

    for (const { instanceId: id, total: count } of scanned.plan) {
      for (let offset = 0; offset < count; offset += batch) {
        const result = await api.check(id, offset, batch);
        state.view = result.view;
        checked += result.checked;
        done += Math.min(batch, count - offset);
        setProgress(0.08 + (done / total) * 0.92);
        render();
      }
    }

    const s = state.view.summary;
    const reused = done - checked;
    log("ok", `检测完成：正常 ${s.ok}，401 ${s.invalid401}，受限 ${s.limited}，错误 ${s.errors}${reused ? `（${reused} 个使用缓存）` : ""}`);
    toast(total ? `检测完成 · ${s.ok}/${s.total} 正常` : "没有需要检测的认证文件", total ? "ok" : "info");
    setStatus(state.view.instances.some((item) => item.ok === false) ? "warn" : "ok", "在线");
  } catch (error) {
    log("error", error.message);
    toast(error.message, "error", { duration: 4200 });
    if (error.status === 401) openLogin();
  } finally {
    state.checking = false;
    setProgress(null);
    updateCheckButton();
  }
}

// ---------- 渲染 ----------

function filteredRows() {
  const query = state.filters.search.trim().toLowerCase();
  const rows = [];
  for (const instance of state.view.instances) {
    if (state.filters.instance && instance.id !== state.filters.instance) continue;
    for (const file of instance.files) {
      if (!matchesStatus(file, state.filters.status)) continue;
      if (query && !`${instance.name} ${file.id} ${file.accountId} ${file.email} ${file.authIndex}`.toLowerCase().includes(query)) continue;
      rows.push({ instance, file });
    }
  }
  return rows;
}

function render() {
  const view = state.view;
  renderOverview(view, state.settings);
  renderInstanceChips(view, state.filters.instance, (id) => setFilter({ instance: id }));
  renderInstanceOptions();
  const rows = filteredRows();
  const quotaRows = state.view.instances
    .filter((instance) => !state.filters.instance || instance.id === state.filters.instance)
    .flatMap((instance) => instance.files.map((file) => ({ instance, file })));
  renderQuota(quotaRows, { showAll: state.filters.showAllQuota, privacy: false });
  state.filters.page = renderTable(rows, { ...state.filters, privacy: false, view });
  $$(".metric-card").forEach((card) => card.classList.toggle("active", card.dataset.metricFilter === state.filters.status && state.filters.status !== ""));
}

function renderInstanceOptions() {
  const select = $("#instanceFilter");
  const options = [`<option value="">全部实例</option>`].concat(
    state.view.instances.map((instance) => `<option value="${escapeHtml(instance.id)}">${escapeHtml(instance.name)}</option>`),
  );
  const html = options.join("");
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  select.value = state.filters.instance;
  if (select.value !== state.filters.instance) state.filters.instance = "";
}

function setFilter(patch) {
  Object.assign(state.filters, patch);
  if (!("page" in patch)) state.filters.page = 1;
  saveFilters();
  render();
}

// ---------- 交互 ----------

function bindStatic() {
  bindModal($("#loginModal"));
  bindModal($("#settingsModal"));

  $("#checkBtn").addEventListener("click", runCheck);
  $("#themeToggle").addEventListener("click", toggleTheme);
  $("#settingsBtn").addEventListener("click", () => openSettings());
  $("#accountBtn").addEventListener("click", () => (state.boot?.admin ? openSettings("account") : openLogin()));
  syncThemeIcon();

  segmented = initSegmented($("#statusFilter"), (value) => setFilter({ status: value }));
  segmented.setValue(state.filters.status, false);
  $("#instanceFilter").addEventListener("change", (event) => setFilter({ instance: event.target.value }));
  const search = $("#searchInput");
  search.value = state.filters.search;
  let searchTimer;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilter({ search: search.value }), 120);
  });
  $("#pageSize").value = String(state.filters.pageSize);
  $("#pageSize").addEventListener("change", (event) => setFilter({ pageSize: Number(event.target.value) }));
  $("#prevPage").addEventListener("click", () => setFilter({ page: state.filters.page - 1 }));
  $("#nextPage").addEventListener("click", () => setFilter({ page: state.filters.page + 1 }));
  $("#quotaMore").addEventListener("click", () => setFilter({ showAllQuota: !state.filters.showAllQuota, page: state.filters.page }));

  $$(".metric-card").forEach((card) => {
    card.addEventListener("click", () => {
      const value = card.dataset.metricFilter;
      const next = state.filters.status === value ? "" : value;
      segmented.setValue(next);
      setFilter({ status: next });
      const table = $('[data-window="auth-files"]');
      if (!table.hidden) table.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    });
  });

  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.classList.add("loading");
    $("#loginError").textContent = "";
    try {
      await api.login($("#loginPassword").value);
      $("#loginPassword").value = "";
      delete $("#loginModal").dataset.locked;
      await closeModal($("#loginModal"));
      applyBoot(await api.bootstrap());
      await loadSnapshot();
      revealWorkspace();
      toast("已登录管理员", "ok");
      log("auth", "管理员已登录");
    } catch (error) {
      $("#loginError").textContent = error.message;
      shake(form);
    } finally {
      button.disabled = false;
      button.classList.remove("loading");
    }
  });
}

function openLogin({ locked = false } = {}) {
  const modal = $("#loginModal");
  if (locked) modal.dataset.locked = "1";
  modal.querySelectorAll("[data-close]").forEach((node) => (node.hidden = locked && node.tagName === "BUTTON"));
  $("#loginError").textContent = "";
  openModal(modal);
}

async function logout() {
  await api.logout().catch(() => {});
  applyBoot(await api.bootstrap());
  toast("已退出登录");
  log("auth", "已退出管理员");
  if (state.settings.access === "private") {
    state.view = { instances: [], summary: {}, listedAt: null, checkedAt: null };
    openLogin({ locked: true });
    return;
  }
  await loadSnapshot();
}

function updateAccountButton() {
  const button = $("#accountBtn");
  const admin = Boolean(state.boot?.admin);
  button.classList.toggle("logged-in", admin);
  button.title = admin ? "管理员 · 账户" : "管理员登录";
  button.querySelector("i").className = admin ? "ph-bold ph-user-circle-check" : "ph-bold ph-user";
}

function updateCheckButton() {
  const button = $("#checkBtn");
  const guestBlocked = state.boot && !state.boot.admin && !state.settings?.allowCheck;
  button.classList.toggle("loading", state.checking);
  button.disabled = state.checking;
  button.hidden = Boolean(guestBlocked);
  $("#checkLabel").textContent = state.checking ? "检测中" : "检测";
}

function setProgress(value) {
  const line = $("#progressLine");
  const ring = $("#checkRing");
  const circumference = 2 * Math.PI * 15;
  ring.style.strokeDasharray = `${circumference}`;
  if (value === null) {
    line.classList.remove("active");
    ring.style.strokeDashoffset = `${circumference}`;
    return;
  }
  line.classList.add("active");
  line.firstElementChild.style.transform = `scaleX(${value})`;
  ring.style.strokeDashoffset = `${circumference * (1 - value)}`;
}

function setStatus(level, text) {
  const node = $("#siteStatus");
  node.dataset.level = level;
  node.querySelector("em").textContent = text;
}

// ---------- 主题（圆形扩散过渡） ----------

function toggleTheme(event) {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  const apply = () => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("cpa:theme", next);
    } catch {}
    syncThemeIcon();
  };
  if (!document.startViewTransition || reducedMotion()) {
    apply();
    return;
  }
  const x = event?.clientX ?? window.innerWidth - 40;
  const y = event?.clientY ?? 30;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 620, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
}

function syncThemeIcon() {
  const dark = document.documentElement.dataset.theme === "dark";
  const icon = $("#themeToggle i");
  icon.className = `ph-bold ${dark ? "ph-sun" : "ph-moon"}`;
  if (!reducedMotion()) icon.animate([{ transform: "rotate(-90deg) scale(0.4)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 620, easing: SPRING });
}

// ---------- 本地筛选状态 ----------

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters));
  } catch {}
}

function restoreFilters() {
  try {
    Object.assign(state.filters, JSON.parse(localStorage.getItem(FILTER_KEY) || "{}"));
  } catch {}
}

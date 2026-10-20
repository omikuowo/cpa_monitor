// 设置面板：实例管理、检测参数、访问与显示、账户。
import { api } from "./api.js";
import { $, $$, SPRING, closeModal, openModal, reducedMotion, shake, toast } from "./ui.js";

const COMPONENT_LABELS = {
  hero: "概览",
  metrics: "统计卡片",
  quota: "Codex 额度",
  "auth-files": "认证文件列表",
  logs: "日志",
};
const TAB_TITLES = { instances: "CPA 实例", check: "检测", display: "访问与显示", account: "账户" };

let modal;
let onSaved = () => {};
let onLogout = () => {};
let current = null;
let passwordFromEnv = false;

export function initSettings({ saved, logout, envPassword, version }) {
  modal = $("#settingsModal");
  onSaved = saved;
  onLogout = logout;
  passwordFromEnv = envPassword;
  $("#aboutVersion").textContent = version;

  $$(".settings-nav [data-tab]", modal).forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  $("#addInstanceBtn").addEventListener("click", () => {
    const item = addInstanceRow({ enabled: true });
    item.querySelector(".instance-name").focus();
  });
  $("#settingsSave").addEventListener("click", save);
  $("#pwSave").addEventListener("click", changePassword);
  $("#logoutBtn").addEventListener("click", async () => {
    await closeModal(modal);
    onLogout();
  });
}

export async function openSettings(tab = "instances") {
  setStatus("正在加载…");
  switchTab(tab, false);
  openModal(modal);
  try {
    current = await api.settings();
    fill(current);
    setStatus("");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function switchTab(tab, animate = true) {
  $$(".settings-nav [data-tab]", modal).forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $("#settingsTitle").textContent = TAB_TITLES[tab];
  $$(".settings-pane", modal).forEach((pane) => {
    const active = pane.dataset.pane === tab;
    pane.classList.toggle("active", active);
    if (active && animate && !reducedMotion()) {
      pane.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: SPRING });
    }
  });
  $(".settings-footer", modal).hidden = tab === "account";
}

function fill(config) {
  const list = $("#instanceList");
  list.innerHTML = "";
  config.instances.forEach((instance) => addInstanceRow(instance, false));
  if (config.instances.length === 0) addInstanceRow({ enabled: true }, false);

  $("#sAuto").value = String(config.check.autoCheckMinutes);
  if ($("#sAuto").value !== String(config.check.autoCheckMinutes)) {
    $("#sAuto").insertAdjacentHTML("beforeend", `<option value="${config.check.autoCheckMinutes}">每 ${config.check.autoCheckMinutes} 分钟</option>`);
    $("#sAuto").value = String(config.check.autoCheckMinutes);
  }
  $("#sSkipDisabled").checked = config.check.skipDisabled;
  $("#sConcurrency").value = config.check.concurrency;
  $("#sTimeout").value = config.check.timeoutMs;
  $("#sTargetUrl").value = config.check.targetUrl;

  $("#sSiteName").value = config.display.siteName;
  $("#sPublic").checked = config.public.access === "public";
  $("#sAllowCheck").checked = config.public.allowCheck;
  $("#sCache").value = config.public.cacheSeconds;
  $("#sPrivacy").checked = config.public.privacyMode;

  $("#componentToggles").innerHTML = Object.entries(COMPONENT_LABELS)
    .map(
      ([key, label]) => `<label class="switch-row compact">
        <div><strong>${label}</strong></div>
        <input type="checkbox" data-component-key="${key}" ${config.display.components[key] !== false ? "checked" : ""}><i class="switch"></i>
      </label>`,
    )
    .join("");

  $("#passwordForm").hidden = passwordFromEnv;
  $("#pwEnvNote").hidden = !passwordFromEnv;
}

function addInstanceRow(instance, animate = true) {
  const node = $("#instanceTemplate").content.firstElementChild.cloneNode(true);
  if (instance.id) node.dataset.id = instance.id;
  if (instance.fromEnv) node.classList.add("from-env");
  node.querySelector(".instance-name").value = instance.name || "";
  node.querySelector(".instance-url").value = instance.baseUrl || "";
  node.querySelector(".instance-enabled").checked = instance.enabled !== false;
  const key = node.querySelector(".instance-key");
  key.placeholder = instance.accessKeyHint ? `已保存 ${instance.accessKeyHint}（留空不修改）` : "管理密钥";
  const hint = node.querySelector(".instance-hint");
  if (instance.fromEnv) {
    hint.textContent = "来自环境变量，只读";
    node.querySelectorAll("input, .instance-remove").forEach((input) => (input.disabled = true));
  }

  node.querySelector(".instance-remove").addEventListener("click", async () => {
    if (!reducedMotion()) {
      node.style.overflow = "hidden";
      await node
        .animate(
          [
            { opacity: 1, height: `${node.offsetHeight}px`, transform: "none" },
            { opacity: 0, height: "0px", marginBottom: "-10px", paddingTop: 0, paddingBottom: 0, transform: "scale(0.96)" },
          ],
          { duration: 320, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
        )
        .finished.catch(() => {});
    }
    node.remove();
  });

  node.querySelector(".instance-test").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const status = node.querySelector(".instance-status");
    button.classList.add("loading");
    button.disabled = true;
    hint.className = "instance-hint";
    hint.textContent = "正在连接…";
    try {
      const data = await api.testInstance({
        id: node.dataset.id,
        baseUrl: node.querySelector(".instance-url").value.trim(),
        accessKey: key.value.trim(),
      });
      status.dataset.state = "ok";
      hint.className = "instance-hint ok";
      hint.textContent = `连接成功 · ${data.files} 个认证文件，Codex ${data.codex} 个`;
    } catch (error) {
      status.dataset.state = "error";
      hint.className = "instance-hint error";
      hint.textContent = error.message;
      shake(node);
    } finally {
      button.classList.remove("loading");
      button.disabled = false;
    }
  });

  $("#instanceList").appendChild(node);
  if (animate && !reducedMotion()) {
    node.animate([{ opacity: 0, transform: "translateY(-8px) scale(0.97)" }, { opacity: 1, transform: "none" }], { duration: 520, easing: SPRING });
  }
  return node;
}

function collect() {
  const instances = $$("#instanceList .instance-item")
    .map((node) => ({
      id: node.dataset.id,
      name: node.querySelector(".instance-name").value.trim(),
      baseUrl: node.querySelector(".instance-url").value.trim(),
      accessKey: node.querySelector(".instance-key").value.trim(),
      enabled: node.querySelector(".instance-enabled").checked,
    }))
    // 完全空白的新行直接忽略。
    .filter((item) => item.id || item.name || item.baseUrl || item.accessKey);

  const components = {};
  $$("[data-component-key]").forEach((input) => (components[input.dataset.componentKey] = input.checked));

  return {
    instances,
    check: {
      autoCheckMinutes: Number($("#sAuto").value),
      skipDisabled: $("#sSkipDisabled").checked,
      concurrency: Number($("#sConcurrency").value),
      timeoutMs: Number($("#sTimeout").value),
      targetUrl: $("#sTargetUrl").value.trim(),
    },
    public: {
      access: $("#sPublic").checked ? "public" : "private",
      allowCheck: $("#sAllowCheck").checked,
      cacheSeconds: Number($("#sCache").value),
      privacyMode: $("#sPrivacy").checked,
    },
    display: { siteName: $("#sSiteName").value.trim(), components },
  };
}

async function save() {
  const button = $("#settingsSave");
  button.disabled = true;
  button.classList.add("loading");
  setStatus("正在保存…");
  try {
    current = await api.saveSettings(collect());
    fill(current);
    setStatus("已保存", "ok");
    toast("设置已保存", "ok");
    onSaved(current);
  } catch (error) {
    setStatus(error.message, "error");
    shake($(".settings-sheet"));
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
}

async function changePassword() {
  const currentPassword = $("#pwCurrent").value;
  const next = $("#pwNext").value;
  try {
    await api.changePassword(currentPassword, next);
    $("#pwCurrent").value = "";
    $("#pwNext").value = "";
    toast("密码已修改，其他设备需要重新登录", "ok");
  } catch (error) {
    toast(error.message, "error");
    shake($("#passwordForm"));
  }
}

function setStatus(message, type = "") {
  const node = $("#settingsStatus");
  node.className = type;
  node.textContent = message;
}


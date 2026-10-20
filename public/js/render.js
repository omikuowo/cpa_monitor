import { $, SPRING, countTo, escapeHtml, formatRelative, formatReset, formatTime, reducedMotion, shorten } from "./ui.js";

const STATUS = {
  ok: ["ok", "正常"],
  invalid_401: ["danger", "401 失效"],
  limited: ["warn", "受限"],
  upstream_error: ["danger", "上游错误"],
  check_error: ["danger", "检测错误"],
  skipped: ["neutral", "已跳过"],
  unchecked: ["neutral", "未检测"],
};

const PROBLEMS = new Set(["invalid_401", "limited", "upstream_error", "check_error"]);
const quotaPage = () => (matchMedia("(max-width: 760px)").matches ? 4 : 12);

export function statusOf(file) {
  return file.check?.status || "unchecked";
}

export function matchesStatus(file, filter) {
  if (!filter) return true;
  const status = statusOf(file);
  if (filter === "error") return status === "upstream_error" || status === "check_error";
  if (filter === "problems") return PROBLEMS.has(status);
  return status === filter;
}

function tag(status) {
  const [cls, label] = STATUS[status] || ["neutral", status];
  return `<span class="tag ${cls}"><i></i>${label}</span>`;
}

function displayId(file, privacy) {
  if (!privacy) return file.id;
  const match = file.id.match(/^(.*?)(\.json)?$/i);
  const base = match[1];
  return `${base.slice(0, 2)}••••${base.length > 6 ? base.slice(-3) : ""}${match[2] || ""}`;
}

function displayAccount(file, privacy) {
  const value = file.email || file.accountId || "-";
  if (!privacy || value === "-") return value;
  if (value.includes("@")) return `${value[0]}•••@${value.split("@")[1]}`;
  return `••••${value.slice(-4)}`;
}

// ---------- 概览 ----------

export function renderOverview(view, { siteName, autoCheckMinutes }) {
  const s = view.summary;
  const tested = s.ok + s.invalid401 + s.limited + s.errors;
  const percent = tested ? Math.round((s.ok / tested) * 100) : 0;

  $("#heroTitle").textContent = siteName;
  countTo($("#heroPercent"), percent);
  const ring = $("#heroRing");
  const circumference = 2 * Math.PI * 52;
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference * (1 - percent / 100)}`;
  ring.dataset.level = !tested ? "idle" : percent >= 80 ? "good" : percent >= 50 ? "warn" : "danger";

  const parts = [];
  parts.push(view.checkedAt ? `最近检测 ${formatRelative(view.checkedAt)}` : "尚未检测");
  if (autoCheckMinutes) parts.push(`每 ${autoCheckMinutes >= 60 ? `${autoCheckMinutes / 60} 小时` : `${autoCheckMinutes} 分钟`}自动检测`);
  if (view.masked) parts.push("隐私模式");
  $("#heroSubtitle").textContent = parts.join(" · ");

  countTo($("#mTotal"), s.total);
  $("#mTotalHint").textContent = `${s.instances} 个实例${s.errorInstances ? ` · ${s.errorInstances} 异常` : ""}`;
  countTo($("#mOk"), s.ok);
  countTo($("#mInvalid"), s.invalid401);
  countTo($("#mLimited"), s.limited);
  countTo($("#mErrors"), s.errors);
  countTo($("#mUnchecked"), s.unchecked);
  $("#mUncheckedHint").textContent = s.disabled ? `${s.disabled} 个已禁用` : "等待检测";
}

export function renderInstanceChips(view, activeId, onPick) {
  const root = $("#instanceChips");
  if (view.instances.length === 0) {
    root.innerHTML = `<span class="chip muted">暂无 CPA 实例</span>`;
    return;
  }
  root.innerHTML = view.instances
    .map((instance) => {
      const state = instance.ok === false ? "error" : instance.ok ? "ok" : "idle";
      const title = instance.error ? escapeHtml(instance.error) : escapeHtml(instance.host || instance.name);
      return `<button type="button" class="chip ${state} ${instance.id === activeId ? "active" : ""}" data-chip="${escapeHtml(instance.id)}" title="${title}">
        <i></i>${escapeHtml(instance.name)}<small>${instance.files.length}</small>
      </button>`;
    })
    .join("");
  root.querySelectorAll("[data-chip]").forEach((button) => {
    button.addEventListener("click", () => onPick(button.dataset.chip === activeId ? "" : button.dataset.chip));
  });
}

// ---------- 额度卡片 ----------

export function renderQuota(rows, { showAll, privacy }) {
  const withQuota = rows.filter((row) => row.file.check?.quotaBars?.length);
  $("#quotaCount").textContent = String(withQuota.length);
  const grid = $("#quotaGrid");
  const footer = $("#quotaFooter");

  if (withQuota.length === 0) {
    const checked = rows.some((row) => row.file.check && row.file.check.status !== "skipped");
    grid.innerHTML = `<div class="empty-state">
      <i class="ph-bold ${checked ? "ph-chart-bar" : "ph-gauge"}"></i>
      <strong>${checked ? "没有可解析的额度数据" : "暂无额度数据"}</strong>
      <span>${checked ? "最近的 usage 响应里没有额度字段。" : "点击右上角「检测」获取 Codex 额度。"}</span>
    </div>`;
    footer.hidden = true;
    return;
  }

  const sorted = [...withQuota].sort((a, b) => minRemaining(a) - minRemaining(b));
  const visible = showAll ? sorted : sorted.slice(0, quotaPage());
  footer.hidden = sorted.length <= quotaPage();
  $("#quotaMore").textContent = showAll ? "收起" : `显示全部 ${sorted.length} 个`;

  const previous = new Map([...grid.querySelectorAll(".quota-fill")].map((bar) => [bar.dataset.key, bar.style.width]));
  grid.innerHTML = visible
    .map((row, index) => {
      const file = row.file;
      const bars = file.check.quotaBars
        .map((bar, barIndex) => {
          const remaining = Math.max(0, Math.min(100, 100 - (Number(bar.percent) || 0)));
          const level = remaining >= 50 ? "good" : remaining >= 20 ? "warn" : "danger";
          const key = `${row.instance.id}:${file.id}:${barIndex}`;
          return `<div class="quota-row">
            <div class="quota-label"><strong>${escapeHtml(bar.label)}</strong><span class="quota-percent ${level}">${Math.round(remaining)}%</span></div>
            <div class="quota-track"><div class="quota-fill ${level}" data-key="${escapeHtml(key)}" data-target="${remaining}" style="width:${previous.get(key) || "0%"}"></div></div>
            ${bar.resetAt ? `<div class="quota-reset">${escapeHtml(formatReset(bar.resetAt))}</div>` : ""}
          </div>`;
        })
        .join("");
      return `<article class="quota-card" style="--i:${index}">
        <div class="quota-head">
          <span class="provider-pill">${escapeHtml(file.check.plan || "codex")}</span>
          <strong title="${escapeHtml(privacy ? "" : file.id)}">${escapeHtml(shorten(displayId(file, privacy), 40))}</strong>
        </div>
        <div class="quota-sub">${escapeHtml(row.instance.name)} · ${escapeHtml(shorten(displayAccount(file, privacy), 32))}</div>
        ${bars}
      </article>`;
    })
    .join("");

  requestAnimationFrame(() => {
    grid.querySelectorAll(".quota-fill").forEach((bar) => {
      bar.style.width = `${bar.dataset.target}%`;
    });
  });
  if (!reducedMotion()) {
    grid.querySelectorAll(".quota-card").forEach((card, index) => {
      if (previous.size) return;
      card.animate([{ opacity: 0, transform: "translateY(14px) scale(0.98)" }, { opacity: 1, transform: "none" }], {
        duration: 620,
        delay: Math.min(index, 12) * 35,
        easing: SPRING,
        fill: "backwards",
      });
    });
  }
}

function minRemaining(row) {
  return Math.min(...row.file.check.quotaBars.map((bar) => 100 - (Number(bar.percent) || 0)));
}

// ---------- 表格 ----------

export function renderTable(rows, { page, pageSize, privacy, view }) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = rows.slice((current - 1) * pageSize, current * pageSize);
  $("#tableCount").textContent = String(rows.length);
  $("#pageInfo").textContent = `${current} / ${totalPages}`;
  $("#prevPage").disabled = current <= 1;
  $("#nextPage").disabled = current >= totalPages;
  $("#lastChecked").textContent = view.checkedAt ? `最近检测 ${formatTime(view.checkedAt)}` : view.listedAt ? `列表更新于 ${formatTime(view.listedAt)}` : "尚未检测";

  const errorRows = view.instances
    .filter((instance) => instance.ok === false)
    .map(
      (instance) => `<tr class="instance-error-row"><td>${escapeHtml(instance.name)}</td>
        <td colspan="7"><span class="tag danger"><i></i>实例错误</span> ${escapeHtml(instance.error || "未知错误")}</td></tr>`,
    )
    .join("");

  if (slice.length === 0) {
    const empty = view.instances.length === 0 ? "还没有 CPA 实例，登录后在设置中添加" : rows.length === 0 && view.summary.total ? "没有符合条件的认证文件" : "暂无数据，点击「检测」拉取认证文件";
    $("#fileTable").innerHTML = `${errorRows}<tr><td colspan="8" class="empty-cell">${empty}</td></tr>`;
    return current;
  }

  $("#fileTable").innerHTML =
    errorRows +
    slice
      .map(({ instance, file }) => {
        const check = file.check;
        const status = statusOf(file);
        const quota = check?.quotaBars?.length
          ? `<div class="mini-quota">${check.quotaBars
              .slice(0, 2)
              .map((bar) => {
                const remaining = Math.max(0, 100 - (Number(bar.percent) || 0));
                const level = remaining >= 50 ? "good" : remaining >= 20 ? "warn" : "danger";
                return `<span class="mini-bar ${level}" title="${escapeHtml(bar.label)} 剩余 ${Math.round(remaining)}%"><b style="width:${remaining}%"></b></span>`;
              })
              .join("")}</div>`
          : "-";
        return `<tr class="${PROBLEMS.has(status) ? "is-problem" : ""}">
          <td data-label="实例">${escapeHtml(instance.name)}</td>
          <td data-label="文件" class="mono-strong" title="${escapeHtml(privacy ? "" : file.id)}">${escapeHtml(shorten(displayId(file, privacy), 34))}${file.disabled ? ' <span class="tag neutral small">禁用</span>' : ""}</td>
          <td data-label="账号">${escapeHtml(shorten(displayAccount(file, privacy), 28))}</td>
          <td data-label="状态">${tag(status)}</td>
          <td data-label="额度">${quota}</td>
          <td data-label="HTTP">${check?.statusCode ?? "-"}</td>
          <td data-label="延迟">${check && check.latencyMs ? `${check.latencyMs}ms` : "-"}</td>
          <td data-label="消息" class="message-cell" title="${escapeHtml(check?.message || "")}">${escapeHtml(shorten(check?.message || "未检测", 40))}</td>
        </tr>`;
      })
      .join("");
  return current;
}

// ---------- 日志 ----------

export function log(type, message) {
  const root = $("#logOutput");
  if (!root) return;
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.innerHTML = `<time>${new Date().toLocaleTimeString("zh-CN", { hour12: false })}</time><strong>${escapeHtml(type)}</strong><span>${escapeHtml(message)}</span>`;
  root.prepend(line);
  if (!reducedMotion()) line.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: SPRING });
  while (root.children.length > 80) root.lastChild.remove();
}

// 首次部署的初始化向导。
import { api } from "./api.js";
import { $, $$, SPRING, escapeHtml, reducedMotion, shake } from "./ui.js";

export function runSetup(boot) {
  return new Promise((resolve) => {
    const screen = $("#setupScreen");
    const steps = $$(".setup-step", screen);
    const dots = $$("#setupDots i");
    let index = 0;

    $("#setupKvWarning").hidden = boot.kvBound;
    $("#setupTokenField").hidden = !boot.setupTokenRequired;
    screen.hidden = false;
    document.body.classList.add("setup-active");
    show(0, 0);

    function show(next, direction) {
      index = next;
      steps.forEach((step, i) => step.classList.toggle("active", i === index));
      dots.forEach((dot, i) => dot.classList.toggle("active", i === index));
      const current = steps[index];
      current.querySelector("[data-setup-error]")?.replaceChildren();
      if (!reducedMotion() && direction !== 0) {
        current.animate(
          [
            { opacity: 0, transform: `translateX(${direction * 60}px)`, filter: "blur(4px)" },
            { opacity: 1, transform: "none", filter: "blur(0)" },
          ],
          { duration: 620, easing: SPRING },
        );
      }
      requestAnimationFrame(() => current.querySelector("input")?.focus({ preventScroll: true }));
    }

    function fail(message) {
      const box = steps[index].querySelector("[data-setup-error]");
      if (box) box.textContent = message;
      shake(steps[index]);
    }

    function validate() {
      if (index === 0 && !boot.kvBound) {
        fail("请先绑定 KV 存储后重新部署");
        return false;
      }
      if (index === 1) {
        if (boot.setupTokenRequired && !$("#setupToken").value.trim()) return fail("请输入初始化口令"), false;
        const password = $("#setupPassword").value;
        if (password.length < 6) return fail("密码至少 6 位"), false;
        if (password !== $("#setupPassword2").value) return fail("两次输入的密码不一致"), false;
      }
      if (index === 2) {
        const url = $("#setupInstanceUrl").value.trim();
        const key = $("#setupInstanceKey").value.trim();
        if ((url || key) && !(url && key)) return fail("请同时填写地址和管理密钥，或全部留空跳过"), false;
        if (url && !/^https?:\/\//i.test(url)) return fail("地址需要以 http:// 或 https:// 开头"), false;
      }
      return true;
    }

    screen.addEventListener("click", async (event) => {
      if (event.target.closest("[data-setup-next]")) {
        if (validate()) show(index + 1, 1);
      } else if (event.target.closest("[data-setup-back]")) {
        show(Math.max(0, index - 1), -1);
      }
    });

    screen.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.matches("input")) {
        event.preventDefault();
        steps[index].querySelector("[data-setup-next], #setupFinish")?.click();
      }
    });

    $("#setupTestBtn").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const result = $("#setupTestResult");
      if (!validate() || !$("#setupInstanceUrl").value.trim()) {
        if (!$("#setupInstanceUrl").value.trim()) fail("请填写 CPA 地址");
        return;
      }
      button.classList.add("loading");
      button.disabled = true;
      result.className = "test-result";
      result.textContent = "正在连接…";
      try {
        const data = await api.testInstance({
          baseUrl: $("#setupInstanceUrl").value.trim(),
          accessKey: $("#setupInstanceKey").value.trim(),
          setupToken: $("#setupToken").value.trim(),
        });
        result.className = "test-result ok";
        result.innerHTML = `<i class="ph-bold ph-check-circle"></i> 连接成功：${data.files} 个认证文件，其中 Codex ${data.codex} 个`;
      } catch (error) {
        result.className = "test-result error";
        result.innerHTML = `<i class="ph-bold ph-warning-circle"></i> ${escapeHtml(error.message)}`;
      } finally {
        button.classList.remove("loading");
        button.disabled = false;
      }
    });

    $("#setupFinish").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.classList.add("loading");
      const url = $("#setupInstanceUrl").value.trim();
      const instances = url
        ? [{ name: $("#setupInstanceName").value.trim(), baseUrl: url, accessKey: $("#setupInstanceKey").value.trim(), enabled: true }]
        : [];
      try {
        await api.setup({
          password: $("#setupPassword").value,
          setupToken: $("#setupToken").value.trim(),
          siteName: $("#setupSiteName").value.trim(),
          instances,
          public: { access: $("#setupPublic").checked ? "public" : "private", privacyMode: $("#setupPrivacy").checked },
          check: { autoCheckMinutes: Number($("#setupAuto").value) },
        });
        show(4, 1);
        const done = $(".setup-done");
        if (!reducedMotion()) {
          done.animate([{ transform: "scale(0.2)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 780, easing: SPRING });
        }
      } catch (error) {
        fail(error.message);
      } finally {
        button.disabled = false;
        button.classList.remove("loading");
      }
    });

    $("#setupEnter").addEventListener("click", async () => {
      const card = $(".setup-card", screen);
      if (!reducedMotion()) {
        await Promise.all([
          card.animate([{ transform: "none", opacity: 1 }, { transform: "scale(1.06)", opacity: 0, filter: "blur(8px)" }], {
            duration: 420,
            easing: "cubic-bezier(0.4, 0, 0.2, 1)",
            fill: "forwards",
          }).finished,
          screen.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: "ease", fill: "forwards" }).finished,
        ]).catch(() => {});
      }
      screen.hidden = true;
      document.body.classList.remove("setup-active");
      resolve({ autoCheck: instances().length > 0 });
    });

    const instances = () => ($("#setupInstanceUrl").value.trim() ? [1] : []);
  });
}

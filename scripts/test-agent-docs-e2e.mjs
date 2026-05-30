#!/usr/bin/env node
/**
 * E2E: Settings panel — agents.md / memory.md (AI instructions & memory)
 */
import puppeteer from "puppeteer-core";

const APP = process.env.WINKTERM_APP || "http://localhost:3000";
const API = process.env.WINKTERM_API || "http://localhost:8000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MARKER_AGENTS = `# E2E agents ${Date.now()}\n- 优先使用 bash\n- 回复用中文`;
const MARKER_MEMORY = `# E2E memory ${Date.now()}\n- 测试主机: localhost\n- 偏好: 简洁输出`;

const results = [];
const pass = (name) => results.push({ name, ok: true });
const fail = (name, err) => results.push({ name, ok: false, err: String(err) });

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openSettings(page) {
  await page.evaluate(() => {
    const el = document.querySelector('.activity-item[title="Settings"], .activity-item[title="设置"]');
    el?.click();
  });
  await page.waitForSelector(".settings-panel, .settings-group", { timeout: 10000 });
}

async function getAgentDocsGroup(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll(".settings-group")];
    const group = groups.find((g) => {
      const t = g.querySelector(".settings-group-title")?.textContent || "";
      return t.includes("AI 指令与记忆") || t.includes("AI Instructions");
    });
    if (!group) return null;
    const labels = [...group.querySelectorAll(".settings-label")].map((l) => l.textContent?.trim());
    const helps = [...group.querySelectorAll(".settings-help")].map((h) => h.textContent?.trim());
    const textareas = [...group.querySelectorAll("textarea.settings-textarea")].map((ta) => ({
      value: ta.value,
      className: ta.className,
    }));
    const buttons = [...group.querySelectorAll("button.settings-btn-full")].map((b) => ({
      text: b.textContent?.trim(),
      disabled: b.disabled,
    }));
    return { labels, helps, textareas, buttons, title: group.querySelector(".settings-group-title")?.textContent?.trim() };
  });
}

async function saveInAgentDocsGroup(page, index) {
  await page.evaluate((idx) => {
    const groups = [...document.querySelectorAll(".settings-group")];
    const group = groups.find((g) => {
      const t = g.querySelector(".settings-group-title")?.textContent || "";
      return t.includes("AI 指令与记忆") || t.includes("AI Instructions");
    });
    const btn = group?.querySelectorAll("button.settings-btn-full")[idx];
    btn?.click();
  }, index);
}

async function fillTextareaInAgentDocsGroup(page, index, value) {
  await page.evaluate(
    (idx, val) => {
      const groups = [...document.querySelectorAll(".settings-group")];
      const group = groups.find((g) => {
        const t = g.querySelector(".settings-group-title")?.textContent || "";
        return t.includes("AI 指令与记忆") || t.includes("AI Instructions");
      });
      const ta = group?.querySelectorAll("textarea.settings-textarea")[idx];
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(ta, val);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
    },
    index,
    value
  );
}

async function main() {
  let origAgents = "";
  let origMemory = "";
  try {
    origAgents = (await api("GET", "/api/settings/agents-md")).content || "";
    origMemory = (await api("GET", "/api/settings/memory-md")).content || "";
  } catch (e) {
    fail("API baseline read", e);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1400, height: 900 },
    });
    const page = await browser.newPage();

    // 1. Open app and navigate to settings
    await page.goto(APP, { waitUntil: "networkidle2", timeout: 30000 });
    await openSettings(page);
    pass("打开设置页");

    // 2. Verify UI structure (Chinese locale)
    let group = await getAgentDocsGroup(page);
    if (!group) throw new Error("未找到 AI 指令与记忆分组");
    if (!group.title?.includes("AI 指令与记忆")) throw new Error(`标题异常: ${group.title}`);
    if (group.textareas.length !== 2) throw new Error(`textarea 数量=${group.textareas.length}`);
    if (!group.labels.some((l) => l?.includes("agents.md"))) throw new Error(`labels: ${group.labels}`);
    if (!group.labels.some((l) => l?.includes("memory.md"))) throw new Error(`labels: ${group.labels}`);
    if (group.helps.length < 2) throw new Error("缺少 help 文案");
    if (!group.textareas.every((t) => t.className.includes("settings-textarea"))) throw new Error("textarea 样式类缺失");
    pass("UI 结构与中英文案（中文）");

    // 3. Edit and save agents.md
    await fillTextareaInAgentDocsGroup(page, 0, MARKER_AGENTS);
    await saveInAgentDocsGroup(page, 0);
    await page.waitForFunction(
      () => {
        const groups = [...document.querySelectorAll(".settings-group")];
        const group = groups.find((g) => {
          const t = g.querySelector(".settings-group-title")?.textContent || "";
          return t.includes("AI 指令与记忆") || t.includes("AI Instructions");
        });
        const btn = group?.querySelectorAll("button.settings-btn-full")[0];
        return btn?.textContent?.includes("已保存") || btn?.textContent?.includes("Saved");
      },
      { timeout: 8000 }
    );
    pass("保存 agents.md — 按钮反馈");

    const agentsAfterSave = (await api("GET", "/api/settings/agents-md")).content;
    if (agentsAfterSave !== MARKER_AGENTS) throw new Error("API agents.md 与 UI 保存不一致");
    pass("保存 agents.md — API 校验");

    // 4. Edit and save memory.md
    await fillTextareaInAgentDocsGroup(page, 1, MARKER_MEMORY);
    await saveInAgentDocsGroup(page, 1);
    await page.waitForFunction(
      () => {
        const groups = [...document.querySelectorAll(".settings-group")];
        const group = groups.find((g) => {
          const t = g.querySelector(".settings-group-title")?.textContent || "";
          return t.includes("AI 指令与记忆") || t.includes("AI Instructions");
        });
        const btn = group?.querySelectorAll("button.settings-btn-full")[1];
        return btn?.textContent?.includes("已保存") || btn?.textContent?.includes("Saved");
      },
      { timeout: 8000 }
    );
    pass("保存 memory.md — 按钮反馈");

    const memoryAfterSave = (await api("GET", "/api/settings/memory-md")).content;
    if (memoryAfterSave !== MARKER_MEMORY) throw new Error("API memory.md 与 UI 保存不一致");
    pass("保存 memory.md — API 校验");

    // 5. Verify persistence after page reload
    await page.reload({ waitUntil: "networkidle2" });
    await openSettings(page);
    group = await getAgentDocsGroup(page);
    if (group.textareas[0].value !== MARKER_AGENTS) throw new Error("刷新后 agents.md 未持久化");
    if (group.textareas[1].value !== MARKER_MEMORY) throw new Error("刷新后 memory.md 未持久化");
    pass("刷新后 textarea 内容持久化");

    // 6. Switch to English i18n
    await page.select(".settings-select", "en");
    await sleep(400);
    group = await getAgentDocsGroup(page);
    if (!group.title?.includes("AI Instructions")) throw new Error(`英文标题: ${group.title}`);
    if (!group.labels.some((l) => l?.includes("Instructions"))) throw new Error(`英文 labels: ${group.labels}`);
    if (!group.labels.some((l) => l?.includes("Long-term Memory"))) throw new Error(`英文 labels: ${group.labels}`);
    pass("切换 English — i18n 文案");

    // 7. Save button label in English locale
    await page.select(".settings-select", "zh");
    await sleep(300);
    pass("切回中文");

    // 8. Save empty content
    await fillTextareaInAgentDocsGroup(page, 0, "");
    await saveInAgentDocsGroup(page, 0);
    await sleep(600);
    if ((await api("GET", "/api/settings/agents-md")).content !== "") throw new Error("空 agents.md 保存失败");
    pass("空内容保存 agents.md");

    await fillTextareaInAgentDocsGroup(page, 0, MARKER_AGENTS);
    await saveInAgentDocsGroup(page, 0);
    await sleep(600);
  } catch (e) {
    fail("浏览器 E2E", e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      await api("PUT", "/api/settings/agents-md", { content: origAgents });
      await api("PUT", "/api/settings/memory-md", { content: origMemory });
    } catch {
      /* ignore restore errors */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== Agent Docs E2E Results ===");
  for (const r of results) {
    console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}: ${r.err}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main();

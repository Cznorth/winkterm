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
  await page.waitForFunction(
    () => !!document.querySelector('.activity-item[title="Settings"], .activity-item[title="设置"]'),
    { timeout: 15000 }
  );
  await page.evaluate(() => {
    const el = document.querySelector('.activity-item[title="Settings"], .activity-item[title="设置"]');
    if (!el) {
      throw new Error("Settings activity item not found");
    }
    el.click();
  });
  await page.waitForSelector(".settings-panel, .settings-group", { timeout: 10000 });
}

async function clickSettingsSection(page, labels) {
  await page.evaluate((expectedLabels) => {
    const buttons = [...document.querySelectorAll(".settings-nav-item, .settings-mobile-tab")];
    const button = buttons.find((item) =>
      expectedLabels.some((label) => item.textContent?.includes(label))
    );
    if (!button) throw new Error(`Settings section not found: ${expectedLabels.join(" / ")}`);
    button.click();
  }, labels);
}

async function openAgentBehavior(page) {
  await clickSettingsSection(page, ["Agent 行为", "Agent Behavior"]);
  await page.waitForFunction(() => {
    const title = document.querySelector(".settings-section-title")?.textContent || "";
    return title.includes("Agent 行为") || title.includes("Agent Behavior");
  });
}

async function getAgentDocsView(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".settings-section-panel");
    if (!panel) return null;
    const rows = [...panel.querySelectorAll(".settings-doc-row")].map((row) => ({
      title: row.querySelector(".settings-doc-row-title")?.textContent?.trim() || "",
      meta: row.querySelector(".settings-doc-row-meta")?.textContent?.trim() || "",
      button: row.querySelector("button")?.textContent?.trim() || "",
    }));
    const textarea = panel.querySelector("textarea.settings-textarea");
    const buttons = [...panel.querySelectorAll("button")].map((b) => ({
      text: b.textContent?.trim(),
      disabled: b.disabled,
    }));
    return {
      title: panel.querySelector(".settings-section-title")?.textContent?.trim() || "",
      rows,
      label: panel.querySelector(".settings-label")?.textContent?.trim() || "",
      help: panel.querySelector(".settings-help")?.textContent?.trim() || "",
      textarea: textarea ? { value: textarea.value, className: textarea.className } : null,
      buttons,
    };
  });
}

async function openDocEditor(page, filename) {
  await page.evaluate((expectedFilename) => {
    const rows = [...document.querySelectorAll(".settings-doc-row")];
    const row = rows.find(
      (item) => item.querySelector(".settings-doc-row-meta")?.textContent?.trim() === expectedFilename
    );
    const button = row?.querySelector("button");
    if (!button) throw new Error(`Document row not found: ${expectedFilename}`);
    button.click();
  }, filename);
  await page.waitForFunction(
    (expectedFilename) =>
      document.querySelector(".settings-label")?.textContent?.includes(expectedFilename) &&
      !!document.querySelector("textarea.settings-textarea"),
    {},
    filename
  );
}

async function backToDocList(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".settings-section-panel button")].find((item) => {
      const text = item.textContent || "";
      return text.includes("返回列表") || text.includes("Back to list");
    });
    if (!button) throw new Error("Back-to-list button not found");
    button.click();
  });
  await page.waitForSelector(".settings-doc-list");
}

async function fillDocEditor(page, value) {
  await page.evaluate(
    (val) => {
      const ta = document.querySelector("textarea.settings-textarea");
      if (!ta) throw new Error("Document editor not found");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(ta, val);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value
  );
}

async function waitForDocValue(page, expected) {
  await page.waitForFunction(
    (value) => document.querySelector("textarea.settings-textarea")?.value === value,
    { timeout: 10000 },
    expected
  );
}

async function saveDocEditor(page, filename) {
  await page.evaluate(() => {
    const button = document.querySelector(
      ".settings-section-panel button.settings-btn-primary.settings-btn-full"
    );
    if (!button) throw new Error("Document save button not found");
    button.click();
  });
  await page.waitForFunction(
    (expectedFilename) => {
      const messages = [...document.querySelectorAll(".toast-message")].map(
        (item) => item.textContent || ""
      );
      return messages.some(
        (message) => message.includes(expectedFilename) &&
          (message.includes("已保存") || message.toLowerCase().includes("saved"))
      );
    },
    { timeout: 8000 },
    filename
  );
}

async function selectLanguage(page, locale) {
  await clickSettingsSection(page, ["外观", "Appearance"]);
  await page.evaluate((nextLocale) => {
    const selects = [...document.querySelectorAll("select.settings-select")];
    const languageSelect = selects.find((select) => {
      const values = [...select.options].map((option) => option.value);
      return values.includes("zh") && values.includes("en");
    });
    if (!languageSelect) {
      throw new Error("未找到语言选择器");
    }
    languageSelect.value = nextLocale;
    languageSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }, locale);
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
    await page.evaluate(() => localStorage.setItem("winkterm-language", "zh"));
    await page.reload({ waitUntil: "networkidle2" });
    await openSettings(page);
    await openAgentBehavior(page);
    pass("打开设置页");

    // 2. Verify UI structure (Chinese locale)
    let view = await getAgentDocsView(page);
    if (!view) throw new Error("未找到 Agent 行为分区");
    if (!view.title?.includes("Agent 行为")) throw new Error(`标题异常: ${view.title}`);
    if (view.rows.length !== 2) throw new Error(`文档行数量=${view.rows.length}`);
    if (!view.rows.some((row) => row.meta === "agents.md")) throw new Error(`rows: ${JSON.stringify(view.rows)}`);
    if (!view.rows.some((row) => row.meta === "memory.md")) throw new Error(`rows: ${JSON.stringify(view.rows)}`);
    if (!view.rows.every((row) => row.button.includes("编辑"))) throw new Error("中文编辑按钮缺失");
    pass("UI 结构与中英文案（中文）");

    // 3. Edit and save agents.md
    await openDocEditor(page, "agents.md");
    view = await getAgentDocsView(page);
    if (!view?.textarea?.className.includes("settings-textarea") || !view.help) {
      throw new Error("agents.md 编辑器结构异常");
    }
    await fillDocEditor(page, MARKER_AGENTS);
    await saveDocEditor(page, "agents.md");
    pass("保存 agents.md — 按钮反馈");

    const agentsAfterSave = (await api("GET", "/api/settings/agents-md")).content;
    if (agentsAfterSave !== MARKER_AGENTS) throw new Error("API agents.md 与 UI 保存不一致");
    pass("保存 agents.md — API 校验");

    // 4. Edit and save memory.md
    await backToDocList(page);
    await openDocEditor(page, "memory.md");
    await fillDocEditor(page, MARKER_MEMORY);
    await saveDocEditor(page, "memory.md");
    pass("保存 memory.md — 按钮反馈");

    const memoryAfterSave = (await api("GET", "/api/settings/memory-md")).content;
    if (memoryAfterSave !== MARKER_MEMORY) throw new Error("API memory.md 与 UI 保存不一致");
    pass("保存 memory.md — API 校验");

    // 5. Verify persistence after page reload
    await page.reload({ waitUntil: "networkidle2" });
    await openSettings(page);
    await openAgentBehavior(page);
    await openDocEditor(page, "agents.md");
    await waitForDocValue(page, MARKER_AGENTS);
    view = await getAgentDocsView(page);
    if (view?.textarea?.value !== MARKER_AGENTS) throw new Error("刷新后 agents.md 未持久化");
    await backToDocList(page);
    await openDocEditor(page, "memory.md");
    await waitForDocValue(page, MARKER_MEMORY);
    view = await getAgentDocsView(page);
    if (view?.textarea?.value !== MARKER_MEMORY) throw new Error("刷新后 memory.md 未持久化");
    await backToDocList(page);
    pass("刷新后 textarea 内容持久化");

    // 6. Switch to English i18n
    await selectLanguage(page, "en");
    await sleep(400);
    await openAgentBehavior(page);
    view = await getAgentDocsView(page);
    if (!view?.title?.includes("Agent Behavior")) throw new Error(`英文标题: ${view?.title}`);
    if (!view.rows.some((row) => row.title.includes("Instructions"))) throw new Error(`英文 rows: ${JSON.stringify(view.rows)}`);
    if (!view.rows.some((row) => row.title.includes("Long-term Memory"))) throw new Error(`英文 rows: ${JSON.stringify(view.rows)}`);
    pass("切换 English — i18n 文案");

    // 7. Save button label in English locale
    await selectLanguage(page, "zh");
    await sleep(300);
    await openAgentBehavior(page);
    pass("切回中文");

    // 8. Save empty content
    await openDocEditor(page, "agents.md");
    await fillDocEditor(page, "");
    await saveDocEditor(page, "agents.md");
    if ((await api("GET", "/api/settings/agents-md")).content !== "") throw new Error("空 agents.md 保存失败");
    pass("空内容保存 agents.md");

    await fillDocEditor(page, MARKER_AGENTS);
    await saveDocEditor(page, "agents.md");
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
  process.exitCode = failed.length ? 1 : 0;
}

main();

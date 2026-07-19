#!/usr/bin/env node
/** Verify # command routing and ensure plain shell input does not invoke the AI. */

import puppeteer from "puppeteer-core";

const APP = process.env.WINKTERM_APP || "http://127.0.0.1:3000";
const API = process.env.WINKTERM_API || "http://127.0.0.1:8000";
const CHROME =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const suffix = `${Date.now()}`.slice(-9);
const sessionId = `tab-${suffix}`;
const marker = `WINKTERM_AI_REPLY_${suffix}`;
const plainMarker = `WINKTERM_PLAIN_${suffix}`;
let browser;

async function deleteSession() {
  const response = await fetch(`${API}/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`session cleanup failed: HTTP ${response.status}`);
  }
}

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 1400, height: 900 },
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(String(error)));

  await page.evaluateOnNewDocument((id) => {
    localStorage.setItem(
      "winkterm-split-state",
      JSON.stringify({
        layout: "single",
        panes: [
          {
            id: "pane-1",
            tabs: [{ id, title: "AI reply smoke", type: "local" }],
            activeTabId: id,
          },
        ],
      })
    );
  }, sessionId);

  await page.goto(APP, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".xterm-helper-textarea")].some((element) => {
        const rect = element.closest(".xterm")?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0;
      }),
    { timeout: 20000 }
  );
  // PowerShell prompts contain styled spans and may not expose the literal prompt
  // marker through textContent. Give xterm and the debounced PTY spawn time to settle.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  await page.evaluate(() => {
    const textarea = [...document.querySelectorAll(".xterm-helper-textarea")].find((element) => {
      const rect = element.closest(".xterm")?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0;
    });
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("visible xterm input not found");
    }
    textarea.focus();
  });
  await page.keyboard.type(`# Reply with exactly ${marker}`);
  await page.keyboard.press("Enter");

  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll(".xterm-rows")].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return /# winkterm:\s*\S/.test(rows?.textContent || "");
    },
    { timeout: 120000 }
  );

  let terminalText = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".xterm-rows")].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return rows?.textContent?.trim() || "";
  });
  const replyCountBefore = (terminalText.match(/# winkterm:/g) || []).length;

  await page.evaluate(() => {
    const textarea = [...document.querySelectorAll(".xterm-helper-textarea")].find((element) => {
      const rect = element.closest(".xterm")?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0;
    });
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("visible xterm input not found");
    }
    textarea.focus();
  });
  await page.keyboard.type(`echo ${plainMarker}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (needle) => {
      const rows = [...document.querySelectorAll(".xterm-rows")].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return (rows?.textContent?.split(needle).length || 0) >= 3;
    },
    { timeout: 10000 },
    plainMarker
  );
  await new Promise((resolve) => setTimeout(resolve, 15000));

  terminalText = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".xterm-rows")].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return rows?.textContent?.trim() || "";
  });
  const replyCountAfter = (terminalText.match(/# winkterm:/g) || []).length;
  if (replyCountAfter !== replyCountBefore) {
    throw new Error("plain shell command unexpectedly invoked the AI");
  }
  if (browserErrors.length) {
    throw new Error(`browser errors: ${browserErrors.join(" | ")}`);
  }
  console.log(
    JSON.stringify({ ok: true, session_id: sessionId, marker, plain_marker: plainMarker, terminal: terminalText })
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, session_id: sessionId, error: String(error) }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  try {
    await deleteSession();
  } catch (error) {
    console.error(JSON.stringify({ cleanup_warning: String(error) }));
  }
}

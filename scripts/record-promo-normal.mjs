#!/usr/bin/env node
/**
 * Record assets/promo.mp4 — single-column UI, multiple SSH tabs, Craft multi-SSH orchestration.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FRAMES = path.join(ROOT, ".capture-frames", "promo");
const ASSETS = path.join(ROOT, "assets");
const BASE = process.env.WINKTERM_BASE || "http://localhost:8000";
const APP = process.env.WINKTERM_APP || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIN_RECORD_MS = Number(process.env.PROMO_MIN_MS || 45000);
const MAX_RECORD_MS = Number(process.env.PROMO_MAX_MS || 240000);
const FRAME_SEC = Number(process.env.PROMO_FRAME_SEC || 2.8);
const SSH_TAB_COUNT = Number(process.env.PROMO_SSH_TABS || 3);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(token, method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function runFfmpeg(args) {
  const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed");
}

async function resetChatHistory(token) {
  const { conversations = [] } = await api(token, "GET", "/api/chat/conversations");
  for (const c of conversations) {
    try {
      await api(token, "DELETE", `/api/chat/conversations/${encodeURIComponent(c.id)}`);
    } catch {
      /* ignore */
    }
  }
  console.log("Cleared chat conversations:", conversations.length);
}

async function startFreshCraftChat(page) {
  await page.click(".ai-tab-new");
  await sleep(600);
  const empty = await page.waitForSelector(".ai-empty", { timeout: 8000 }).catch(() => null);
  if (!empty) {
    await page.click(".ai-header-icon-btn");
    await sleep(600);
  }
}

function loadSshTargets(n) {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".winkterm/config.json"), "utf8")
  );
  const list = cfg.ssh_connections || [];
  if (list.length < 2) throw new Error("Need at least 2 ssh_connections in config");
  return list.slice(0, n).map((c) => ({
    connId: c.id,
    title: c.title || c.name || "SSH",
  }));
}

async function main() {
  const settings = await fetch(`${BASE}/api/settings`).then((r) => r.json());
  const theme = settings.theme || "system";
  const language = settings.language || "zh";
  const targets = loadSshTargets(SSH_TAB_COUNT);

  const { token } = await fetch(`${BASE}/api/agent/handshake`).then((r) => r.json());
  await resetChatHistory(token);
  console.log("SSH tabs:", targets.map((t) => t.title).join(", "));

  const sessions = [];
  for (const t of targets) {
    const term = await api(token, "POST", "/api/agent/terminals", {
      type: "ssh",
      connection_id: t.connId,
      name: t.title,
    });
    sessions.push({ ...t, id: term.id });
  }

  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1440,900",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(
    (payload) => {
      localStorage.setItem("winkterm-language", payload.language);
      localStorage.setItem("winkterm-theme", payload.theme);
      localStorage.setItem("winkterm-ai-visible", "true");
      localStorage.setItem("winkterm-onboarded", "1");
      localStorage.setItem("winkterm-split-state", JSON.stringify(payload.seed));
    },
    {
      language,
      theme,
      seed: {
        layout: "single",
        panes: [
          {
            id: "pane-1",
            tabs: sessions.map((s) => ({
              id: s.id,
              title: s.title,
              type: "ssh",
              sshConnectionId: s.connId,
            })),
            activeTabId: sessions[0].id,
          },
        ],
      },
    }
  );

  await page.goto(APP, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".activity-bar .activity-item", { timeout: 30000 });
  await page.waitForSelector(".xterm-screen", { timeout: 60000 });
  await page.waitForSelector(".tab-bar .tab", { timeout: 30000 });

  console.log("Waiting for SSH shells...");
  await sleep(14000);

  for (const s of sessions) {
    try {
      await api(token, "POST", `/api/agent/terminals/${s.id}/exec`, {
        command: `echo "=== ${s.title} ===" && hostname && uptime`,
        enter: true,
        timeout: 25,
      });
    } catch (e) {
      console.warn("  exec warn", s.title, e.message);
    }
    await sleep(400);
  }

  const promoFrames = [];
  let snapIdx = 0;
  const snapPromo = async (tag, dwell = 0) => {
    const f = path.join(FRAMES, `promo-${String(snapIdx++).padStart(2, "0")}-${tag}.png`);
    await page.screenshot({ path: f, type: "png" });
    promoFrames.push(f);
    console.log("  snap", tag);
    if (dwell) await sleep(dwell);
  };

  const getAiHtml = () =>
    page.evaluate(() => document.querySelector(".ai-messages")?.innerHTML || "");

  const getActiveTab = () =>
    page.evaluate(() => {
      const tab = document.querySelector(".tab-bar .tab.active");
      return tab?.textContent?.trim() || "";
    });

  const countSshTools = (html) => {
    const names = (html.match(/tool-call-name[^>]*>([^<]+)/g) || []).map((m) =>
      m.replace(/.*>/, "")
    );
    const sshish = names.filter((n) =>
      /ssh_run|list_ssh|create_terminal|terminal_exec/i.test(n)
    );
    return { names, sshish: sshish.length };
  };

  await snapPromo("00-multi-tabs", 3000);

  await page.click(".ai-mode-btn");
  await sleep(400);
  await page.evaluate(() => {
    const craft = [...document.querySelectorAll(".ai-mode-option")].find((el) =>
      /Craft/i.test(el.textContent || "")
    );
    craft?.click();
  });
  await sleep(500);
  await startFreshCraftChat(page);
  await snapPromo("01-craft-fresh", 1500);

  const craftPrompt =
    "New task. I have 3 SSH tabs in one terminal column: Hangzhou, Huana, Hong Kong. " +
    "Run `df -h` on each server using ssh_run or terminal_exec. " +
    "Do NOT run docker, nginx, or app deploy commands. " +
    "Compare disk usage and report which hosts are nearly full.";
  const inputSel = "textarea.ai-input";
  await page.waitForSelector(inputSel, { timeout: 15000 });
  await page.click(inputSel);
  await sleep(200);
  await page.keyboard.type(craftPrompt, { delay: 14 });
  await snapPromo("02-prompt", 1000);
  await page.keyboard.press("Enter");

  const promoStart = Date.now();
  let promoLast = "";
  let lastTab = await getActiveTab();
  let maxSshTools = 0;
  let stableSince = 0;

  while (Date.now() - promoStart < MAX_RECORD_MS) {
    await sleep(700);
    const html = await getAiHtml();
    const tab = await getActiveTab();
    const elapsed = Date.now() - promoStart;
    const { sshish } = countSshTools(html);
    maxSshTools = Math.max(maxSshTools, sshish);

    if (html !== promoLast) {
      promoLast = html;
      stableSince = Date.now();
      await snapPromo("ai-stream");
    }
    if (tab && tab !== lastTab) {
      lastTab = tab;
      await snapPromo(`tab-${tab.slice(0, 12)}`, 1200);
    }

    const streaming = await page.evaluate(
      () => !!document.querySelector(".ai-panel .ai-stop-btn, .ai-panel button[aria-label*='Stop']")
    );
    const hasAssistantEnd =
      /assistant-message|ai-message-assistant/i.test(html) &&
      !streaming &&
      elapsed > MIN_RECORD_MS;
    const enoughTools = maxSshTools >= 3;
    const stableMs = Date.now() - stableSince;

    if (
      elapsed > MIN_RECORD_MS &&
      enoughTools &&
      hasAssistantEnd &&
      stableMs > 8000
    ) {
      console.log("  done:", { elapsed, maxSshTools, stableMs });
      break;
    }
    if (!streaming && elapsed > MIN_RECORD_MS && enoughTools && stableMs > 12000) {
      console.log("  done (idle):", { elapsed, maxSshTools, stableMs });
      break;
    }
  }

  for (const s of sessions) {
    await page.evaluate((title) => {
      const tabs = [...document.querySelectorAll(".tab-bar .tab")];
      const tab = tabs.find((t) => t.textContent?.includes(title));
      tab?.click();
    }, s.title);
    await sleep(2200);
    await snapPromo(`show-${s.title.slice(0, 10)}`, 800);
  }

  await snapPromo("99-final", 2500);
  await browser.close();

  const list = promoFrames
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration ${FRAME_SEC}`)
    .join("\n");
  const last = promoFrames[promoFrames.length - 1];
  fs.writeFileSync(
    path.join(FRAMES, "promo-list.txt"),
    `${list}\nfile '${last.replace(/'/g, "'\\''")}'\n`
  );

  runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    path.join(FRAMES, "promo-list.txt"),
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xf5f5f5,format=yuv420p",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "22",
    "-movflags",
    "+faststart",
    path.join(ASSETS, "promo.mp4"),
  ]);

  for (const s of sessions) {
    try {
      await api(token, "DELETE", `/api/agent/terminals/${s.id}`);
    } catch {
      /* ignore */
    }
  }

  const stat = fs.statSync(path.join(ASSETS, "promo.mp4"));
  const durSec = Math.round(promoFrames.length * FRAME_SEC);
  console.log(
    "OK promo.mp4",
    Math.round(stat.size / 1024),
    "KB,",
    promoFrames.length,
    "frames, ~",
    durSec,
    "s, sshTools:",
    maxSshTools
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

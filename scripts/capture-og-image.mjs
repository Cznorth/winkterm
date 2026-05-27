#!/usr/bin/env node
/**
 * Capture assets/og-image-social.png from the approved demo.gif final frame (full UI).
 * Fallback: live capture with local terminal + Craft panel.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const NORMAL_FRAMES = path.join(ROOT, ".capture-frames", "normal");
const BASE = process.env.WINKTERM_BASE || "http://localhost:8000";
const APP = process.env.WINKTERM_APP || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runFfmpeg(args) {
  const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed");
}

function findDemoFinalFrame() {
  if (!fs.existsSync(NORMAL_FRAMES)) return null;
  const files = fs
    .readdirSync(NORMAL_FRAMES)
    .filter((f) => f.endsWith("-final.png"))
    .sort();
  return files.length ? path.join(NORMAL_FRAMES, files[files.length - 1]) : null;
}

function exportOg(src) {
  runFfmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    "scale=1200:630:force_original_aspect_ratio=decrease,pad=1200:630:(ow-iw)/2:(oh-ih)/2:color=0xf5f5f5",
    "-frames:v",
    "1",
    "-update",
    "1",
    path.join(ASSETS, "og-image-social.png"),
  ]);
  console.log("OK", path.join(ASSETS, "og-image-social.png"), "from", src);
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

async function captureLive() {
  const settings = await fetch(`${BASE}/api/settings`).then((r) => r.json());
  const { token } = await fetch(`${BASE}/api/agent/handshake`).then((r) => r.json());
  const { id: tid } = await api(token, "POST", "/api/agent/terminals", {
    type: "local",
    name: "demo",
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-sandbox", "--window-size=1440,900"],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(
    (p) => {
      localStorage.setItem("winkterm-language", p.language);
      localStorage.setItem("winkterm-theme", p.theme);
      localStorage.setItem("winkterm-ai-visible", "true");
      localStorage.setItem("winkterm-onboarded", "1");
      localStorage.setItem(
        "winkterm-split-state",
        JSON.stringify({
          layout: "single",
          panes: [
            {
              id: "pane-1",
              tabs: [{ id: p.tid, title: "Terminal", type: "local" }],
              activeTabId: p.tid,
            },
          ],
        })
      );
    },
    { language: settings.language || "zh", theme: settings.theme || "system", tid }
  );
  await page.goto(APP, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".layout-container", { timeout: 30000 });
  await sleep(3000);
  await page.click(".ai-tab-new").catch(() => {});
  await sleep(800);
  const shot = path.join(ROOT, ".capture-frames", "og-full.png");
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.$(".layout-container").then((el) => el?.screenshot({ path: shot, type: "png" }));
  await browser.close();
  try {
    await api(token, "DELETE", `/api/agent/terminals/${tid}`);
  } catch {
    /* ignore */
  }
  exportOg(shot);
}

async function main() {
  const fromDemo = process.env.OG_SOURCE || findDemoFinalFrame();
  if (fromDemo && fs.existsSync(fromDemo)) {
    exportOg(fromDemo);
    return;
  }
  console.log("No demo final frame, falling back to live capture...");
  await captureLive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

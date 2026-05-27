#!/usr/bin/env node
/**
 * Record README demo.gif with user's real UI settings (theme/language from API).
 * Scenario: SSH → ipconfig (error) → # what's wrong (real AI stream).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FRAMES = path.join(ROOT, ".capture-frames", "normal");
const ASSETS = path.join(ROOT, "assets");
const BASE = process.env.WINKTERM_BASE || "http://localhost:8000";
const APP = process.env.WINKTERM_APP || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const GIF_FPS = Number(process.env.GIF_FPS || 2.5);
const HOLD_MS = {
  default: 900,
  "ssh-shell": 1400,
  "ipconfig-err": 3500,
  "type-hash": 1200,
  final: 3000,
};

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

function sshConnId() {
  if (process.env.SSH_CONN_ID) return process.env.SSH_CONN_ID;
  const cfg = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".winkterm/config.json"), "utf8")
  );
  const list = cfg.ssh_connections || [];
  if (!list.length) throw new Error("No ssh_connections in ~/.winkterm/config.json");
  return list[0].id;
}

async function captureFrame(page, file) {
  await page.screenshot({ path: file, type: "png" });
}

function buildGifFromFrames(frameDir = FRAMES) {
  const files = fs
    .readdirSync(frameDir)
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (!files.length) throw new Error(`No frames in ${frameDir}`);
  const dur = Number(process.env.GIF_FRAME_SEC || 1.35);
  const list = files
    .map((f) => `file '${path.join(frameDir, f).replace(/'/g, "'\\''")}'\nduration ${dur}`)
    .join("\n");
  const last = path.join(frameDir, files[files.length - 1]);
  const listPath = path.join(frameDir, "gif-list.txt");
  fs.writeFileSync(listPath, `${list}\nfile '${last.replace(/'/g, "'\\''")}'\n`);
  runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    `fps=${GIF_FPS},scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse`,
    "-loop",
    "0",
    path.join(ASSETS, "demo.gif"),
  ]);
  console.log("OK demo.gif (rebuild)", files.length, "frames,", dur, "s each");
}

async function main() {
  if (process.env.REBUILD_GIF_ONLY === "1") {
    buildGifFromFrames();
    return;
  }
  const connId = sshConnId();
  const settings = await fetch(`${BASE}/api/settings`).then((r) => r.json());
  const theme = settings.theme || "system";
  const language = settings.language || "zh";

  const { token } = await fetch(`${BASE}/api/agent/handshake`).then((r) => r.json());
  const conn = (await api(token, "GET", "/api/agent/ssh/connections")).connections?.find(
    (c) => c.id === connId
  );
  const tabTitle = conn?.title || conn?.name || "SSH";

  console.log("SSH:", connId, tabTitle, "| theme:", theme, "| lang:", language);

  const term = await api(token, "POST", "/api/agent/terminals", {
    type: "ssh",
    connection_id: connId,
    name: tabTitle,
  });
  const tid = term.id;
  console.log("Session:", tid);

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
      localStorage.setItem("winkterm-ai-visible", "false");
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
            tabs: [
              {
                id: tid,
                title: tabTitle,
                type: "ssh",
                sshConnectionId: connId,
              },
            ],
            activeTabId: tid,
          },
        ],
      },
    }
  );

  await page.goto(APP, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".activity-bar .activity-item", { timeout: 30000 });
  await page.waitForSelector(".xterm-screen", { timeout: 60000 });

  const layoutOk = await page.evaluate(() => ({
    w: window.innerWidth,
    settings: !!document.querySelector(".activity-bar-bottom .activity-item"),
    theme: document.documentElement.getAttribute("data-theme"),
    lang: document.documentElement.lang,
  }));
  console.log("Layout check:", layoutOk);

  console.log("Waiting for SSH shell...");
  await sleep(10000);

  let frame = 0;
  const snap = async (tag) => {
    const f = path.join(FRAMES, `${String(frame++).padStart(3, "0")}-${tag}.png`);
    await captureFrame(page, f);
    console.log("  snap", tag);
    await sleep(HOLD_MS[tag] ?? HOLD_MS.default);
  };

  await page.evaluate(() => document.querySelector(".xterm-screen")?.click());
  await sleep(500);
  await snap("ssh-shell");

  await page.keyboard.type("ipconfig", { delay: 45 });
  await snap("type-ipconfig");
  await page.keyboard.press("Enter");
  await sleep(3200);
  await snap("ipconfig-err");

  const question = "# what's wrong";
  for (const ch of question) {
    await page.keyboard.type(ch, { delay: 55 });
  }
  await snap("type-hash");
  await page.keyboard.press("Enter");

  const start = Date.now();
  let last = "";
  while (Date.now() - start < 90000) {
    await sleep(500);
    const text = await page.evaluate(
      () => document.querySelector(".xterm-rows")?.textContent || ""
    );
    if (text !== last) {
      last = text;
      await snap("ai");
    }
    if (/winkterm|ip addr|Linux/i.test(text) && Date.now() - start > 8000) {
      await sleep(3500);
      const again = await page.evaluate(
        () => document.querySelector(".xterm-rows")?.textContent || ""
      );
      if (again === last) break;
    }
  }
  await sleep(1200);
  await snap("final");

  await browser.close();

  runFfmpeg([
    "-y",
    "-framerate",
    String(GIF_FPS),
    "-pattern_type",
    "glob",
    "-i",
    path.join(FRAMES, "*.png"),
    "-vf",
    `fps=${GIF_FPS},scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse`,
    "-loop",
    "0",
    path.join(ASSETS, "demo.gif"),
  ]);

  try {
    await api(token, "DELETE", `/api/agent/terminals/${tid}`);
  } catch {
    /* ignore */
  }

  const stat = fs.statSync(path.join(ASSETS, "demo.gif"));
  console.log("OK demo.gif", Math.round(stat.size / 1024), "KB");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/** Build the desktop frontend without embedding development backend URLs. */

import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");
const envPath = path.join(frontendDir, ".env.local");
const backupPath = path.join(frontendDir, ".env.local.build-bak");
const nextBin = path.join(frontendDir, "node_modules", "next", "dist", "bin", "next");

if (existsSync(backupPath)) {
  throw new Error(`temporary environment backup already exists: ${backupPath}`);
}

let movedEnv = false;
let result;
try {
  if (existsSync(envPath)) {
    renameSync(envPath, backupPath);
    movedEnv = true;
  }
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_API_URL;
  delete env.NEXT_PUBLIC_WS_URL;
  result = spawnSync(process.execPath, [nextBin, "build"], {
    cwd: frontendDir,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
} finally {
  if (movedEnv && existsSync(backupPath)) {
    renameSync(backupPath, envPath);
  }
}

if (result.signal) {
  console.error(`desktop frontend build terminated by ${result.signal}`);
}
process.exitCode = result.status ?? 1;

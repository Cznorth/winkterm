#!/usr/bin/env node
import { main } from "../src/mcp.js";

main().catch((err) => {
  process.stderr.write(`致命错误: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

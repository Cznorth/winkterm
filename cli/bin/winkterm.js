#!/usr/bin/env node
import { main } from "../src/index.js";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`致命错误: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });

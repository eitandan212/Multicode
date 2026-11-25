#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dataDir } from "./config.js";
import { startServer } from "./start.js";

const { url } = await startServer({ port: Number(process.env.PORT ?? 4317), strictPort: Boolean(process.env.PORT) });
console.log(`\n  MultiCode is running → ${url}\n  Data folder: ${dataDir()}\n`);
if (process.argv.includes("--open")) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

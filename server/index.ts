#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ConfigStore, dataDir } from "./config.js";
import { createProvider } from "./providers/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4317);
const host = "127.0.0.1";

const config = new ConfigStore();
await config.load();

const { app, runs } = createApp({
  config,
  projectsDir: path.join(dataDir(), "projects"),
  runsDir: path.join(dataDir(), "runs"),
  stateDir: dataDir(),
  providerFactory: createProvider,
  webDir: path.resolve(here, "../web"),
});

await runs.load();

app.listen(port, host, () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  MultiCode is running → ${url}\n  Data folder: ${dataDir()}\n`);
  if (process.argv.includes("--open")) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
});

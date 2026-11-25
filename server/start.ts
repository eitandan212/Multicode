import type { Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ConfigStore, dataDir } from "./config.js";
import { createProvider } from "./providers/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";

/** The preferred port if it's free, otherwise any free port. */
async function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, HOST, () => {
        const { port: got } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(got));
      });
    });
  try {
    return await tryPort(preferred);
  } catch {
    return tryPort(0);
  }
}

export interface Started {
  url: string;
  port: number;
  server: Server;
}

/** Starts MultiCode's local server (used by `npm start` and by the desktop app). */
export async function startServer(
  opts: { port?: number; strictPort?: boolean } = {},
): Promise<Started> {
  const preferred = opts.port ?? 4317;
  const port = opts.strictPort ? preferred : await freePort(preferred);
  const config = new ConfigStore();
  await config.load();
  const { app, runs } = createApp({
    config,
    projectsDir: path.join(dataDir(), "projects"),
    runsDir: path.join(dataDir(), "runs"),
    stateDir: dataDir(),
    publicOrigin: `http://localhost:${port}`,
    providerFactory: createProvider,
    webDir: path.resolve(here, "../web"),
  });
  await runs.load();
  await runs.loadLimits();
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, HOST, () => resolve(s));
    s.once("error", reject);
  });
  return { url: `http://localhost:${port}`, port, server };
}

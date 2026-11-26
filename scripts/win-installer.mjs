// Builds release/MultiCode-Setup-<version>.exe from release/win-unpacked with NSIS (makensis).
// Works on Windows, macOS and Linux, and needs no Wine: run `npm run dist:win`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const src = path.join(root, "release", "win-unpacked");
const out = path.join(root, "release", `MultiCode-Setup-${version}.exe`);
if (!existsSync(path.join(src, "MultiCode.exe"))) throw new Error("release/win-unpacked is missing; run electron-builder --win dir first");

const makensis = process.env.MAKENSIS ?? "makensis";
try {
  execFileSync(makensis, ["-VERSION"], { stdio: "ignore" });
} catch {
  throw new Error("makensis not found. Install NSIS: apt install nsis · brew install nsis · winget install NSIS.NSIS");
}
execFileSync(
  makensis,
  ["-V2", `-DVERSION=${version}`, `-DSRC_DIR=${src}`, `-DICON=${path.join(root, "build", "icon.ico")}`, `-DOUT_FILE=${out}`, path.join(root, "build", "installer.nsi")],
  { stdio: "inherit" },
);
console.log(`Installer: ${path.relative(root, out)} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);

// What the in-app updater reads: the newest version, its installer, and that file's SHA-256.
const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync(
  path.join(root, "release", "latest.json"),
  JSON.stringify(
    {
      version,
      file: path.basename(out),
      sha256,
      size: statSync(out).size,
      // Set by the release workflow: the installer lives on GitHub Releases, not in the repository.
      ...(process.env.RELEASE_URL_BASE ? { url: `${process.env.RELEASE_URL_BASE}/v${version}/${path.basename(out)}` } : {}),
    },
    null,
    2,
  ) + "\n",
);
console.log(`latest.json: ${version} ${sha256}`);

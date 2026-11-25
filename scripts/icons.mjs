// Renders assets/brand/icon.svg to PNGs and a multi-size Windows .ico (build/).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import pngToIco from "png-to-ico";
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const svg = readFileSync("assets/brand/icon.svg", "utf8");
const browser = await pw.chromium.launch();
const page = await browser.newPage();
const render = async (size) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
};
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) pngs.push(await render(s));
writeFileSync("build/icon.png", await render(512));
writeFileSync("build/icon.ico", await pngToIco(pngs));
await browser.close();
console.log("icons written");

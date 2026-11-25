// electron-builder hook: embeds the MultiCode icon and version info into MultiCode.exe.
// Done with resedit (pure JavaScript), so Windows builds work from Linux/macOS without Wine.
const fs = require("node:fs/promises");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const { NtExecutable, NtExecutableResource, Data, Resource } = await import("resedit");
  const { productFilename, info } = context.packager.appInfo
    ? { productFilename: context.packager.appInfo.productFilename, info: context.packager.appInfo }
    : { productFilename: "MultiCode", info: { version: "0.0.0" } };
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const exe = NtExecutable.from(await fs.readFile(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const icon = Data.IconFile.from(await fs.readFile(path.join(__dirname, "..", "build", "icon.ico")));
  const existing = Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = existing[0]?.id ?? 1;
  const lang = existing[0]?.lang ?? 1033;
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    lang,
    icon.icons.map((i) => i.data),
  );

  const [vi] = Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const [major, minor, patch] = String(info.version).split(".").map((n) => Number(n) || 0);
    vi.setFileVersion(major, minor, patch, 0, lang);
    vi.setProductVersion(major, minor, patch, 0, lang);
    vi.setStringValues(
      { lang, codepage: 1200 },
      {
        ProductName: "MultiCode",
        FileDescription: "MultiCode: one workspace, many minds",
        CompanyName: "MultiCode",
        OriginalFilename: `${productFilename}.exe`,
        InternalName: "MultiCode",
        LegalCopyright: `Copyright © ${new Date().getFullYear()} MultiCode`,
      },
    );
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  await fs.writeFile(exePath, Buffer.from(exe.generate()));
};

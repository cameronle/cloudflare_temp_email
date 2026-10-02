import { build } from "esbuild";
import { mkdir, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
await mkdir("bin", { recursive: true });
const result = await build({
  entryPoints: ["src/cli.mjs"],
  outfile: "bin/tmctl.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  legalComments: "none",
  metafile: true,
});
await chmod("bin/tmctl.mjs", 0o755);
const dirs = new Set(
  Object.keys(result.metafile.inputs)
    .filter((p) => p.startsWith("node_modules/"))
    .map((p) =>
      p
        .split("/")
        .slice(0, p.split("/")[1].startsWith("@") ? 3 : 2)
        .join("/"),
    ),
);
const notices = [
  "Bundled dependency licenses (build-only/test-only packages are not shipped).",
];
for (const dir of [...dirs].sort()) {
  const p = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  let license;
  for (const name of [
    "LICENSE",
    "LICENSE.txt",
    "LICENSE.md",
    "LICENSE-MIT",
    "LICENSE-MIT.txt",
    "LICENCE",
    "license.txt",
    "license",
  ]) {
    try {
      license = await readFile(join(dir, name), "utf8");
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (!license) throw new Error("Missing license for " + p.name);
  notices.push(
    `\n===== ${p.name}@${p.version} (${p.license}) =====\n${license}`,
  );
}
await writeFile("THIRD_PARTY_NOTICES", notices.join("\n"));
await writeFile("LICENSE", await readFile("../../LICENSE"));

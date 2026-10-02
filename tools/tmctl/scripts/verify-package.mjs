import { mkdtemp, realpath, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const dir = await realpath(await mkdtemp(join(tmpdir(), "tmctl-package-")));
function run(args, env = {}) {
  const r = spawnSync("npm", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180000,
  });
  if (r.status !== 0) throw new Error(r.stdout + "\n" + r.stderr);
  return r.stdout;
}
try {
  const packed = JSON.parse(
    run(["pack", "--ignore-scripts", "--json", "--pack-destination", dir]),
  )[0];
  const paths = packed.files.map((x) => x.path).sort();
  assert.deepEqual(
    paths,
    [
      "LICENSE",
      "README.md",
      "README_EN.md",
      "THIRD_PARTY_NOTICES",
      "bin/tmctl.mjs",
      "package.json",
    ].sort(),
  );
  const cache = join(dir, "empty-cache");
  await mkdir(cache);
  const prefix = join(dir, "installed");
  run(
    [
      "install",
      "--prefix",
      prefix,
      "--cache",
      cache,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(dir, packed.filename),
    ],
    { npm_config_registry: "http://127.0.0.1:9" },
  );
  const bin = join(
    prefix,
    "node_modules/cloudflare-temp-mail-cli/bin/tmctl.mjs",
  );
  const p = JSON.parse(
    await readFile(
      join(prefix, "node_modules/cloudflare-temp-mail-cli/package.json"),
      "utf8",
    ),
  );
  assert.equal(Object.keys(p.dependencies || {}).length, 0);
  const env = { TMCTL_TEST_BIN: bin };
  console.log(run(["test"], env));
  console.log(run(["run", "test:e2e"], env));
  console.log(
    JSON.stringify({
      offlineEmptyCache: true,
      files: paths,
      installedRealWorkerTests: true,
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

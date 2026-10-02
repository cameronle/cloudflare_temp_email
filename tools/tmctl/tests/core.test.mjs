import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";
test("standalone help/version, private bound profile and public health", async () => {
  assert.ok(
    existsSync(new URL("../src/cli.mjs", import.meta.url)),
    "tmctl executable must exist",
  );
  const home = await temp();
  const s = await server((req, res) =>
    req.url === "/health_check"
      ? res.end("OK")
      : json(res, {
          version: "v1.12.0",
          domains: ["example.test"],
          defaultDomains: ["example.test"],
          needAuth: false,
          disableAnonymousUserCreateEmail: true,
        }),
  );
  try {
    const ver = await cli(["--version"], { home });
    assert.equal(ver.code, 0);
    assert.match(ver.stdout, /0.1.0/);
    const help = await cli(["--help"], { home });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /mail/);
    assert.equal((await profile(home, s.url)).code, 0);
    assert.equal((await stat(home + "/test.json")).mode & 0o777, 0o600);
    const d = await cli(["--profile", "test", "doctor"], { home });
    assert.equal(d.code, 0, d.stdout);
    assert.equal(d.result.data.healthy, true);
    assert.equal(
      (
        await cli(["profile", "add", "bad", "--server", "http://example.org"], {
          home,
        })
      ).code,
      2,
    );
    const bad = await cli(["--not-a-real-flag", "SYNTHETIC-SECRET"], { home });
    assert.equal(bad.code, 2);
    assert.ok(!bad.stdout.includes("SYNTHETIC-SECRET"));
    assert.ok(
      s.requests.every((r) => r.method === "GET" && !r.headers["x-admin-auth"]),
    );
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});

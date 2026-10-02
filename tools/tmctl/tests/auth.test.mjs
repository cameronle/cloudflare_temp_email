import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, readFile, symlink, chmod, writeFile } from "node:fs/promises";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";
test("ephemeral and opt-in saved auth are origin bound, never leaked and local-only logout", async () => {
  const h = await temp();
  const secret = "fixture-admin-very-secret";
  const s = await server((req, res) => {
    if (req.headers["x-admin-auth"] !== secret)
      return json(res, { secret }, 401);
    if (req.url === "/admin/statistics")
      return json(res, {
        mailCount: 3,
        addressCount: 1,
        activeAddressCount7days: 1,
        activeAddressCount30days: 1,
        userCount: 0,
        sendMailCount: 0,
        secret,
      });
    if (req.url.startsWith("/admin/address"))
      return json(res, {
        results: [
          {
            id: 1,
            name: "a@example.test",
            password: secret,
            mail_count: 3,
            send_count: 0,
          },
        ],
        count: 1,
      });
    json(res, {
      enableMailsAutoCleanup: true,
      cleanMailsDays: 30,
      customSqlCleanupList: [{ sql: secret }],
    });
  });
  try {
    await profile(h, s.url);
    const input = JSON.stringify({ server: s.url, mode: "admin", secret });
    let r = await cli(["--profile", "test", "--credentials-stdin", "stats"], {
      home: h,
      input,
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.mailCount, 3);
    assert.ok(!r.stdout.includes(secret));
    assert.equal(
      (await cli(["--profile", "test", "stats"], { home: h })).code,
      3,
    );
    r = await cli(
      ["--profile", "test", "--credentials-stdin", "auth", "login", "--save"],
      { home: h, input },
    );
    assert.equal(r.code, 0, r.stdout);
    assert.equal((await stat(h + "/test.auth.json")).mode & 0o777, 0o600);
    r = await cli(["--profile", "test", "addresses", "list"], { home: h });
    assert.equal(r.code, 0, r.stdout);
    assert.ok(!r.stdout.includes(secret));
    assert.equal(r.result.data.items.length, 1);
    r = await cli(["--profile", "test", "cleanup", "show"], { home: h });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes(secret));
    r = await cli(["--profile", "test", "--credentials-stdin", "stats"], {
      home: h,
      input: JSON.stringify({
        server: "https://different.test",
        mode: "admin",
        secret,
      }),
    });
    assert.equal(r.code, 2);
    r = await cli(["--profile", "test", "auth", "logout"], { home: h });
    assert.equal(r.result.data.serverRevoked, false);
    assert.equal(
      (await cli(["--profile", "test", "stats"], { home: h })).code,
      3,
    );
    assert.ok(s.requests.every((x) => x.method === "GET"));
  } finally {
    await s.close();
    await rm(h, { recursive: true, force: true });
  }
});
test("redirects, HTML, response size, raw error bodies and unknown routes fail closed", async () => {
  const { Client } = await import("../src/http.mjs");
  const h = await temp();
  let mode = "redirect";
  let leaked = 0;
  const trap = await server((req, res) => {
    leaked++;
    json(res, {});
  });
  const s = await server((req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { Location: trap.url });
      res.end();
    } else if (mode === "html") {
      res.end("<html>SECRET</html>");
    } else if (mode === "large") {
      res.setHeader("content-type", "application/json");
      res.end("x".repeat(17 * 1024 * 1024));
    } else json(res, { password: "SECRET" }, 500);
  });
  try {
    const c = new Client(
      { server: s.url },
      { server: s.url, mode: "admin", secret: "SECRET" },
      500,
    );
    for (const m of ["redirect", "html", "large", "error"]) {
      mode = m;
      await assert.rejects(
        c.get("/admin/statistics"),
        (e) => !e.message.includes("SECRET"),
      );
    }
    assert.equal(leaked, 0);
    assert.equal(s.requests.length, 4);
    const n = s.requests.length;
    await assert.rejects(c.get("/admin/show_password/1"));
    assert.equal(s.requests.length, n);
  } finally {
    await trap.close();
    await s.close();
    await rm(h, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, chmod, link, symlink, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { temp, rm, server, json, profile } from "./helpers.mjs";
import { privateRead, privatePublish } from "../src/files.mjs";
import { clean } from "../src/errors.mjs";
import { origin } from "../src/store.mjs";
import { Client } from "../src/http.mjs";
import { list, row } from "../src/mail.mjs";
test("private input denies permissive files, links, oversize and non-files; publish never overwrites", async () => {
  const h = await temp();
  try {
    await writeFile(h + "/secret", "synthetic", { mode: 0o600 });
    assert.equal((await privateRead(h + "/secret")).toString(), "synthetic");
    await chmod(h + "/secret", 0o644);
    await assert.rejects(() => privateRead(h + "/secret"));
    await chmod(h + "/secret", 0o600);
    await link(h + "/secret", h + "/hard");
    await assert.rejects(() => privateRead(h + "/secret"));
    await symlink(h + "/secret", h + "/sym");
    await assert.rejects(() => privateRead(h + "/sym"));
    await assert.rejects(() => privateRead(h));
    await writeFile(h + "/big", Buffer.alloc(16385), { mode: 0o600 });
    await assert.rejects(() => privateRead(h + "/big"));
    await assert.rejects(() =>
      privatePublish(h + "/secret", Buffer.from("replacement")),
    );
    await mkdir(h + "/unsafe", { mode: 0o777 });
    await chmod(h + "/unsafe", 0o777);
    await assert.rejects(() =>
      privatePublish(h + "/unsafe/out", Buffer.from("x")),
    );
  } finally {
    await rm(h, { recursive: true, force: true });
  }
});
test("HTTPS profile binding rejects credentials, paths, query and nonnumeric HTTP host", () => {
  for (const x of [
    "http://example.test",
    "https://u:p@example.test",
    "https://example.test/path",
    "https://example.test/?secret=x",
    "https://example.test/#x",
    "http://localhost:1234",
  ])
    assert.throws(() => origin(x, true));
  assert.equal(origin("https://example.test"), "https://example.test");
});
test("terminal escapes and bidi controls are removed", () => {
  const s = clean("ok\x1b[31mred\x1b[0m\x1b]52;c;payload\x07\u202eevil\x00");
  assert.equal(s, "okredevil");
});
test("mail pages enforce order, exact recipient, uniqueness, limits and retained-size", async () => {
  let rows = [];
  const s = await server((req, res) =>
    json(res, { results: rows, count: 200 }),
  );
  try {
    const c = new Client(
      { server: s.url },
      { server: s.url, mode: "admin", secret: "synthetic" },
    );
    const r = (id, a = "a@example.test") => ({
      id,
      address: a,
      raw: "Subject: a\r\n\r\nx",
    });
    for (const a of [
      [r(1), r(2)],
      [r(2), r(2)],
      [r(2, "wrong@example.test")],
    ]) {
      rows = a;
      await assert.rejects(() => list(c, { address: "a@example.test" }));
    }
    rows = [r(2)];
    assert.equal((await list(c, { offset: "20" })).count, null);
    assert.throws(() =>
      row({ ...r(2), raw: "x".repeat(12 * 1024 * 1024 + 1) }),
    );
  } finally {
    await s.close();
  }
});
test("site password only accompanies bound authenticated paths; request timeout is bounded", async () => {
  let hang = false;
  const s = await server((req, res) => {
    if (hang) return;
    json(res, {});
  });
  try {
    const c = new Client(
      { server: s.url },
      {
        server: s.url,
        mode: "admin",
        secret: "synthetic-admin",
        sitePassword: "synthetic-site",
      },
      100,
    );
    await c.get("/admin/statistics");
    await c.get("/open_api/settings");
    assert.equal(s.requests[0].headers["x-custom-auth"], "synthetic-site");
    assert.equal(s.requests[1].headers["x-custom-auth"], undefined);
    assert.equal(s.requests[1].headers["x-admin-auth"], undefined);
    hang = true;
    await assert.rejects(
      () => c.get("/admin/statistics"),
      (e) => e.code === "TIMEOUT",
    );
  } finally {
    await s.close();
  }
});
test("SIGINT cancels a live watcher without leaking supplied credentials", async () => {
  const h = await temp();
  let ready;
  const polled = new Promise((r) => (ready = r));
  const s = await server((req, res) => {
    json(res, { results: [], count: 0 });
    ready();
  });
  try {
    await profile(h, s.url);
    const p = spawn(
      process.execPath,
      [
        new URL("../src/cli.mjs", import.meta.url).pathname,
        "--profile",
        "test",
        "--credentials-stdin",
        "mail",
        "wait",
        "--address",
        "box@example.test",
      ],
      {
        env: { ...process.env, TMCTL_HOME: h },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.stdin.end(
      JSON.stringify({
        server: s.url,
        mode: "admin",
        secret: "synthetic-cancel-secret",
      }),
    );
    await polled;
    const exited = new Promise((r) =>
      p.on("exit", (code, signal) => r({ code, signal })),
    );
    p.kill("SIGINT");
    const r = await exited;
    assert.equal(r.signal, "SIGINT");
    assert.ok(!out.includes("synthetic-cancel-secret"));
  } finally {
    await s.close();
    await rm(h, { recursive: true, force: true });
  }
});

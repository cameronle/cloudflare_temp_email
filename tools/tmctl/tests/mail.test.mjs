import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";
export const raw = [
  "From: Sender <sender@example.test>",
  "To: orphan@example.test",
  "Subject: =?UTF-8?B?5rWL6K+V?=",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<style>secret</style><script>bad()</script><p>Hello &amp; world</p>",
  "--b",
  "Content-Type: application/octet-stream",
  'Content-Disposition: attachment; filename="../../escape.bin"',
  "Content-Transfer-Encoding: base64",
  "",
  "AAECAwQ=",
  "--b--",
  "",
].join("\r\n");
test("unknown mail metadata, safe HTML fallback, exact EML export and explicit attachment output", async () => {
  const h = await temp();
  const row = {
    id: 7,
    address: "orphan@example.test",
    source: "sender@example.test",
    raw,
    metadata: "SECRET",
    created_at: "2026-10-02 08:00:00",
  };
  const s = await server((req, res) =>
    json(
      res,
      req.url.includes("/mails?") || req.url.includes("mails_unknow?")
        ? { results: [row], count: 1 }
        : row,
    ),
  );
  try {
    await profile(h, s.url);
    const input = JSON.stringify({
      server: s.url,
      mode: "admin",
      secret: "fixture",
    });
    const run = (a) =>
      cli(["--profile", "test", "--credentials-stdin", "mail", ...a], {
        home: h,
        input,
      });
    let r = await run(["list", "--unknown-address"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.items[0].subject, "测试");
    assert.ok(!r.stdout.includes("SECRET"));
    assert.ok(!r.stdout.includes("Hello"));
    r = await run(["show", "7"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.result.data.text, /Hello & world/);
    assert.ok(!r.result.data.text.includes("bad()"));
    assert.equal(r.result.data.attachments[0].bytes, 5);
    r = await run(["show", "7", "--address", "different@example.test"]);
    assert.notEqual(r.code, 0);
    r = await run(["export", "7", "--output", h + "/mail.eml"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(await readFile(h + "/mail.eml", "utf8"), raw);
    assert.equal((await stat(h + "/mail.eml")).mode & 0o777, 0o600);
    assert.notEqual(
      (await run(["export", "7", "--output", h + "/mail.eml"])).code,
      0,
    );
    r = await run([
      "attachment",
      "7",
      "--index",
      "1",
      "--output",
      h + "/safe.bin",
    ]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(
      await readFile(h + "/safe.bin"),
      Buffer.from([0, 1, 2, 3, 4]),
    );
    await symlink(h + "/safe.bin", h + "/link.bin");
    assert.notEqual(
      (
        await run([
          "attachment",
          "7",
          "--index",
          "1",
          "--output",
          h + "/link.bin",
        ])
      ).code,
      0,
    );
    assert.ok(s.requests.every((x) => x.method === "GET"));
    assert.ok(s.requests.some((x) => x.url.startsWith("/admin/mails_unknow")));
  } finally {
    await s.close();
    await rm(h, { recursive: true, force: true });
  }
});

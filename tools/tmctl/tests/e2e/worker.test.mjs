import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture } from "./worker.mjs";
import { cli, temp, rm, profile } from "../helpers.mjs";
const mime = (subject) =>
  `From: Sender <sender@example.test>\r\nTo: orphan@example.test\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic fixture only`;
test(
  "real workerd D1/KV: unknown catch-all, admin/mailbox boundaries, read-only data and live wait",
  { timeout: 90000 },
  async () => {
    const h = await temp();
    const f = await fixture();
    try {
      const a = await f.create("owned"),
        b = await f.create("other");
      await f.receive("orphan@example.test", mime("Old orphan"));
      await f.receive(a.address, mime("Own mailbox"));
      await f.receive(b.address, mime("Other mailbox"));
      await profile(h, f.url);
      const creds = (mode, secret) =>
        JSON.stringify({ server: f.url, mode, secret });
      const run = (args, input = creds("admin", "fixture-admin")) =>
        cli(["--profile", "test", "--credentials-stdin", ...args], {
          home: h,
          input,
          bin:
            process.env.TMCTL_TEST_BIN ||
            new URL("../../bin/tmctl.mjs", import.meta.url).pathname,
        });
      await f.db
        .prepare("UPDATE address SET updated_at='2000-01-01 00:00:00'")
        .run();
      const before = await f.fingerprint();
      let r = await run(["stats"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.mailCount, 3);
      r = await run(["mail", "list", "--unknown-address"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.items.length, 1);
      const orphan = r.result.data.items[0].id;
      r = await run(["mail", "show", String(orphan)]);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.result.data.text, /Synthetic fixture/);
      r = await run([
        "mail",
        "export",
        String(orphan),
        "--output",
        h + "/real.eml",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(await readFile(h + "/real.eml", "utf8"), mime("Old orphan"));
      r = await run(["mail", "list"], creds("mailbox", a.jwt));
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.items.length, 1);
      assert.equal(r.result.data.items[0].address, a.address);
      r = await run(["mail", "show", String(orphan)], creds("mailbox", a.jwt));
      assert.equal(r.code, 4, r.stdout);
      r = await run(["stats"], creds("mailbox", a.jwt));
      assert.notEqual(r.code, 0);
      r = await run(["stats"], creds("admin", "wrong"));
      assert.equal(r.code, 3, r.stdout);
      r = await run(["mail", "list"], creds("mailbox", "bad-token"));
      assert.equal(r.code, 3, r.stdout);
      r = await run(["addresses", "list"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.items.length, 2);
      assert.equal(
        await f.fingerprint(),
        before,
        "read operations must not mutate business state",
      );
      assert.notEqual(
        await f.db
          .prepare("SELECT updated_at FROM address WHERE name=?")
          .bind(a.address)
          .first("updated_at"),
        "2000-01-01 00:00:00",
        "mailbox reads refresh activity",
      );
      const wait = run([
        "mail",
        "wait",
        "--address",
        "orphan@example.test",
        "--subject",
        "Arrived",
        "--interval",
        "200ms",
        "--timeout",
        "5s",
      ]);
      await new Promise((r) => setTimeout(r, 1000));
      await f.receive("orphan@example.test", mime("Arrived now"));
      r = await wait;
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.mail.subject, "Arrived now");
      assert.ok(r.result.data.mail.id > r.result.data.baselineId);
      const orphanAddress = await f.db
        .prepare(
          "SELECT count(*) AS n FROM address WHERE name='orphan@example.test'",
        )
        .first("n");
      assert.equal(orphanAddress, 0);
    } finally {
      await f.close();
      await rm(h, { recursive: true, force: true });
    }
  },
);

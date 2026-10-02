import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture } from "./worker.mjs";
import { cli, temp, rm, profile } from "../helpers.mjs";
const mime = (subject) =>
  `From: sender@example.test\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nSynthetic fixture only`;

test(
  "real workerd: confirmed creation/profile, exact read markers and sender queries never send/delete or bind accounts",
  { timeout: 90000 },
  async () => {
    const h = await temp();
    const f = await fixture({
      ENABLE_MAIL_READ_STATUS: true,
      ENABLE_ADDRESS_PASSWORD: true,
      DEFAULT_SEND_BALANCE: 5,
      RESEND_TOKEN: "synthetic-outbound-disabled",
    });
    try {
      await profile(h, f.url);
      const input = JSON.stringify({
        server: f.url,
        mode: "admin",
        secret: "fixture-admin",
      });
      const bin =
        process.env.TMCTL_TEST_BIN ||
        new URL("../../bin/tmctl.mjs", import.meta.url).pathname;
      const admin = (args) =>
        cli(["--profile", "test", "--credentials-stdin", ...args], {
          home: h,
          input,
          bin,
        });
      const box = (args) =>
        cli(["--profile", "created", ...args], { home: h, bin });
      const before = await f.fingerprint();
      let r = await admin([
        "addresses",
        "create",
        "--name",
        "cliowned",
        "--domain",
        "example.test",
        "--save-profile",
        "created",
        "--dry-run",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(await f.fingerprint(), before);
      r = await admin([
        "addresses",
        "create",
        "--name",
        "cliowned",
        "--domain",
        "example.test",
        "--save-profile",
        "created",
        "--yes",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.verified, true);
      const saved = JSON.parse(
        await readFile(h + "/created.auth.json", "utf8"),
      );
      assert.equal(saved.mode, "mailbox");
      assert.ok(!r.stdout.includes(saved.secret));
      assert.ok(!Object.hasOwn(r.result.data, "password"));
      assert.equal(
        await f.db.prepare("SELECT COUNT(*) n FROM users_address").first("n"),
        0,
      );
      assert.equal(
        await f.db
          .prepare("SELECT balance FROM address_sender WHERE address=?")
          .bind("cliowned@example.test")
          .first("balance"),
        5,
        "server settings initialize default balance; documented read side effect",
      );
      await f.receive("cliowned@example.test", mime("Created mailbox inbound"));
      await f.receive("orphan@example.test", mime("Unchanged orphan"));
      const id = String(
        await f.db
          .prepare("SELECT id FROM raw_mails WHERE address=?")
          .bind("cliowned@example.test")
          .first("id"),
      );
      const retained = await f.db
        .prepare("SELECT raw FROM raw_mails WHERE id=?")
        .bind(id)
        .first("raw");
      await f.db.prepare("UPDATE raw_mails SET is_unread=1").run();
      r = await box([
        "mail",
        "mark",
        id,
        "--address",
        "cliowned@example.test",
        "--read",
        "--dry-run",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(
        await f.db
          .prepare("SELECT is_unread FROM raw_mails WHERE id=?")
          .bind(id)
          .first("is_unread"),
        1,
      );
      r = await box([
        "mail",
        "mark",
        id,
        "--address",
        "cliowned@example.test",
        "--read",
        "--yes",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.verified, true);
      assert.equal(
        await f.db
          .prepare("SELECT is_unread FROM raw_mails WHERE id=?")
          .bind(id)
          .first("is_unread"),
        0,
      );
      assert.equal(
        await f.db
          .prepare(
            "SELECT is_unread FROM raw_mails WHERE address='orphan@example.test'",
          )
          .first("is_unread"),
        1,
      );
      r = await box([
        "mail",
        "mark",
        id,
        "--address",
        "cliowned@example.test",
        "--unread",
        "--yes",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(
        await f.db
          .prepare("SELECT is_unread FROM raw_mails WHERE id=?")
          .bind(id)
          .first("is_unread"),
        1,
      );
      assert.equal(
        await f.db
          .prepare("SELECT raw FROM raw_mails WHERE id=?")
          .bind(id)
          .first("raw"),
        retained,
      );
      r = await admin([
        "mail",
        "mark",
        id,
        "--address",
        "cliowned@example.test",
        "--read",
        "--yes",
      ]);
      assert.equal(r.code, 2);
      const other = await f.create("other");
      const orphanId = String(
        await f.db
          .prepare(
            "SELECT id FROM raw_mails WHERE address='orphan@example.test'",
          )
          .first("id"),
      );
      r = await box([
        "mail",
        "mark",
        orphanId,
        "--address",
        "orphan@example.test",
        "--read",
        "--yes",
      ]);
      assert.equal(r.code, 4);
      const random = await admin([
        "addresses",
        "create",
        "--random-name",
        "--domain",
        "example.test",
        "--save-profile",
        "random",
        "--yes",
      ]);
      assert.equal(random.code, 0, random.stdout);
      assert.match(random.result.data.address, /^[0-9a-f]{20}@example\.test$/);
      // Synthetic retained history, not an external send.
      await f.db
        .prepare("INSERT INTO sendbox(address,raw) VALUES (?,?)")
        .bind(
          "cliowned@example.test",
          JSON.stringify({
            version: "v2",
            to_mail: "recipient@example.test",
            subject: "History only",
            content: "No delivery",
            is_html: false,
          }),
        )
        .run();
      const afterWrites = await f.fingerprint();
      r = await box(["outbox", "list"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.items.length, 1);
      r = await admin(["outbox", "list", "--address", other.address]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.items.length, 0);
      r = await admin(["send-access", "list"]);
      assert.equal(r.code, 0, r.stdout);
      r = await admin([
        "send-access",
        "show",
        "--address",
        "cliowned@example.test",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.grant.balance, 5);
      r = await box([
        "send-access",
        "show",
        "--address",
        "cliowned@example.test",
      ]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.reportedBalance, 5);
      assert.equal(
        await f.fingerprint(),
        afterWrites,
        "queries must not send/delete/change business data after documented settings initialization",
      );
      assert.equal(
        await f.db.prepare("SELECT count(*) n FROM raw_mails").first("n"),
        2,
      );
      assert.equal(
        await f.db.prepare("SELECT count(*) n FROM sendbox").first("n"),
        1,
      );
    } finally {
      await f.close();
      await rm(h, { recursive: true, force: true });
    }
  },
);

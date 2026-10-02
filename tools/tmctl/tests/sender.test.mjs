import { test } from "node:test";
import assert from "node:assert/strict";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";

test("outbox lists retained JSON metadata without body/extra secrets for admin and bound mailbox", async () => {
  const home = await temp();
  const s = await server((req, res) => {
    if (req.url === "/api/settings")
      return json(res, { address: "box@example.test", send_balance: 3 });
    if (
      req.url.startsWith("/admin/sendbox?") ||
      req.url.startsWith("/api/sendbox?")
    )
      return json(res, {
        results: [
          {
            id: 3,
            address: "box@example.test",
            raw: JSON.stringify({
              version: "v2",
              to_mail: "recipient@example.test",
              subject: "Fixture\u001b[31m",
              content: "synthetic-body-hidden",
              is_html: false,
              token: "synthetic-extra-token",
            }),
            created_at: "2026-01-01 00:00:00",
            password: "synthetic-row-password",
          },
        ],
        count: 1,
      });
    json(res, {}, 404);
  });
  try {
    await profile(home, s.url);
    for (const mode of ["admin", "mailbox"]) {
      const r = await cli(
        [
          "--profile",
          "test",
          "--credentials-stdin",
          "outbox",
          "list",
          "--address",
          "box@example.test",
        ],
        {
          home,
          input: JSON.stringify({
            server: s.url,
            mode,
            secret: "synthetic-read-secret",
          }),
        },
      );
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.result.data.items[0].subject, "Fixture");
      assert.deepEqual(r.result.data.items[0].to, ["recipient@example.test"]);
      assert.equal(r.result.data.totalAtFirstPage, 1);
      for (const text of [
        "synthetic-read-secret",
        "synthetic-body-hidden",
        "synthetic-extra-token",
        "synthetic-row-password",
      ])
        assert.ok(!(r.stdout + r.stderr).includes(text));
    }
    assert.ok(s.requests.every((x) => x.method === "GET"));
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});
test("send access reports grant rows and balance without inventing unlimited permission or mutating quota", async () => {
  const home = await temp();
  const s = await server((req, res) => {
    if (req.url === "/open_api/settings")
      return json(res, { enableSendMail: true });
    if (req.url === "/api/settings")
      return json(res, {
        address: "box@example.test",
        send_balance: 99999,
        jwt: "synthetic-hidden",
      });
    if (req.url.startsWith("/admin/address_sender?"))
      return json(res, {
        results: [
          {
            id: 51,
            address: "box@example.test",
            balance: 6,
            enabled: 0,
            secret: "synthetic-hidden",
          },
        ],
        count: 1,
      });
    json(res, {}, 404);
  });
  try {
    await profile(home, s.url);
    const run = (args, mode = "admin") =>
      cli(
        ["--profile", "test", "--credentials-stdin", "send-access", ...args],
        {
          home,
          input: JSON.stringify({
            server: s.url,
            mode,
            secret: "synthetic-read-secret",
          }),
        },
      );
    let r = await run(["list"]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.result.data.items[0], {
      senderRecordId: 51,
      address: "box@example.test",
      enabled: false,
      balance: 6,
    });
    r = await run(["show", "--address", "box@example.test"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.globalSendingEnabled, true);
    assert.equal(r.result.data.grant.enabled, false);
    assert.equal(r.result.data.effectivePermission, "unknown");
    r = await run(["show", "--address", "box@example.test"], "mailbox");
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.reportedBalance, 99999);
    assert.equal(r.result.data.unlimited, "unknown");
    assert.equal(r.result.data.canSendBasedOnReportedBalance, true);
    assert.ok(!r.stdout.includes("synthetic-hidden"));
    const n = s.requests.length;
    r = await run(["show", "--address", "other@example.test"], "mailbox");
    assert.equal(r.code, 2);
    assert.ok(s.requests.slice(n).every((x) => x.method === "GET"));
    assert.ok(s.requests.every((x) => x.method === "GET"));
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});

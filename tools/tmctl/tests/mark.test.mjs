import { test } from "node:test";
import assert from "node:assert/strict";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";

test("read marking binds exact mailbox/mail ID and verifies one PATCH by readback", async () => {
  const home = await temp();
  let unread = 1;
  const s = await server((req, res) => {
    if (req.url === "/open_api/settings")
      return json(res, { enableMailReadStatus: true });
    if (req.url === "/api/mail/17")
      return json(res, {
        id: 17,
        address: "box@example.test",
        raw: "Subject: fixture\r\n\r\nuntrusted",
        is_unread: unread,
      });
    if (req.url === "/api/mails/17/read" && req.method === "PATCH") {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        const d = JSON.parse(body);
        assert.deepEqual(d, { isUnread: false });
        unread = 0;
        json(res, { success: true });
      });
      return;
    }
    json(res, {}, 404);
  });
  try {
    await profile(home, s.url);
    const input = JSON.stringify({
      server: s.url,
      mode: "mailbox",
      secret: "synthetic-mark-jwt",
    });
    const run = (args) =>
      cli(
        [
          "--profile",
          "test",
          "--credentials-stdin",
          "mail",
          "mark",
          "17",
          "--address",
          "box@example.test",
          "--read",
          ...args,
        ],
        { home, input },
      );
    let r = await run(["--dry-run"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.beforeIsUnread, true);
    assert.equal(r.result.data.isUnread, false);
    assert.equal(unread, 1);
    assert.equal(s.requests.filter((x) => x.method === "PATCH").length, 0);
    r = await run(["--yes"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.verified, true);
    assert.equal(r.result.data.changed, true);
    assert.equal(unread, 0);
    assert.equal(s.requests.filter((x) => x.method === "PATCH").length, 1);
    assert.equal(s.requests.filter((x) => x.url === "/api/mail/17").length, 3);
    r = await run(["--yes"]);
    assert.equal(r.result.data.changed, false);
    assert.equal(s.requests.filter((x) => x.method === "PATCH").length, 1);
    assert.ok(!(r.stdout + r.stderr).includes("synthetic-mark-jwt"));
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});
test("mail summaries expose recognized read status without assuming missing legacy status", async () => {
  const { summary } = await import("../src/mail.mjs");
  const x = {
    id: 1,
    address: "box@example.test",
    raw: "Subject: synthetic\r\n\r\nfixture",
  };
  assert.equal((await summary({ ...x, is_unread: 1 })).isUnread, true);
  assert.equal((await summary({ ...x, is_unread: 0 })).isUnread, false);
  assert.equal((await summary(x)).isUnread, null);
});

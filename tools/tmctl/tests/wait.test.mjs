import { test } from "node:test";
import assert from "node:assert/strict";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";
const row = (id) => ({
  id,
  address: "orphan@example.test",
  source: "sender@example.test",
  created_at: "2026-10-02 08:00:00",
  raw: `From: sender@example.test\r\nSubject: Verification ${id}\r\n\r\ncode ${id}`,
});
test("wait establishes baseline, ignores old and nonmatching mail, then returns only new match", async () => {
  const h = await temp();
  let reads = 0;
  const s = await server((req, res) => {
    reads++;
    assert.equal(
      new URL(req.url, "http://x").searchParams.get("address"),
      "orphan@example.test",
    );
    json(res, {
      results:
        reads < 3
          ? [row(7)]
          : [
              row(9),
              { ...row(8), raw: "Subject: unrelated\r\n\r\nhi" },
              row(7),
            ],
      count: 3,
    });
  });
  try {
    await profile(h, s.url);
    const r = await cli(
      [
        "--profile",
        "test",
        "--credentials-stdin",
        "mail",
        "wait",
        "--address",
        "orphan@example.test",
        "--subject",
        "Verification",
        "--interval",
        "100ms",
        "--timeout",
        "3s",
      ],
      {
        home: h,
        input: JSON.stringify({
          server: s.url,
          mode: "admin",
          secret: "fixture",
        }),
      },
    );
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.mail.id, 9);
    assert.equal(r.result.data.baselineId, 7);
    assert.ok(reads >= 3);
  } finally {
    await s.close();
    await rm(h, { recursive: true, force: true });
  }
});
test("old match is never success; bounded timeout and saturated page fail explicitly", async () => {
  const h = await temp();
  let saturated = false,
    reads = 0;
  const s = await server((req, res) => {
    reads++;
    json(res, {
      results:
        saturated && reads > 1
          ? Array.from({ length: 100 }, (_, i) => row(200 - i))
          : [row(7)],
      count: 100,
    });
  });
  try {
    await profile(h, s.url);
    const run = () =>
      cli(
        [
          "--profile",
          "test",
          "--credentials-stdin",
          "mail",
          "wait",
          "--address",
          "orphan@example.test",
          "--interval",
          "100ms",
          "--timeout",
          "500ms",
        ],
        {
          home: h,
          input: JSON.stringify({
            server: s.url,
            mode: "admin",
            secret: "fixture",
          }),
        },
      );
    let r = await run();
    assert.equal(r.code, 4, r.stdout);
    assert.equal(r.result.error.code, "NO_NEW_MAIL");
    saturated = true;
    reads = 0;
    r = await run();
    assert.equal(r.result.error.code, "WATCH_GAP");
  } finally {
    await s.close();
    await rm(h, { recursive: true, force: true });
  }
});

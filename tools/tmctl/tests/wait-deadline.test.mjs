import { test } from "node:test";
import assert from "node:assert/strict";
import { server, json } from "./helpers.mjs";
import { Client } from "../src/http.mjs";
import { wait } from "../src/wait.mjs";

test("overall wait deadline remains no-match when a poll is in flight", async () => {
  let calls = 0;
  const s = await server((req, res) => {
    if (++calls === 1) json(res, { results: [], count: 0 });
  });
  try {
    const c = new Client(
      { server: s.url, allowLoopbackHttp: true },
      { server: s.url, mode: "admin", secret: "synthetic" },
      2000,
    );
    await assert.rejects(
      () =>
        wait(c, {
          address: "box@example.test",
          timeout: "500ms",
          interval: "100ms",
        }),
      (e) => e.code === "NO_NEW_MAIL" && e.exit === 4,
    );
    assert.equal(calls, 2);
  } finally {
    await s.close();
  }
});

test("a shorter per-request timeout is still a network failure", async () => {
  let calls = 0;
  const s = await server((req, res) => {
    if (++calls === 1) json(res, { results: [], count: 0 });
  });
  try {
    const c = new Client(
      { server: s.url, allowLoopbackHttp: true },
      { server: s.url, mode: "admin", secret: "synthetic" },
      100,
    );
    await assert.rejects(
      () =>
        wait(c, {
          address: "box@example.test",
          timeout: "2s",
          interval: "100ms",
        }),
      (e) => e.code === "TIMEOUT" && e.exit === 5,
    );
  } finally {
    await s.close();
  }
});

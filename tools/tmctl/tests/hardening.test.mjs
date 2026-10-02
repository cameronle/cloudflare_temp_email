import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  writeFile,
  readFile,
  mkdir,
  symlink,
  link,
  stat,
} from "node:fs/promises";
import { cli, temp, rm, profile, server, json } from "./helpers.mjs";
import { Client } from "../src/http.mjs";
import { wait } from "../src/wait.mjs";
import { cleanup } from "../src/contracts.mjs";
import { privateDir } from "../src/files.mjs";
test("cleanup shows every known policy without SQL or unexpected fields", () => {
  const x = {
    enableMailsAutoCleanup: true,
    cleanMailsDays: 7,
    enableUnknowMailsAutoCleanup: true,
    cleanUnknowMailsDays: 8,
    enableSendBoxAutoCleanup: true,
    cleanSendBoxDays: 9,
    enableAddressAutoCleanup: true,
    cleanAddressDays: 10,
    enableInactiveAddressAutoCleanup: true,
    cleanInactiveAddressDays: 11,
    enableUnboundAddressAutoCleanup: true,
    cleanUnboundAddressDays: 12,
    enableEmptyAddressAutoCleanup: true,
    cleanEmptyAddressDays: 13,
    customSqlCleanupList: [{ sql: "PRIVATE SQL", enabled: true }],
    password: "not-output",
  };
  const y = cleanup(x);
  for (const k of Object.keys(x).filter(
    (k) => k !== "customSqlCleanupList" && k !== "password",
  ))
    assert.equal(y[k], x[k], k);
  assert.equal(y.customRulesCount, 1);
  assert.doesNotMatch(JSON.stringify(y), /PRIVATE SQL|not-output/);
});
test("private directory creation rejects symlink before creating children", async () => {
  const h = await temp();
  try {
    await mkdir(h + "/target");
    await symlink(h + "/target", h + "/alias");
    await assert.rejects(() => privateDir(h + "/alias/new"));
    await assert.rejects(() => stat(h + "/target/new"));
  } finally {
    await rm(h, { recursive: true, force: true });
  }
});
test("mailbox wait deadline also covers identity lookup", async () => {
  const s = await server((req, res) =>
    setTimeout(() => json(res, { address: "box@example.test" }), 900),
  );
  try {
    const c = new Client(
      { server: s.url, allowLoopbackHttp: true },
      { server: s.url, mode: "mailbox", secret: "synthetic" },
      2000,
    );
    const start = Date.now();
    await assert.rejects(() =>
      wait(c, {
        address: "box@example.test",
        timeout: "100ms",
        interval: "100ms",
      }),
    );
    assert.ok(
      Date.now() - start < 600,
      "identity lookup ignored total deadline",
    );
  } finally {
    await s.close();
  }
});

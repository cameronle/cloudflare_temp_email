import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { Client } from "../src/http.mjs";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";

async function setup(handler, mode = "admin") {
  const home = await temp();
  const s = await server(handler);
  await profile(home, s.url);
  const input = JSON.stringify({
    server: s.url,
    mode,
    secret: "synthetic-bound-secret",
  });
  const run = (args) =>
    cli(["--profile", "test", "--credentials-stdin", ...args], { home, input });
  return {
    home,
    s,
    run,
    close: async () => {
      await s.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
const creation = [
  "addresses",
  "create",
  "--domain",
  "example.test",
  "--save-profile",
  "newbox",
];
const marking = ["mail", "mark", "17", "--address", "box@example.test"];
const publicSettings = {
  domains: ["example.test"],
  enableMailReadStatus: true,
};
const mail = {
  id: 17,
  address: "box@example.test",
  raw: "Subject: synthetic\r\n\r\nfixture",
  is_unread: 1,
};

test("write commands reject absent approval, invalid exclusive flags and identifiers before any request", async () => {
  const f = await setup((req, res) => json(res, publicSettings));
  try {
    for (const args of [
      [...creation, "--name", "newbox"],
      [...creation, "--name", "NewBox", "--yes"],
      [...creation, "--name", "newbox", "--random-name", "--yes"],
      [...creation, "--yes"],
      [...marking, "--read", "--yes"], // administrator must not mark
      ["send", "--yes"],
      ["mail", "delete", "17", "--yes"],
      ["cleanup", "run", "--yes"],
      ["send-access", "update", "--yes"],
    ])
      assert.equal((await f.run(args)).code, 2);
    assert.equal(f.s.requests.length, 0);
    assert.deepEqual(await readdir(f.home), ["test.json"]);
  } finally {
    await f.close();
  }
});
test("creation domain allowlist and occupied private target fail before POST", async () => {
  const f = await setup((req, res) => json(res, publicSettings));
  try {
    let r = await f.run([
      ...creation,
      "--name",
      "newbox",
      "--domain",
      "evil.test",
      "--dry-run",
    ]);
    assert.equal(r.code, 2);
    await writeFile(f.home + "/newbox.auth.json", "synthetic-existing", {
      mode: 0o600,
    });
    const n = f.s.requests.length;
    r = await f.run([...creation, "--name", "newbox", "--yes"]);
    assert.equal(r.code, 2);
    assert.equal(f.s.requests.length, n);
    assert.equal(
      await readFile(f.home + "/newbox.auth.json", "utf8"),
      "synthetic-existing",
    );
  } finally {
    await f.close();
  }
});
test("random creation dry-run uses unique cryptographic names and saves no profile", async () => {
  const f = await setup((req, res) => json(res, publicSettings));
  try {
    const a = await f.run([...creation, "--random-name", "--dry-run"]);
    const b = await f.run([...creation, "--random-name", "--dry-run"]);
    assert.equal(a.code, 0, a.stdout);
    assert.match(a.result.data.address, /^[a-f0-9]{20}@example\.test$/);
    assert.notEqual(a.result.data.address, b.result.data.address);
    assert.deepEqual(await readdir(f.home), ["test.json"]);
  } finally {
    await f.close();
  }
});
test("failed creation is never retried, leaks no error body and retains a blocking recovery lock", async () => {
  const f = await setup((req, res) =>
    req.method === "POST"
      ? json(res, { password: "synthetic-error-secret" }, 503)
      : json(res, publicSettings),
  );
  try {
    let r = await f.run([...creation, "--name", "newbox", "--yes"]);
    assert.equal(r.code, 5, r.stdout);
    assert.equal(r.result.error.code, "WRITE_UNCERTAIN");
    assert.ok(!(r.stdout + r.stderr).includes("synthetic-error-secret"));
    assert.equal(f.s.requests.filter((x) => x.method === "POST").length, 1);
    assert.deepEqual(await readdir(f.home), [
      "newbox.create.lock",
      "test.json",
    ]);
    const n = f.s.requests.length;
    r = await f.run([...creation, "--name", "newbox", "--yes"]);
    assert.equal(r.code, 2);
    assert.equal(f.s.requests.length, n);
  } finally {
    await f.close();
  }
});
test("read-marker scope, exclusive state and disabled capability fail without PATCH", async () => {
  let enabled = false;
  let wrong = false;
  const f = await setup(
    (req, res) =>
      req.url === "/open_api/settings"
        ? json(res, { enableMailReadStatus: enabled })
        : json(res, {
            ...mail,
            ...(wrong ? { address: "other@example.test" } : {}),
          }),
    "mailbox",
  );
  try {
    for (const args of [
      [...marking, "--read"],
      [...marking, "--yes"],
      [...marking, "--read", "--unread", "--yes"],
    ])
      assert.equal((await f.run(args)).code, 2);
    assert.equal(f.s.requests.length, 0);
    let r = await f.run([...marking, "--read", "--yes"]);
    assert.equal(r.result.error.code, "FEATURE_DISABLED");
    enabled = true;
    wrong = true;
    r = await f.run([...marking, "--read", "--yes"]);
    assert.equal(r.code, 2);
    assert.ok(f.s.requests.every((x) => x.method === "GET"));
  } finally {
    await f.close();
  }
});
test("read-marker success acknowledgment is insufficient: mismatching readback fails without retry", async () => {
  const f = await setup(
    (req, res) =>
      req.url === "/open_api/settings"
        ? json(res, publicSettings)
        : req.method === "PATCH"
          ? json(res, { success: true })
          : json(res, mail),
    "mailbox",
  );
  try {
    const r = await f.run([...marking, "--read", "--yes"]);
    assert.equal(r.code, 5, r.stdout);
    assert.equal(r.result.error.code, "WRITE_UNCERTAIN");
    assert.equal(f.s.requests.filter((x) => x.method === "PATCH").length, 1);
    assert.equal(
      f.s.requests.filter((x) => x.url === "/api/mail/17").length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("HTTP writes refuse destructive routes, alternate verbs, mode confusion, malformed body and redirects", async () => {
  let leaks = 0;
  const trap = await server((req, res) => {
    leaks++;
    json(res, {});
  });
  const s = await server((req, res) => {
    res.writeHead(307, { Location: trap.url });
    res.end();
  });
  try {
    const c = new Client(
      { server: s.url },
      { server: s.url, mode: "admin", secret: "synthetic-secret" },
    );
    const body = {
      name: "box",
      domain: "example.test",
      enablePrefix: false,
      enableRandomSubdomain: false,
    };
    for (const [method, path, payload] of [
      ["DELETE", "/admin/address/1"],
      ["POST", "/admin/send_mail", {}],
      ["POST", "/admin/auto_cleanup", {}],
      ["PATCH", "/admin/address_sender", {}],
      ["GET", "/admin/new_address"],
      ["POST", "/admin/new_address", { ...body, arbitrary: true }],
      ["PATCH", "/api/mails/17/read", { isUnread: false }],
    ])
      await assert.rejects(() =>
        c.request(method, path, {}, undefined, payload),
      );
    assert.equal(s.requests.length, 0);
    await assert.rejects(() => c.createAddress(body));
    assert.equal(s.requests.length, 1);
    assert.equal(leaks, 0);
  } finally {
    await s.close();
    await trap.close();
  }
});

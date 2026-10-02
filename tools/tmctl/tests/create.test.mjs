import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, readFile, readdir } from "node:fs/promises";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";

async function setup() {
  const home = await temp();
  const s = await server((req, res) => {
    if (req.url === "/open_api/settings")
      return json(res, { domains: ["example.test"] });
    if (req.url === "/admin/new_address") {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        const d = JSON.parse(body);
        assert.deepEqual(d, {
          name: "newbox",
          domain: "example.test",
          enablePrefix: false,
          enableRandomSubdomain: false,
        });
        json(res, {
          address: "newbox@example.test",
          address_id: 41,
          jwt: "synthetic-mailbox-jwt",
          password: "synthetic-unused-password",
        });
      });
      return;
    }
    if (req.url === "/api/settings") {
      assert.equal(req.headers.authorization, "Bearer synthetic-mailbox-jwt");
      assert.equal(req.headers["x-admin-auth"], undefined);
      return json(res, { address: "newbox@example.test", send_balance: 0 });
    }
    json(res, {}, 404);
  });
  await profile(home, s.url);
  const input = JSON.stringify({
    server: s.url,
    mode: "admin",
    secret: "synthetic-create-admin",
  });
  const run = (args) =>
    cli(
      [
        "--profile",
        "test",
        "--credentials-stdin",
        "addresses",
        "create",
        ...args,
      ],
      { home, input },
    );
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
test("mailbox creation dry-run previews exact target without POST or local credential persistence", async () => {
  const f = await setup();
  try {
    const r = await f.run([
      "--name",
      "newbox",
      "--domain",
      "example.test",
      "--save-profile",
      "newbox",
      "--dry-run",
    ]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.address, "newbox@example.test");
    assert.equal(r.result.data.dryRun, true);
    assert.equal(r.result.data.savedProfile, "newbox");
    assert.ok(f.s.requests.every((x) => x.method === "GET"));
    assert.deepEqual(await readdir(f.home), ["test.json"]);
    assert.ok(!r.stdout.includes("synthetic-create-admin"));
  } finally {
    await f.close();
  }
});
test("creation refuses a server name-filter that would silently change the approved address", async () => {
  const home = await temp();
  const s = await server((req, res) =>
    json(res, { domains: ["example.test"], addressRegex: "[0-9]" }),
  );
  try {
    await profile(home, s.url);
    const r = await cli(
      [
        "--profile",
        "test",
        "--credentials-stdin",
        "addresses",
        "create",
        "--name",
        "box123",
        "--domain",
        "example.test",
        "--save-profile",
        "newbox",
        "--yes",
      ],
      {
        home,
        input: JSON.stringify({
          server: s.url,
          mode: "admin",
          secret: "synthetic-admin",
        }),
      },
    );
    assert.equal(r.code, 2, r.stdout);
    assert.ok(s.requests.every((x) => x.method === "GET"));
    assert.deepEqual(await readdir(home), ["test.json"]);
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});
test("confirmed mailbox creation persists only origin-bound mailbox JWT in new owned 0600 files and verifies identity", async () => {
  const f = await setup();
  try {
    const r = await f.run([
      "--name",
      "newbox",
      "--domain",
      "example.test",
      "--save-profile",
      "newbox",
      "--yes",
    ]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.result.data.created, true);
    assert.equal(r.result.data.verified, true);
    assert.equal(r.result.data.addressId, 41);
    assert.equal(f.s.requests.filter((x) => x.method === "POST").length, 1);
    for (const suffix of [".json", ".auth.json"])
      assert.equal(
        (await stat(f.home + "/newbox" + suffix)).mode & 0o777,
        0o600,
      );
    const credentials = JSON.parse(
      await readFile(f.home + "/newbox.auth.json", "utf8"),
    );
    assert.deepEqual(credentials, {
      server: f.s.url,
      mode: "mailbox",
      secret: "synthetic-mailbox-jwt",
    });
    for (const secret of [
      "synthetic-mailbox-jwt",
      "synthetic-unused-password",
      "synthetic-create-admin",
    ])
      assert.ok(!(r.stdout + r.stderr).includes(secret));
    const n = f.s.requests.length;
    const again = await f.run([
      "--name",
      "newbox",
      "--domain",
      "example.test",
      "--save-profile",
      "newbox",
      "--yes",
    ]);
    assert.equal(again.code, 2);
    assert.equal(f.s.requests.length, n);
  } finally {
    await f.close();
  }
});

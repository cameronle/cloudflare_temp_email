import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { cli, temp, rm, server, json, profile } from "./helpers.mjs";
const args = [
  "addresses",
  "create",
  "--name",
  "box",
  "--domain",
  "example.test",
  "--save-profile",
  "newbox",
  "--yes",
];

test("concurrent same-profile creation permits at most one POST", async () => {
  const home = await temp();
  let firstSettings;
  let secondSettings;
  const s = await server((req, res) => {
    if (req.url === "/open_api/settings") {
      if (!firstSettings) firstSettings = res;
      else {
        secondSettings = res;
        json(firstSettings, { domains: ["example.test"] });
      }
      return;
    }
    if (req.url === "/api/settings")
      return json(res, { address: "box@example.test" });
    json(res, {
      address: "box@example.test",
      address_id: 11,
      jwt: "synthetic-concurrent-jwt",
    });
  });
  try {
    await profile(home, s.url);
    const input = JSON.stringify({
      server: s.url,
      mode: "admin",
      secret: "synthetic-admin",
    });
    const run = () =>
      cli(["--profile", "test", "--credentials-stdin", ...args], {
        home,
        input,
      });
    const a = run(),
      b = run();
    const first = await Promise.race([a, b]);
    assert.equal(first.code, 0, first.stdout);
    // Both passed initial local checks; the second resumes only after the
    // first has committed files and removed its lock (deterministic ABA race).
    json(secondSettings, { domains: ["example.test"] });
    const results = await Promise.all([a, b]);
    assert.equal(results.filter((x) => x.code === 0).length, 1);
    assert.equal(s.requests.filter((x) => x.method === "POST").length, 1);
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});
test("timeout after attempted creation retains recovery lock and never repeats POST", async () => {
  const home = await temp();
  const s = await server((req, res) => {
    if (req.method !== "POST") json(res, { domains: ["example.test"] });
  });
  try {
    await profile(home, s.url);
    const r = await cli(
      [
        "--profile",
        "test",
        "--credentials-stdin",
        "--request-timeout",
        "100",
        ...args,
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
    assert.equal(r.result.error.code, "WRITE_UNCERTAIN");
    assert.equal(s.requests.filter((x) => x.method === "POST").length, 1);
    assert.deepEqual(await readdir(home), ["newbox.create.lock", "test.json"]);
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});
test("failure after private JWT persistence preserves recovery material and never overwrites a competing file", async () => {
  const home = await temp();
  const s = await server((req, res) => {
    if (req.method === "POST") {
      writeFile(home + "/newbox.json", "synthetic-competing-file", {
        mode: 0o600,
      }).then(() =>
        json(res, {
          address: "box@example.test",
          address_id: 11,
          jwt: "synthetic-recovery-jwt",
          password: "synthetic-unused-password",
        }),
      );
    } else json(res, { domains: ["example.test"] });
  });
  try {
    await profile(home, s.url);
    const r = await cli(["--profile", "test", "--credentials-stdin", ...args], {
      home,
      input: JSON.stringify({
        server: s.url,
        mode: "admin",
        secret: "synthetic-admin",
      }),
    });
    assert.equal(r.result.error.code, "WRITE_UNCERTAIN");
    assert.equal(
      await readFile(home + "/newbox.json", "utf8"),
      "synthetic-competing-file",
    );
    const saved = JSON.parse(
      await readFile(home + "/newbox.auth.json", "utf8"),
    );
    assert.equal(saved.secret, "synthetic-recovery-jwt");
    assert.ok(!(r.stdout + r.stderr).includes(saved.secret));
    assert.ok(!(r.stdout + r.stderr).includes("synthetic-unused-password"));
    assert.equal(s.requests.filter((x) => x.method === "POST").length, 1);
    assert.ok((await readdir(home)).includes("newbox.create.lock"));
  } finally {
    await s.close();
    await rm(home, { recursive: true, force: true });
  }
});

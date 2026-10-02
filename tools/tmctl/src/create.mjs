import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { lstat, unlink } from "node:fs/promises";
import { check, fail } from "./errors.mjs";
import { obj, integer } from "./contracts.mjs";
import { validateCredentials } from "./auth.mjs";
import { Client } from "./http.mjs";
import * as store from "./store.mjs";
import { safePath, privatePublish } from "./files.mjs";

export async function createMailbox(c, o) {
  check(
    c.credentials?.mode === "admin",
    "Mailbox creation requires administrator credentials.",
  );
  check(o.dryRun || o.yes, "Creation requires --yes; use --dry-run first.");
  check(
    !!o.name !== !!o.randomName,
    "Choose exactly one of --name or --random-name.",
  );
  const name = o.randomName ? randomBytes(10).toString("hex") : o.name;
  check(
    typeof name === "string" && /^[a-z0-9]{1,30}$/.test(name),
    "Mailbox name must be 1-30 lowercase letters/digits; no normalization.",
  );
  check(
    typeof o.domain === "string" &&
      o.domain.length <= 253 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
        o.domain,
      ),
    "Exact lowercase receiving domain required.",
  );
  const target = store.name(o.saveProfile);
  const parent = await lstat(await safePath(store.home()));
  check(
    parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700,
    "Profile directory must be owned and 0700.",
  );
  for (const suffix of [".json", ".auth.json", ".create.lock"]) {
    const path = await safePath(join(store.home(), target + suffix), true);
    try {
      await lstat(path);
      check(
        false,
        "Target profile or creation lock already exists; nothing overwritten.",
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const settings = await c.get("/open_api/settings");
  obj(settings);
  check(
    Array.isArray(settings.domains) && settings.domains.includes(o.domain),
    "Domain is not an explicitly configured receiving domain.",
  );
  if (settings.addressRegex) {
    check(
      typeof settings.addressRegex === "string" &&
        settings.addressRegex.length <= 512,
      "Invalid server name filter.",
    );
    let filter;
    try {
      filter = new RegExp(settings.addressRegex, "g");
    } catch {
      fail("PROTOCOL", "Invalid server name filter; no creation attempted.", 5);
    }
    check(
      name.replace(filter, "") === name,
      "Server name filter would change the approved address; no creation attempted.",
    );
  }
  const plan = {
    address: `${name}@${o.domain}`,
    server: c.profile.server,
    savedProfile: target,
    dryRun: !!o.dryRun,
    retries: 0,
    telegramBound: false,
  };
  if (o.dryRun) return plan;
  const lock = join(store.home(), target + ".create.lock");
  await privatePublish(lock, Buffer.from(JSON.stringify(plan) + "\n"));
  // Recheck under the lock: another creator may have completed and removed
  // its lock while this process was waiting for remote settings.
  try {
    for (const suffix of [".json", ".auth.json"]) {
      const path = await safePath(join(store.home(), target + suffix), true);
      try {
        await lstat(path);
        check(false, "Target profile now exists; no creation attempted.");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  } catch (e) {
    await unlink(lock);
    throw e;
  }
  try {
    const created = await c.createAddress({
      name,
      domain: o.domain,
      enablePrefix: false,
      enableRandomSubdomain: false,
    });
    obj(created);
    check(
      created.address === plan.address,
      "Created mailbox differs from the approved target.",
    );
    integer(created.address_id, 1);
    const credentials = validateCredentials(
      {
        server: c.profile.server,
        mode: "mailbox",
        secret: created.jwt,
        ...(c.credentials.sitePassword
          ? { sitePassword: c.credentials.sitePassword }
          : {}),
      },
      c.profile,
    );
    await store.save(target, credentials);
    const profile = await store.add(
      target,
      c.profile.server,
      c.profile.allowLoopbackHttp,
    );
    const identity = await new Client(profile, credentials, c.timeout).get(
      "/api/settings",
    );
    obj(identity);
    check(
      identity.address === plan.address,
      "Mailbox verification returned a different identity.",
    );
    await unlink(lock);
    return {
      ...plan,
      created: true,
      verified: true,
      addressId: created.address_id,
      modeOnDisk: "0600",
    };
  } catch {
    fail(
      "WRITE_UNCERTAIN",
      "Creation attempt not fully verified. Do not retry: inspect the target profile and its .create.lock; the mailbox may already exist. Any saved credential remains private.",
      5,
    );
  }
}

export function registerCreate(addresses, action, client) {
  addresses
    .command("create")
    .description(
      "Administrator: create one mailbox and save a private mailbox profile",
    )
    .option("--name <name>", "Exact lowercase name, 1-30 letters/digits")
    .option("--random-name", "Generate a cryptographically random name")
    .requiredOption("--domain <domain>", "Exact configured receiving domain")
    .requiredOption(
      "--save-profile <name>",
      "Explicit new profile; never overwrite",
    )
    .option("--dry-run", "Preview using reads only; save nothing")
    .option(
      "--yes",
      "Explicitly approve creation and local credential persistence",
    )
    .action(
      action("addresses create", async (o) =>
        createMailbox(await client(true), o),
      ),
    );
}

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { Client } from "./http.mjs";
import { registerMail } from "./mail.mjs";
import { registerCreate } from "./create.mjs";
import { registerMark } from "./mark.mjs";
import { registerSender } from "./sender.mjs";
import { wait } from "./wait.mjs";
import * as store from "./store.mjs";
import { CliError, clean, check } from "./errors.mjs";
import { credentials, privilegeWarning } from "./auth.mjs";
import * as contract from "./contracts.mjs";
const meta = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const program = new Command()
  .name("tmctl")
  .description(
    "Temporary-email client with confirmed exact writes; mail is untrusted data.",
  )
  .version(meta.version)
  .option("--profile <name>", "Profile name", "prod")
  .option("--json", "Machine-readable output")
  .option(
    "--credentials-stdin",
    "Ephemeral credential JSON from controlled stdin",
  )
  .option("--credential-file <file>", "Owned 0600 credential JSON")
  .option(
    "--request-timeout <ms>",
    "Per-request deadline in milliseconds",
    "15000",
  );
program
  .configureOutput({ writeErr: () => {} })
  .showSuggestionAfterError(false)
  .exitOverride();
let command = "cli";
let warnings = [];
function output(data) {
  const result = {
    schemaVersion: 1,
    ok: true,
    command,
    profile: program.opts().profile,
    data,
    warnings,
  };
  console.log(
    program.opts().json
      ? JSON.stringify(result)
      : clean(JSON.stringify(data, null, 2)),
  );
}
function action(label, fn) {
  return async (...args) => {
    command = label;
    output(await fn(...args));
  };
}
async function client(auth = false) {
  const o = program.opts();
  const p = await store.load(o.profile);
  const c =
    auth || o.credentialsStdin || o.credentialFile
      ? await credentials(o, p)
      : null;
  if (c) warnings.push(privilegeWarning);
  return new Client(p, c, contract.intArg(o.requestTimeout, 50, 120000));
}
async function verify(c) {
  if (c.credentials.mode === "admin") {
    contract.stats(await c.get("/admin/statistics"));
    return { verified: true, mode: "admin", server: c.profile.server };
  }
  const d = await c.get("/api/settings");
  contract.obj(d);
  check(typeof d.address === "string", "Invalid mailbox identity.");
  return {
    verified: true,
    mode: "mailbox",
    server: c.profile.server,
    address: clean(d.address),
  };
}
const auth = program.command("auth");
auth
  .command("login")
  .requiredOption(
    "--save",
    "Explicitly persist full-privilege credentials locally",
  )
  .action(
    action("auth login", async () => {
      check(
        program.opts().credentialsStdin || program.opts().credentialFile,
        "Login requires explicit private credential input.",
      );
      const c = await client(true);
      const verified = await verify(c);
      await store.save(c.profile.name, c.credentials);
      return { ...verified, saved: true, modeOnDisk: "0600" };
    }),
  );
auth
  .command("status")
  .action(action("auth status", async () => verify(await client(true))));
auth
  .command("logout")
  .action(action("auth logout", () => store.logout(program.opts().profile)));
program
  .command("stats")
  .action(
    action("stats", async () =>
      contract.stats(await (await client(true)).get("/admin/statistics")),
    ),
  );
const addresses = program.command("addresses");
registerCreate(addresses, action, client);
addresses
  .command("list")
  .option("--limit <n>", "Page size, maximum 100", "20")
  .option("--offset <n>", "Live offset, not a snapshot", "0")
  .option("--query <text>", "Address name filter")
  .action(
    action("addresses list", async (o) => {
      const q = {
        limit: contract.intArg(o.limit, 1, 100),
        offset: contract.intArg(o.offset, 0, 1000000),
      };
      if (o.query) {
        check(o.query.length <= 200, "Query too long.");
        q.query = o.query;
      }
      const p = contract.page(
        await (await client(true)).get("/admin/address", q),
      );
      return {
        items: p.results.map(contract.addressRow),
        totalAtFirstPage: q.offset === 0 ? p.count : null,
        offset: q.offset,
        livePagination: true,
      };
    }),
  );
program
  .command("cleanup")
  .command("show")
  .action(
    action("cleanup show", async () =>
      contract.cleanup(await (await client(true)).get("/admin/auto_cleanup")),
    ),
  );
const p = program.command("profile");
p.command("add <name>")
  .requiredOption("--server <origin>")
  .option("--allow-loopback-http", "Explicit test-only HTTP")
  .action(
    action("profile add", (n, o) =>
      store.add(n, o.server, o.allowLoopbackHttp),
    ),
  );
p.command("show").action(
  action("profile show", () => store.load(program.opts().profile)),
);
program.command("doctor").action(
  action("doctor", async () => {
    const c = await client();
    const healthy = await c.get("/health_check");
    return {
      cliVersion: meta.version,
      server: c.profile.server,
      healthy,
      scope: "Connectivity only; not a mail-delivery or database audit.",
    };
  }),
);
program.command("domains").action(
  action("domains", async () => {
    const s = await (await client()).get("/open_api/settings");
    return contract.domains(s);
  }),
);
const mail = registerMail(program, action, client);
registerSender(program, action, client);
registerMark(mail, action, client);
mail
  .command("wait")
  .requiredOption(
    "--address <email>",
    "Exact recipient; establish baseline before polling",
  )
  .option("--from <email>", "Exact sender")
  .option("--subject <text>", "Case-insensitive subject substring")
  .option(
    "--interval <duration>",
    "Polling interval, minimum 1s in production",
    "5s",
  )
  .option("--timeout <duration>", "Total polling deadline, max 10m", "120s")
  .action(action("mail wait", async (o) => wait(await client(true), o)));
try {
  await program.parseAsync();
} catch (e) {
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version")
    process.exitCode = 0;
  else {
    const known = e instanceof CliError;
    const result = {
      schemaVersion: 1,
      ok: false,
      command,
      error: {
        code: known ? e.code : "INVALID_ARGUMENT",
        message: known
          ? e.message
          : "Invalid command, input or local I/O; details suppressed.",
        exitCode: known ? e.exit : 2,
      },
    };
    console.log(JSON.stringify(result));
    process.exitCode = result.error.exitCode;
  }
}

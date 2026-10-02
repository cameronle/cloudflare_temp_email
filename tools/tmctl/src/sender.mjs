import { check, clean, fail } from "./errors.mjs";
import { obj, intArg, integer, page } from "./contracts.mjs";
import { address } from "./mail.mjs";

function retained(x) {
  obj(x);
  integer(x.id, 1);
  address(x.address);
  check(
    typeof x.raw === "string" && Buffer.byteLength(x.raw) <= 12 * 1024 * 1024,
    "Invalid or oversized retained outbox content.",
  );
  let d;
  try {
    d = JSON.parse(x.raw);
  } catch {
    fail("PROTOCOL", "Invalid retained outbox JSON; content suppressed.", 5);
  }
  obj(d);
  check(typeof d.subject === "string", "Invalid retained outbox subject.");
  let to;
  if (d.version === "v2") to = [address(d.to_mail)];
  else {
    check(
      Array.isArray(d.personalizations) && d.personalizations.length <= 100,
      "Invalid retained outbox recipients.",
    );
    to = d.personalizations.flatMap((p) => {
      obj(p);
      check(Array.isArray(p.to) && p.to.length <= 100, "Invalid recipients.");
      return p.to.map((t) => address(t.email));
    });
    check(to.length <= 100, "Too many retained recipients.");
  }
  return {
    d,
    summary: {
      id: x.id,
      address: x.address,
      to: to.map(clean),
      subject: clean(d.subject),
      createdAt: typeof x.created_at === "string" ? clean(x.created_at) : null,
    },
  };
}
async function outboxPage(c, o) {
  const q = {
    limit: intArg(o.limit || "20", 1, 100),
    offset: intArg(o.offset || "0", 0, 1000000),
  };
  if (o.address) address(o.address);
  let expected = o.address;
  const admin = c.credentials?.mode === "admin";
  if (admin) {
    if (expected) q.address = expected;
  } else {
    const identity = await c.get("/api/settings");
    obj(identity);
    address(identity.address);
    check(
      !expected || expected === identity.address,
      "Requested sender differs from authenticated mailbox.",
    );
    expected = identity.address;
  }
  const p = page(await c.get(admin ? "/admin/sendbox" : "/api/sendbox", q));
  check(p.results.length <= q.limit, "API returned too many rows.");
  let previous = Infinity;
  const items = p.results.map((x) => {
    const s = retained(x).summary;
    check(s.id < previous, "Invalid/duplicate outbox order.");
    previous = s.id;
    check(
      !expected || s.address === expected,
      "Server returned a different sender.",
    );
    return s;
  });
  return {
    items,
    totalAtFirstPage: q.offset === 0 ? p.count : null,
    offset: q.offset,
    livePagination: true,
    readSideEffects: admin
      ? "none expected"
      : "Mailbox activity may refresh; settings may initialize default sender balance.",
  };
}
export function registerSender(program, action, client) {
  const outbox = program
    .command("outbox")
    .description("Read retained sent history; never sends or deletes");
  outbox
    .command("list")
    .option(
      "--address <email>",
      "Exact sender; mailbox mode must match identity",
    )
    .option("--limit <n>", "Page size, 1-100", "20")
    .option("--offset <n>", "Live offset, not a snapshot", "0")
    .action(
      action("outbox list", async (o) => outboxPage(await client(true), o)),
    );
  const access = program
    .command("send-access")
    .description(
      "Read grants/quotas only; no requests, enables or quota changes",
    );
  access
    .command("list")
    .option("--address <email>", "Exact sender grant filter")
    .option("--limit <n>", "Page size, 1-100", "20")
    .option("--offset <n>", "Live offset", "0")
    .action(
      action("send-access list", async (o) => grants(await client(true), o)),
    );
  access
    .command("show")
    .requiredOption("--address <email>", "Exact target address")
    .action(
      action("send-access show", async (o) =>
        sendAccess(await client(true), o),
      ),
    );
}

async function grants(c, o) {
  check(
    c.credentials?.mode === "admin",
    "Sender grant listing requires administrator credentials.",
  );
  const q = {
    limit: intArg(o.limit || "20", 1, 100),
    offset: intArg(o.offset || "0", 0, 1000000),
  };
  if (o.address) q.address = address(o.address);
  const p = page(await c.get("/admin/address_sender", q));
  check(p.results.length <= q.limit, "API returned too many sender rows.");
  let previous = Infinity;
  const items = p.results.map((x) => {
    obj(x);
    integer(x.id, 1);
    check(x.id < previous, "Invalid/duplicate sender order.");
    previous = x.id;
    address(x.address);
    check(
      !o.address || x.address === o.address,
      "Server returned a different sender grant.",
    );
    check(x.enabled === 0 || x.enabled === 1, "Invalid sender enabled state.");
    return {
      senderRecordId: x.id,
      address: x.address,
      enabled: x.enabled === 1,
      balance: integer(x.balance),
    };
  });
  return {
    items,
    totalAtFirstPage: q.offset === 0 ? p.count : null,
    offset: q.offset,
    livePagination: true,
    scope:
      "Sender grant rows only; no-limit address/role and default-balance overrides are not inferred.",
  };
}
async function sendAccess(c, o) {
  address(o.address);
  const publicSettings = await c.get("/open_api/settings");
  obj(publicSettings);
  check(
    typeof publicSettings.enableSendMail === "boolean",
    "Server sending capability unavailable.",
  );
  if (c.credentials?.mode === "admin") {
    const p = await grants(c, {
      address: o.address,
      limit: "100",
      offset: "0",
    });
    check(
      p.totalAtFirstPage === p.items.length && p.items.length <= 1,
      "Ambiguous sender grant result.",
    );
    return {
      address: o.address,
      globalSendingEnabled: publicSettings.enableSendMail,
      grant: p.items[0] || null,
      effectivePermission: "unknown",
      scope: p.scope,
      readSideEffects: "none expected",
    };
  }
  const settings = await c.get("/api/settings");
  obj(settings);
  check(
    settings.address === o.address,
    "Requested address differs from authenticated mailbox.",
  );
  const reportedBalance = integer(settings.send_balance);
  return {
    address: o.address,
    globalSendingEnabled: publicSettings.enableSendMail,
    reportedBalance,
    unlimited: "unknown",
    canSendBasedOnReportedBalance:
      publicSettings.enableSendMail && reportedBalance > 0,
    scope:
      "Reported balance only; 99999 is not proof of unlimited access or successful delivery.",
    readSideEffects:
      "Mailbox activity may refresh; settings may initialize default sender balance.",
  };
}

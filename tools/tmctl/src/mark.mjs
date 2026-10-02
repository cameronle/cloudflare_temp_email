import { check, fail } from "./errors.mjs";
import { intArg, obj } from "./contracts.mjs";
import { address, get } from "./mail.mjs";

export function isUnread(row) {
  check(
    row.is_unread === null ||
      row.is_unread === undefined ||
      row.is_unread === 0 ||
      row.is_unread === 1,
    "Invalid mail read state.",
  );
  return row.is_unread === 1;
}
export async function mark(c, id, o) {
  check(
    c.credentials?.mode === "mailbox",
    "Read markers require the target mailbox identity; administrator tokens are not converted.",
  );
  check(o.dryRun || o.yes, "Marking requires --yes; use --dry-run first.");
  check(!!o.read !== !!o.unread, "Choose exactly one of --read or --unread.");
  check(
    String(intArg(id, 1, Number.MAX_SAFE_INTEGER)) === id,
    "Canonical exact mail ID required.",
  );
  address(o.address);
  const settings = await c.get("/open_api/settings");
  obj(settings);
  if (settings.enableMailReadStatus !== true)
    fail(
      "FEATURE_DISABLED",
      "Server read markers are disabled or unavailable; no change made.",
      3,
    );
  const before = await get(c, id, o.address);
  const plan = {
    mailId: Number(id),
    address: o.address,
    beforeIsUnread: isUnread(before),
    isUnread: !!o.unread,
    dryRun: !!o.dryRun,
    retries: 0,
  };
  if (o.dryRun) return plan;
  if (plan.beforeIsUnread === plan.isUnread)
    return { ...plan, changed: false, verified: true };
  try {
    const result = await c.markRead(id, plan.isUnread);
    obj(result);
    check(result.success === true, "Read-marker request not acknowledged.");
    const after = await get(c, id, o.address);
    check(
      isUnread(after) === plan.isUnread,
      "Read-marker verification failed.",
    );
    return { ...plan, changed: true, verified: true };
  } catch {
    fail(
      "WRITE_UNCERTAIN",
      "Read-marker attempt not fully verified. Inspect this exact mail before retrying; no automatic retry was performed.",
      5,
    );
  }
}
export function registerMark(mail, action, client) {
  mail
    .command("mark <id>")
    .description(
      "Mailbox identity: mark one exact mail read/unread and verify it",
    )
    .requiredOption("--address <email>", "Required exact recipient")
    .option("--read", "Mark read")
    .option("--unread", "Mark unread")
    .option("--dry-run", "Preview with GET only")
    .option("--yes", "Explicitly approve this one read marker")
    .action(
      action("mail mark", async (id, o) => mark(await client(true), id, o)),
    );
}

import PostalMime from "postal-mime";
import { convert } from "html-to-text";
import { check, fail, clean } from "./errors.mjs";
import { integer, intArg, page, obj } from "./contracts.mjs";
import { privatePublish } from "./files.mjs";
export function address(value) {
  check(
    typeof value === "string" &&
      value.length <= 254 &&
      /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value),
    "Exact email address required.",
  );
  return value;
}
export function row(x) {
  obj(x);
  integer(x.id, 1);
  address(x.address);
  check(
    typeof x.raw === "string" && Buffer.byteLength(x.raw) <= 12 * 1024 * 1024,
    "Invalid or oversized retained MIME.",
  );
  return x;
}
export async function parse(x) {
  row(x);
  try {
    return await PostalMime.parse(x.raw, {
      maxNestingDepth: 30,
      maxHeadersSize: 256 * 1024,
    });
  } catch {
    fail("MIME_ERROR", "Cannot parse retained MIME; contents suppressed.", 5);
  }
}
export async function summary(x, parsed) {
  const p = parsed || (await parse(x));
  return {
    id: x.id,
    isUnread: x.is_unread === 1 ? true : x.is_unread === 0 ? false : null,
    address: clean(x.address),
    from: clean(p.from?.address || x.source || ""),
    subject: clean(p.subject || ""),
    createdAt: typeof x.created_at === "string" ? clean(x.created_at) : null,
    attachmentCount: p.attachments.length,
    retainedBytes: Buffer.byteLength(x.raw),
  };
}
export async function shown(x) {
  const p = await parse(x);
  const text = clean(
    p.text ||
      convert(p.html || "", {
        wordwrap: false,
        selectors: [
          { selector: "img", format: "skip" },
          { selector: "a", options: { ignoreHref: true } },
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
        ],
      }),
  );
  return {
    ...(await summary(x, p)),
    text: text.slice(0, 262144),
    textTruncated: text.length > 262144,
    attachments: p.attachments.map((a, i) => ({
      index: i + 1,
      filename: clean(a.filename || "unnamed"),
      mimeType: clean(a.mimeType),
      bytes: a.content.byteLength,
    })),
    contentTrust: "untrusted-email",
    note: "Retained content only. Missing/stripped attachments cannot be recovered.",
  };
}
export async function route(c, o, deadline) {
  const q = {
    limit: intArg(o.limit || "20", 1, 100),
    offset: intArg(o.offset || "0", 0, 1000000),
  };
  if (o.address) address(o.address);
  if (c.credentials.mode === "admin") {
    check(
      !(o.unknownAddress && o.address),
      "Unknown-address and exact-address filters are mutually exclusive.",
    );
    if (o.address) q.address = o.address;
    return {
      path: o.unknownAddress ? "/admin/mails_unknow" : "/admin/mails",
      query: q,
    };
  }
  check(!o.unknownAddress, "Unknown mail requires administrator credentials.");
  if (o.address) {
    const d = await c.get("/api/settings", {}, deadline);
    obj(d);
    check(
      d.address === o.address,
      "Requested address differs from authenticated mailbox.",
    );
  }
  return { path: "/api/mails", query: q };
}
export async function list(c, o, deadline) {
  const r = await route(c, o, deadline);
  const p = page(await c.get(r.path, r.query, deadline));
  check(p.results.length <= r.query.limit, "API returned too many rows.");
  const ids = new Set();
  let previous = Infinity;
  for (const item of p.results) {
    row(item);
    check(
      !ids.has(item.id) && item.id < previous,
      "Invalid/duplicate mail order.",
    );
    ids.add(item.id);
    previous = item.id;
    if (o.address)
      check(
        item.address === o.address,
        "Server returned a different recipient.",
      );
  }
  return {
    rows: p.results,
    count: r.query.offset === 0 ? p.count : null,
    offset: r.query.offset,
  };
}
export async function get(c, id, expected) {
  integer(intArg(id, 1, Number.MAX_SAFE_INTEGER), 1);
  if (expected) address(expected);
  const path = c.credentials.mode === "admin" ? "/admin/mails/" : "/api/mail/";
  const x = await c.get(path + id);
  if (x === null) fail("NOT_FOUND", "Mail not found or not accessible.", 4);
  row(x);
  check(x.id === Number(id), "Server returned a different mail ID.");
  if (expected)
    check(x.address === expected, "Server returned a different recipient.");
  return x;
}
export async function exportMail(c, id, o) {
  const x = await get(c, id, o.address);
  return {
    ...(await privatePublish(o.output, Buffer.from(x.raw, "utf8"))),
    mailId: x.id,
    format: "retained-eml",
  };
}
export async function exportAttachment(c, id, o) {
  const index = intArg(o.index, 1, 10000);
  const x = await get(c, id, o.address);
  const p = await parse(x);
  check(
    index <= p.attachments.length,
    "Attachment does not exist in retained mail.",
  );
  const a = p.attachments[index - 1];
  return {
    ...(await privatePublish(o.output, Buffer.from(a.content))),
    mailId: x.id,
    index,
    filename: clean(a.filename || "unnamed"),
  };
}
export function registerMail(program, action, client) {
  const m = program
    .command("mail")
    .description("Read, wait, export and explicitly mark one retained mail");
  m.command("list")
    .option("--address <email>", "Exact recipient")
    .option("--unknown-address", "Administrator: unregistered recipients")
    .option("--limit <n>", "Page size, 1-100", "20")
    .option("--offset <n>", "Live offset, not a snapshot", "0")
    .action(
      action("mail list", async (o) => {
        const c = await client(true);
        const p = await list(c, o);
        const items = [];
        for (const x of p.rows) items.push(await summary(x));
        return {
          items,
          totalAtFirstPage: p.count,
          offset: p.offset,
          livePagination: true,
          readActivityMayUpdate: c.credentials.mode === "mailbox",
        };
      }),
    );
  m.command("show <id>")
    .option("--address <email>", "Require exact recipient")
    .action(
      action("mail show", async (id, o) =>
        shown(await get(await client(true), id, o.address)),
      ),
    );
  m.command("export <id>")
    .requiredOption("--output <file>", "New private .eml path")
    .option("--address <email>", "Require exact recipient")
    .action(
      action("mail export", async (id, o) =>
        exportMail(await client(true), id, o),
      ),
    );
  m.command("attachment <id>")
    .requiredOption("--index <n>", "One-based attachment index from mail show")
    .requiredOption(
      "--output <file>",
      "Explicit new file; never use remote filename as a path",
    )
    .option("--address <email>", "Require exact recipient")
    .action(
      action("mail attachment", async (id, o) =>
        exportAttachment(await client(true), id, o),
      ),
    );
  return m;
}

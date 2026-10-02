import { setTimeout as sleep } from "node:timers/promises";
import { check, fail } from "./errors.mjs";
import { list, shown, address } from "./mail.mjs";
export function duration(value, min, max) {
  const m = /^([0-9]+)(ms|s|m)$/.exec(value);
  check(m, "Duration requires ms, s or m.");
  const n = Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]];
  check(
    Number.isSafeInteger(n) && n >= min && n <= max,
    "Duration out of range.",
  );
  return n;
}
export async function wait(c, o) {
  address(o.address);
  if (o.from) address(o.from);
  if (o.subject) check(o.subject.length <= 200, "Subject filter too long.");
  const timeout = duration(o.timeout, 100, 600000),
    interval = duration(o.interval, 100, 30000);
  check(
    interval >= 1000 || c.profile.allowLoopbackHttp,
    "Production polling interval must be at least 1s.",
  );
  const deadline = Date.now() + timeout;
  const query = { address: o.address, limit: "100", offset: "0" };
  const base = await list(c, query, deadline);
  const baseline = base.rows[0]?.id ?? 0;
  let watermark = baseline;
  let transientFailures = 0;
  while (Date.now() < deadline) {
    await sleep(
      Math.min(
        interval * Math.min(2 ** transientFailures, 8),
        30000,
        Math.max(0, deadline - Date.now()),
      ),
    );
    if (Date.now() >= deadline) break;
    let p;
    try {
      p = await list(c, query, deadline);
      transientFailures = 0;
    } catch (e) {
      if (
        ["RATE_LIMITED", "NETWORK", "HTTP_ERROR"].includes(e.code) &&
        transientFailures < 3
      ) {
        transientFailures++;
        continue;
      }
      throw e;
    }
    if (p.rows.length && p.rows[0].id < watermark)
      fail(
        "WATCH_RESET",
        "Mail IDs regressed; restart with a new baseline.",
        5,
      );
    const newer = p.rows.filter((r) => r.id > watermark);
    if (p.rows.length === 100 && newer.length === 100)
      fail(
        "WATCH_GAP",
        "More than one page of new mail; completeness cannot be guaranteed.",
        5,
      );
    let selected;
    for (const x of newer.toReversed()) {
      const m = await shown(x);
      if (o.from && m.from !== o.from) continue;
      if (
        o.subject &&
        !m.subject.toLowerCase().includes(o.subject.toLowerCase())
      )
        continue;
      selected = m;
      break;
    }
    if (Date.now() >= deadline) break;
    if (selected)
      return {
        baselineId: baseline,
        mail: selected,
        polling: true,
        losslessStream: false,
        readActivityMayUpdate: c.credentials.mode === "mailbox",
      };
    watermark = Math.max(watermark, p.rows[0]?.id ?? 0);
  }
  fail("NO_NEW_MAIL", "No matching new mail before timeout.", 4);
}

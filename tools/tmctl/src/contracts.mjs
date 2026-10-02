import { check, clean } from "./errors.mjs";
export const obj = (x) =>
  check(
    x !== null && typeof x === "object" && !Array.isArray(x),
    "Invalid API object.",
  );
export const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  check(Number.isSafeInteger(v) && v >= min && v <= max, "Invalid integer.");
  return v;
};
export const intArg = (s, min, max) => {
  check(/^[0-9]+$/.test(String(s)), "Expected decimal integer.");
  return integer(Number(s), min, max);
};
export function page(x) {
  obj(x);
  check(
    Array.isArray(x.results) && x.results.length <= 100,
    "Invalid API page.",
  );
  integer(x.count);
  return x;
}
export function addressRow(x) {
  obj(x);
  integer(x.id, 1);
  check(typeof x.name === "string", "Invalid address row.");
  return {
    id: x.id,
    address: clean(x.name),
    mailCount: integer(x.mail_count),
    sentCount: integer(x.send_count),
    createdAt: typeof x.created_at === "string" ? clean(x.created_at) : null,
  };
}
export function stats(x) {
  obj(x);
  const out = {};
  for (const k of [
    "mailCount",
    "addressCount",
    "activeAddressCount7days",
    "activeAddressCount30days",
    "userCount",
    "sendMailCount",
  ])
    out[k] = integer(x[k]);
  return out;
}
export function cleanup(x) {
  if (x === null) return { configured: false };
  obj(x);
  const out = { configured: true };
  for (const [k, v] of Object.entries(x)) {
    if (
      /^enable(?:Mails|UnknowMails|SendBox|Address|InactiveAddress|UnboundAddress|EmptyAddress)AutoCleanup$/.test(
        k,
      ) &&
      typeof v === "boolean"
    )
      out[k] = v;
    else if (
      /^clean(?:Mails|UnknowMails|SendBox|Address|InactiveAddress|UnboundAddress|EmptyAddress)Days$/.test(
        k,
      )
    )
      out[k] = integer(v);
  }
  out.customRulesCount = Array.isArray(x.customSqlCleanupList)
    ? x.customSqlCleanupList.length
    : 0;
  return out;
}
export function domains(x) {
  obj(x);
  check(
    Array.isArray(x.domains) && x.domains.every((v) => typeof v === "string"),
    "Invalid domain settings.",
  );
  return {
    domains: x.domains.map(clean),
    defaultDomains: Array.isArray(x.defaultDomains)
      ? x.defaultDomains.map(clean)
      : [],
    version: typeof x.version === "string" ? clean(x.version) : "unknown",
    anonymousCreationDisabled: x.disableAnonymousUserCreateEmail === true,
  };
}

import { check, fail, CliError } from "./errors.mjs";
import { privateRead } from "./files.mjs";
import * as store from "./store.mjs";
export function validateCredentials(c, profile) {
  check(
    c && typeof c === "object" && c.server === profile.server,
    "Credential origin does not match profile.",
  );
  check(
    ["admin", "mailbox"].includes(c.mode),
    "Credential mode must be admin or mailbox.",
  );
  for (const k of ["secret", "sitePassword"])
    if (c[k] !== undefined)
      check(
        typeof c[k] === "string" &&
          c[k].length > 0 &&
          c[k].length <= 8192 &&
          !/[\x00-\x20\x7f-\x9f]/.test(c[k]),
        "Invalid credential format; contents suppressed.",
      );
  check(!!c.secret, "Credential required.");
  return {
    server: c.server,
    mode: c.mode,
    secret: c.secret,
    ...(c.sitePassword ? { sitePassword: c.sitePassword } : {}),
  };
}
export async function credentials(options, profile) {
  check(
    !(options.credentialsStdin && options.credentialFile),
    "Choose one credential input.",
  );
  let c;
  if (options.credentialsStdin) {
    check(!process.stdin.isTTY, "Use a controlled pipe for credential JSON.");
    const chunks = [];
    let n = 0;
    for await (const b of process.stdin) {
      n += b.length;
      check(n <= 16384, "Credential input too large.");
      chunks.push(b);
    }
    try {
      c = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("INVALID_ARGUMENT", "Invalid credential JSON; contents suppressed.");
    }
  } else if (options.credentialFile) {
    try {
      c = JSON.parse((await privateRead(options.credentialFile)).toString());
    } catch (e) {
      if (e instanceof CliError) throw e;
      fail("INVALID_ARGUMENT", "Cannot read private credential file.");
    }
  } else c = await store.cached(profile.name);
  if (!c)
    fail(
      "AUTH_REQUIRED",
      "Supply credentials through a controlled pipe/private file or log in explicitly.",
      3,
    );
  return validateCredentials(c, profile);
}
export const privilegeWarning =
  "Client commands are read-only; the underlying admin password/mailbox JWT is NOT a read-only credential. Local logout does not revoke server access.";

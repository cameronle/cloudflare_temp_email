import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { check, fail } from "./errors.mjs";
import { privateDir, privateRead, privatePublish } from "./files.mjs";
export const home = () =>
  resolve(process.env.TMCTL_HOME || join(homedir(), ".config", "tmctl"));
export function origin(value, allow = false) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("INVALID_ARGUMENT", "Invalid server origin.");
  }
  check(
    u.username === "" &&
      u.password === "" &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash,
    "Server must be an origin without credentials or path.",
  );
  check(
    u.protocol === "https:" ||
      (allow && u.protocol === "http:" && u.hostname === "127.0.0.1"),
    "HTTPS required; explicit numeric loopback HTTP is test-only.",
  );
  return u.origin;
}
export function name(value) {
  check(/^[a-zA-Z0-9_-]{1,48}$/.test(value), "Invalid profile name.");
  return value;
}
export async function load(n) {
  try {
    const p = JSON.parse(
      (await privateRead(join(home(), name(n) + ".json"))).toString(),
    );
    check(p.schemaVersion === 1 && p.name === n, "Invalid profile.");
    p.server = origin(p.server, p.allowLoopbackHttp === true);
    return p;
  } catch (e) {
    if (e.code === "ENOENT")
      fail("PROFILE_REQUIRED", "Add a profile first.", 3);
    throw e;
  }
}
export async function add(n, server, allow) {
  await privateDir(home());
  const p = {
    schemaVersion: 1,
    name: name(n),
    server: origin(server, allow),
    allowLoopbackHttp: !!allow,
  };
  await privatePublish(
    join(home(), n + ".json"),
    Buffer.from(JSON.stringify(p) + "\n"),
  );
  return p;
}
export async function cached(n) {
  try {
    return JSON.parse(
      (await privateRead(join(home(), name(n) + ".auth.json"))).toString(),
    );
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function save(n, creds) {
  await privatePublish(
    join(home(), name(n) + ".auth.json"),
    Buffer.from(JSON.stringify(creds) + "\n"),
  );
}
export async function logout(n) {
  const file = join(home(), name(n) + ".auth.json");
  try {
    await privateRead(file);
    await unlink(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return { localCredentialsRemoved: true, serverRevoked: false };
}

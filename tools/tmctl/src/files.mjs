import { constants } from "node:fs";
import { lstat, open, mkdir, link, unlink } from "node:fs/promises";
import { resolve, parse, join, dirname, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { check, fail } from "./errors.mjs";
export async function safePath(value, leafMissing = false) {
  check(
    typeof value === "string" && value && !/[\x00-\x1f\x7f]/.test(value),
    "Explicit safe file path required.",
  );
  const path = resolve(value);
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/")) {
    current = join(current, part);
    let s;
    try {
      s = await lstat(current);
    } catch (e) {
      if (e.code === "ENOENT" && leafMissing && current === path) return path;
      throw e;
    }
    check(!s.isSymbolicLink(), "Symbolic links are not allowed.");
    if (current !== path)
      check(
        s.isDirectory() &&
          (!(s.mode & 0o022) || (s.uid === 0 && !!(s.mode & 0o1000))),
        "Unsafe parent directory.",
      );
  }
  return path;
}
export async function privateRead(value, max = 16384) {
  const path = await safePath(value);
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await fd.stat();
    check(
      s.isFile() &&
        s.nlink === 1 &&
        (s.mode & 0o777) === 0o600 &&
        s.uid === process.getuid() &&
        s.size <= max,
      "Private input must be owned, single-link, 0600 and bounded.",
    );
    const b = Buffer.alloc(max + 1);
    let n = 0;
    while (n < b.length) {
      const r = await fd.read(b, n, b.length - n, n);
      if (!r.bytesRead) break;
      n += r.bytesRead;
    }
    check(n <= max, "Private input too large.");
    return b.subarray(0, n);
  } finally {
    await fd.close();
  }
}
export async function privatePublish(value, bytes) {
  const path = await safePath(value, true);
  try {
    await lstat(path);
    fail("EXISTS", "Refusing to overwrite an existing file.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const parent = await lstat(dirname(path));
  check(
    parent.uid === process.getuid() && !(parent.mode & 0o022),
    "Output parent must be owned and not group/world writable.",
  );
  const tmp = join(
    dirname(path),
    "." + basename(path) + "." + randomUUID() + ".tmp",
  );
  let published = false;
  let fd;
  try {
    fd = await open(
      tmp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await fd.writeFile(bytes);
    await fd.sync();
    await fd.close();
    fd = null;
    await safePath(path, true);
    await link(tmp, path);
    published = true;
    await unlink(tmp);
    const actual = await privateRead(path, bytes.length);
    const hash = (b) => createHash("sha256").update(b).digest("hex");
    check(
      hash(actual) === hash(bytes),
      "Saved content failed read-back validation.",
    );
    return { path, bytes: bytes.length, sha256: hash(actual), mode: "0600" };
  } finally {
    if (fd) await fd.close();
    await unlink(tmp).catch(() => {});
  }
}
export async function privateDir(path) {
  let parent = resolve(path);
  for (;;) {
    try {
      await lstat(parent);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      parent = dirname(parent);
    }
  }
  await safePath(parent);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await safePath(path);
  const s = await lstat(path);
  check(
    s.uid === process.getuid() && (s.mode & 0o777) === 0o700,
    "Configuration directory must be owned and 0700.",
  );
}

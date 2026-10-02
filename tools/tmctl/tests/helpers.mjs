import { spawn } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
export async function temp() {
  return realpath(await mkdtemp(join(tmpdir(), "tmctl-test-")));
}
export async function cli(
  args,
  {
    home,
    input,
    bin = process.env.TMCTL_TEST_BIN ||
      new URL("../src/cli.mjs", import.meta.url).pathname.replace(
        "/tests/src/",
        "/src/",
      ),
    env = {},
  } = {},
) {
  const p = spawn(process.execPath, [bin, "--json", ...args], {
    env: { ...process.env, TMCTL_HOME: home, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  p.stdout.on("data", (b) => (stdout += b));
  p.stderr.on("data", (b) => (stderr += b));
  p.stdin.on("error", () => {});
  p.stdin.end(input ?? "");
  const timer = setTimeout(() => p.kill("SIGKILL"), 20000);
  const code = await new Promise((r) => p.on("exit", r));
  clearTimeout(timer);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {}
  return { code, stdout, stderr, result };
}
export async function server(handler) {
  const requests = [];
  const s = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${s.address().port}`,
    requests,
    close: () =>
      new Promise((r) => {
        s.closeAllConnections();
        s.close(r);
      }),
  };
}
export function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
export async function profile(home, url) {
  return cli(
    ["profile", "add", "test", "--server", url, "--allow-loopback-http"],
    { home },
  );
}
export { rm };

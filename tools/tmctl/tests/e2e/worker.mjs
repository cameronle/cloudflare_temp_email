import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
export async function fixture(bindings = {}) {
  const builtins = new Set(builtinModules.map((x) => x.replace(/^node:/, "")));
  const bundle = await build({
    stdin: {
      contents: `import worker from './worker/src/worker.ts';export default {async fetch(req,env,ctx){if(new URL(req.url).pathname==='/__fixture/receive'){const b=await req.json();let rejected=null;await worker.email({to:b.to,from:'sender@example.test',headers:new Headers({'Message-ID':'<'+crypto.randomUUID()+'@example.test>'}),raw:new Blob([b.raw]).stream(),rawSize:new TextEncoder().encode(b.raw).length,setReject:reason=>{rejected=reason},forward:()=>{throw new Error('outbound blocked')},reply:()=>{throw new Error('outbound blocked')}},env,ctx);return Response.json({rejected});}return worker.fetch(req,env,ctx)}};`,
      resolveDir: repo,
      sourcefile: "tmctl-fixture.ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "node-builtins",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            builtins.has(a.path)
              ? { path: "node:" + a.path, external: true }
              : undefined,
          );
        },
      },
    ],
    banner: {
      js: 'import {createRequire as __cr} from "node:module"; const require=__cr("/worker.js");',
    },
    write: false,
    logLevel: "silent",
  });
  const outboundService = async () =>
    new Response("Fixture outbound disabled", { status: 502 });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-03",
      compatibilityFlags: ["nodejs_compat"],
      host: "127.0.0.1",
      port: 0,
      d1Databases: { DB: "tmctl-test" },
      kvNamespaces: ["KV"],
      bindings: {
        JWT_SECRET: "synthetic-test-only-jwt-secret",
        ADMIN_PASSWORDS: ["fixture-admin"],
        DOMAINS: ["example.test"],
        DEFAULT_DOMAINS: ["example.test"],
        ENABLE_USER_CREATE_EMAIL: true,
        DISABLE_ANONYMOUS_USER_CREATE_EMAIL: true,
        ENABLE_USER_DELETE_EMAIL: true,
        ...bindings,
      },
      outboundService,
      log: new Log(LogLevel.ERROR),
    }),
  );
  const db = await mf.getD1Database("DB");
  const schema = await readFile(repo + "db/schema.sql", "utf8");
  await db.batch(
    schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  const url = (await mf.ready).origin;
  const headers = {
    "content-type": "application/json",
    "x-admin-auth": "fixture-admin",
  };
  async function create(name) {
    const r = await fetch(url + "/admin/new_address", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name,
        domain: "example.test",
        enablePrefix: false,
      }),
    });
    if (!r.ok) throw new Error("fixture address creation failed: " + r.status);
    return r.json();
  }
  async function receive(to, raw) {
    const r = await fetch(url + "/__fixture/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, raw }),
    });
    if (!r.ok) throw new Error("fixture email failed: " + r.status);
    const d = await r.json();
    if (d.rejected) throw new Error("fixture mail rejected");
  }
  async function fingerprint() {
    const data = {};
    for (const t of [
      "raw_mails",
      "address",
      "users",
      "users_address",
      "settings",
      "sendbox",
      "address_sender",
    ]) {
      const { results } = await db
        .prepare("SELECT * FROM " + t + " ORDER BY rowid")
        .all();
      data[t] = results.map((x) =>
        t === "address" ? { ...x, updated_at: "activity-excluded" } : x,
      );
    }
    return JSON.stringify(data);
  }
  return {
    mf,
    db,
    url,
    create,
    receive,
    fingerprint,
    close: () => mf.dispose(),
  };
}

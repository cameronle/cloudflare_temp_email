import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("production launcher admits new reads but blocks every write, profile override and approval flag", () => {
  const script = fileURLToPath(
    new URL("../scripts/tmctl-prod.py", import.meta.url),
  );
  const python = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for args in [['--json','outbox','list'],['send-access','list'],['send-access','show','--address','box@example.test'],['stats']]: m.validate_args(args)
for args in [['addresses','create','--yes'],['mail','mark','17','--read','--yes'],['outbox','list','--yes'],['stats','--credential-file=x'],['send-access','update'],['cleanup','run'],['mail','delete','1'],['stats','--save-profile','x']]:
 try: m.validate_args(args)
 except ValueError: pass
 else: raise AssertionError('Unsafe launcher route accepted')
print('launcher-contract-pass')`;
  const r = spawnSync("python3", ["-c", python, script], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /launcher-contract-pass/);
});

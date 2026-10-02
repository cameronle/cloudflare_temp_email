#!/usr/bin/python3
"""Local read-only tmctl launcher; credentials are transient and origin-bound."""
import json
import os
import pwd
import shlex
import stat
import subprocess
import sys

ORIGIN = "https://mail-api.865455.xyz"
SECRET_FILE = "/etc/hermes-secrets/temp-mail-865455.env"
NODE = "/home/hermes/.hermes/node/bin/node"
CLI = "/home/hermes/.hermes/node/lib/node_modules/cloudflare-temp-mail-cli/bin/tmctl.mjs"
USAGE = "Usage: sudo -n /usr/local/sbin/tmctl-prod [--json] doctor|domains|stats|auth status|addresses list|cleanup show|mail list/show/wait/export/attachment|outbox list|send-access list/show ..."


def validate_args(args):
    forbidden = {
        "--profile", "--credentials-stdin", "--credential-file", "--server",
        "--allow-loopback-http", "--yes", "--dry-run", "--save-profile",
        "--read", "--unread", "--name", "--random-name",
    }
    if any(a.split("=", 1)[0] in forbidden for a in args):
        raise ValueError("Credential/profile overrides and write flags are disabled.")
    words = [a for a in args if a != "--json"]
    if not words:
        raise ValueError("A read command is required.")
    allowed = words[0] in {"doctor", "domains", "stats"} or tuple(words[:2]) in {
        ("auth", "status"), ("addresses", "list"), ("cleanup", "show"),
        ("mail", "list"), ("mail", "show"), ("mail", "wait"),
        ("mail", "export"), ("mail", "attachment"), ("outbox", "list"),
        ("send-access", "list"), ("send-access", "show"),
    }
    if not allowed:
        raise ValueError("Only the installed read-only command set is allowed.")


def run():
    args = sys.argv[1:]
    if not args or args == ["--help"]:
        print(USAGE)
        return 0
    validate_args(args)
    if os.geteuid() != 0:
        raise ValueError("Run through sudo -n.")
    fd = os.open(SECRET_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as handle:
        s = os.fstat(handle.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != 0o600 or s.st_nlink != 1 or s.st_size > 16384:
            raise ValueError("Credential source permissions rejected.")
        text = handle.read(16385)
    values = {}
    for line in text.splitlines():
        if line.startswith("ADMIN_PASSWORDS="):
            value = line.split("=", 1)[1]
            try:
                values["admin"] = json.loads(value)
            except json.JSONDecodeError:
                values["admin"] = json.loads(shlex.split(value)[0])
    passwords = values.get("admin")
    if not isinstance(passwords, list) or len(passwords) != 1 or not isinstance(passwords[0], str) or not passwords[0]:
        raise ValueError("Expected exactly one configured admin credential; no guessing.")
    identity = pwd.getpwnam("hermes")

    def drop_privileges():
        os.initgroups(identity.pw_name, identity.pw_gid)
        os.setgid(identity.pw_gid)
        os.setuid(identity.pw_uid)
        os.umask(0o077)

    env = {
        "HOME": identity.pw_dir,
        "PATH": "/home/hermes/.hermes/node/bin:/usr/bin:/bin",
        "TMCTL_HOME": "/home/hermes/.config/tmctl",
        "TMPDIR": "/home/hermes/.hermes/cache/scratch",
        "LANG": "C.UTF-8",
    }
    process = subprocess.Popen(
        [NODE, CLI, "--profile", "prod", "--credentials-stdin", *args],
        stdin=subprocess.PIPE, env=env, preexec_fn=drop_privileges,
    )
    try:
        process.communicate(json.dumps({"server": ORIGIN, "mode": "admin", "secret": passwords[0]}).encode(), timeout=660)
    except (KeyboardInterrupt, subprocess.TimeoutExpired):
        process.terminate()
        process.wait(timeout=10)
        return 130
    return process.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except Exception:
        print("tmctl-prod: local launcher failed; credential contents suppressed.", file=sys.stderr)
        raise SystemExit(2)

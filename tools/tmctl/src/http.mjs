import { check, fail, CliError } from "./errors.mjs";
import { validateCredentials } from "./auth.mjs";
const publicPaths = new Set(["/health_check", "/open_api/settings"]);
export class Client {
  constructor(profile, credentials = null, timeout = 15000) {
    this.profile = profile;
    this.credentials = credentials;
    this.timeout = timeout;
  }
  async get(path, query = {}, deadline = Date.now() + this.timeout) {
    return this.request("GET", path, query, deadline);
  }
  async createAddress(body) {
    return this.request(
      "POST",
      "/admin/new_address",
      {},
      Date.now() + this.timeout,
      body,
    );
  }
  async markRead(id, isUnread) {
    return this.request(
      "PATCH",
      `/api/mails/${id}/read`,
      {},
      Date.now() + this.timeout,
      { isUnread },
    );
  }
  async request(
    method,
    path,
    query = {},
    deadline = Date.now() + this.timeout,
    body,
  ) {
    const creating = method === "POST" && path === "/admin/new_address";
    const marking =
      method === "PATCH" && /^\/api\/mails\/[1-9][0-9]*\/read$/.test(path);
    if (creating || marking) {
      check(
        Object.keys(query).length === 0 &&
          body &&
          typeof body === "object" &&
          !Array.isArray(body),
        "Invalid write payload.",
      );
      if (creating)
        check(
          Object.keys(body).sort().join(",") ===
            "domain,enablePrefix,enableRandomSubdomain,name" &&
            /^[a-z0-9]{1,30}$/.test(body.name) &&
            typeof body.domain === "string" &&
            body.enablePrefix === false &&
            body.enableRandomSubdomain === false,
          "Invalid creation payload.",
        );
      else
        check(
          Object.keys(body).join(",") === "isUnread" &&
            typeof body.isUnread === "boolean",
          "Invalid read-marker payload.",
        );
    } else
      check(
        method === "GET" && body === undefined,
        "Unsupported write route or method.",
      );
    const admin =
      creating ||
      (method === "GET" &&
        ([
          "/admin/statistics",
          "/admin/address",
          "/admin/auto_cleanup",
          "/admin/sendbox",
          "/admin/address_sender",
          "/admin/mails",
          "/admin/mails_unknow",
        ].includes(path) ||
          /^\/admin\/mails\/[1-9][0-9]*$/.test(path)));
    const mailbox =
      marking ||
      (method === "GET" &&
        (["/api/mails", "/api/settings", "/api/sendbox"].includes(path) ||
          /^\/api\/mail\/[1-9][0-9]*$/.test(path)));
    check(
      (method === "GET" && publicPaths.has(path)) || admin || mailbox,
      "Unsupported route.",
    );
    const headers = { Accept: "application/json", "x-lang": "en" };
    if (admin || mailbox) {
      if (!this.credentials)
        fail("AUTH_REQUIRED", "Authentication required.", 3);
      const c = validateCredentials(this.credentials, this.profile);
      check(
        (admin && c.mode === "admin") || (mailbox && c.mode === "mailbox"),
        "Credential mode does not authorize this route.",
      );
      headers[c.mode === "admin" ? "x-admin-auth" : "Authorization"] =
        c.mode === "admin" ? c.secret : "Bearer " + c.secret;
      if (c.sitePassword) headers["x-custom-auth"] = c.sitePassword;
    }
    if (path === "/health_check" && this.credentials?.sitePassword)
      headers["x-custom-auth"] = validateCredentials(
        this.credentials,
        this.profile,
      ).sitePassword;
    const url = new URL(path, this.profile.server);
    check(url.origin === this.profile.server, "Origin mismatch.");
    for (const [k, v] of Object.entries(query))
      url.searchParams.set(k, String(v));
    if (body) headers["Content-Type"] = "application/json";
    const abort = new AbortController();
    const remaining = deadline - Date.now();
    const deadlineLimited = remaining <= this.timeout;
    const timer = setTimeout(
      () => abort.abort(),
      Math.max(1, Math.min(this.timeout, remaining)),
    );
    try {
      const r = await fetch(url, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: abort.signal,
        headers,
      });
      if (r.status === 401)
        fail("AUTH_REQUIRED", "Authentication rejected.", 3);
      if (r.status === 403) fail("FORBIDDEN", "Permission denied.", 3);
      if (r.status === 429)
        fail("RATE_LIMITED", "Rate limited; retry later.", 5);
      if (!r.ok)
        fail("HTTP_ERROR", `HTTP ${r.status}; response suppressed.`, 5);
      const reader = r.body.getReader();
      let size = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024)
          fail("TOO_LARGE", "Response exceeds 16 MiB.", 5);
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (path === "/health_check") {
        check(text.trim() === "OK", "Unexpected health response.");
        return true;
      }
      if (!r.headers.get("content-type")?.includes("application/json"))
        fail("PROTOCOL", "Expected JSON, not a login or error page.", 5);
      try {
        return JSON.parse(text);
      } catch {
        fail("PROTOCOL", "Invalid JSON; content suppressed.", 5);
      }
    } catch (e) {
      if (e instanceof CliError) throw e;
      const error = new CliError(
        abort.signal.aborted ? "TIMEOUT" : "NETWORK",
        abort.signal.aborted
          ? "Request deadline exceeded."
          : "Request failed; redirects are not followed.",
        5,
      );
      error.deadlineLimited = abort.signal.aborted && deadlineLimited;
      throw error;
    } finally {
      abort.abort();
      clearTimeout(timer);
    }
  }
}

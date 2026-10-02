export class CliError extends Error {
  constructor(code, message, exit = 2) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}
export function fail(code, message, exit = 2) {
  throw new CliError(code, message, exit);
}
export function check(value, message = "Invalid arguments.") {
  if (!value) fail("INVALID_ARGUMENT", message);
  return value;
}
export function clean(s) {
  return String(s)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

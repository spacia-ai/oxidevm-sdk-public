import { VMError } from "../runtime/errors.js";

type DoctorBrowser = "chromium" | "firefox" | "webkit";

// Only the browser's own error name leaves this module: raw messages can carry local paths.
const NETWORK_ERROR = /\b(net::ERR_[A-Z_]{1,64}|NS_ERROR_[A-Z_]{1,64})\b/u;
const WEBKIT_REFUSED = /\bCould not connect to server\b/u;

function cause(failure: unknown): string | undefined {
  if (typeof failure === "number" && Number.isSafeInteger(failure)) return `HTTP ${String(failure)}`;
  if (!(failure instanceof Error)) return undefined;
  const named = NETWORK_ERROR.exec(failure.message)?.[1];
  if (named !== undefined) return named;
  return WEBKIT_REFUSED.test(failure.message) ? "connection refused" : undefined;
}

/** Doctor's application URL did not load: the network error or HTTP status, and what to do about it. */
export function navigationFailure(url: string, failure: unknown): VMError {
  const location = new URL(url), shown = `${location.origin}${location.pathname}`, reason = cause(failure);
  return new VMError("STORAGE_ERROR", `doctor could not load ${shown}${reason === undefined ? "" : ` (${reason})`}; start the application server or pass its URL`, {
    reason: "doctor-url-unreachable", ...(reason === undefined ? {} : { cause: reason }),
  });
}

/** The selected browser did not start, usually because Playwright has not installed it. Its raw error stays local. */
export function browserStartFailure(browser: DoctorBrowser): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", `doctor could not start ${browser}; install it with \`npx playwright install ${browser}\``, { reason: "doctor-browser-unavailable" });
}

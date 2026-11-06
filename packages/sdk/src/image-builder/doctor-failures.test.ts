import { describe, expect, it } from "vitest";
import { browserStartFailure, navigationFailure, requestCause } from "./doctor-failures.js";

describe("doctor failures", () => {
  it("names the URL and the browser's network error when the application does not answer", () => {
    const error = navigationFailure("http://127.0.0.1:5999/app/?token=secret#part", new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5999/app/?token=secret"));
    expect(error.code).toBe("STORAGE_ERROR");
    expect(error.message).toBe("doctor could not load http://127.0.0.1:5999/app/ (net::ERR_CONNECTION_REFUSED); start the application server or pass its URL");
    expect(error.detail).toEqual({ reason: "doctor-url-unreachable", cause: "net::ERR_CONNECTION_REFUSED" });
  });

  it("reports an HTTP status without the raw response", () => {
    const error = navigationFailure("http://localhost:5173/", 404);
    expect(error.message).toBe("doctor could not load http://localhost:5173/ (HTTP 404); start the application server or pass its URL");
    expect(error.detail).toEqual({ reason: "doctor-url-unreachable", cause: "HTTP 404" });
  });

  it("keeps an unknown failure generic instead of echoing its text", () => {
    const error = navigationFailure("http://localhost:5173/", new Error("/home/someone/private/path exploded"));
    expect(error.message).toBe("doctor could not load http://localhost:5173/; start the application server or pass its URL");
    expect(error.message).not.toContain("private");
    expect(error.detail).toEqual({ reason: "doctor-url-unreachable" });
  });

  it("accepts the network error names of Firefox and WebKit", () => {
    expect(navigationFailure("http://localhost:5173/", new Error("NS_ERROR_CONNECTION_REFUSED")).detail).toEqual({ reason: "doctor-url-unreachable", cause: "NS_ERROR_CONNECTION_REFUSED" });
    expect(navigationFailure("http://localhost:5173/", new Error("Could not connect to server")).detail).toEqual({ reason: "doctor-url-unreachable", cause: "connection refused" });
  });

  it("names why one of its own requests failed without echoing the raw error", () => {
    expect(requestCause(404)).toBe("HTTP 404");
    expect(requestCause(new Error("apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:9 at /home/someone/private"))).toBe("ECONNREFUSED");
    expect(requestCause(new Error("getaddrinfo ENOTFOUND run.example.net"))).toBe("ENOTFOUND");
    expect(requestCause(new Error("Request timed out after 30000ms"))).toBe("timed out");
    expect(requestCause(new Error("/home/someone/private/path exploded"))).toBe("request failed");
    expect(requestCause("not an error")).toBe("request failed");
  });

  it("tells how to install a browser that cannot start", () => {
    const error = browserStartFailure("firefox");
    expect(error.code).toBe("FEATURE_NOT_AVAILABLE");
    expect(error.message).toBe("doctor could not start firefox; install it with `npx playwright install firefox`");
    expect(error.detail).toEqual({ reason: "doctor-browser-unavailable" });
  });
});

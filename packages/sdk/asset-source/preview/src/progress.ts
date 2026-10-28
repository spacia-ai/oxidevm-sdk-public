// Navigation reports describe the address. Paint evidence belongs to this document.
export function previewProgress(parent: Window, origin: string): (value: unknown) => void {
  const identity = crypto.randomUUID();
  let navigation: string | null = null;
  let stage: "document" | "loaded" | "painted" = document.readyState === "complete" ? "loaded" : "document";
  const report = (): void => {
    parent.postMessage({ type: "oxidevm-preview-progress", version: 1, document: identity, navigation, stage }, origin);
  };
  window.addEventListener("load", () => {
    if (stage === "painted") return;
    stage = "loaded";
    if (navigation !== null) report();
  }, { once: true });
  if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes.includes("paint")) {
    const observer = new PerformanceObserver(entries => {
      if (!entries.getEntries().some(entry => entry.name === "first-contentful-paint")) return;
      stage = "painted";
      observer.disconnect();
      if (navigation !== null) report();
    });
    observer.observe({ type: "paint", buffered: true });
    window.addEventListener("pagehide", () => { observer.disconnect(); }, { once: true });
  }
  report();
  return (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 4
      || !("type" in value) || value.type !== "oxidevm-preview-observe" || !("version" in value) || value.version !== 1
      || !("document" in value) || (value.document !== null && value.document !== identity)
      || !("navigation" in value) || typeof value.navigation !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.navigation)) return;
    navigation = value.navigation;
    report();
  };
}

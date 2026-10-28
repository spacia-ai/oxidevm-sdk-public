import { expect, it, vi } from "vitest";
import type { RuntimeVM, PreviewHandle as RuntimePreviewHandle } from "./runtime/vm-types.js";
import { PreviewRoutes } from "./preview-routes.js";

function fixture() {
  let ports: Awaited<ReturnType<RuntimeVM["listeningPorts"]>> = [];
  const close = vi.fn(() => Promise.resolve());
  const opened = vi.fn((port: number): Promise<RuntimePreviewHandle> => Promise.resolve({ url: new URL(`https://session.preview.test/${port}`), close }));
  const readers = new Set<(value: typeof ports) => void>();
  const runtime: Pick<RuntimeVM, "listeningPorts" | "watchListeningPorts" | "exposePort"> = {
    listeningPorts: () => Promise.resolve(ports), exposePort: opened,
    watchListeningPorts: (listener, options) => new Promise<void>((resolve, reject) => {
      const notify = (value: typeof ports) => { try { listener(value); } catch (error) { readers.delete(notify); reject(error instanceof Error ? error : new Error("listener failed")); } };
      readers.add(notify); notify(ports);
      const stop = () => { readers.delete(notify); resolve(); };
      if (options.signal.aborted) stop(); else options.signal.addEventListener("abort", stop, { once: true });
    }),
  };
  return { routes: new PreviewRoutes(runtime, "per-session"), opened, close, listen: (port: number) => {
    ports = [...ports, { port, address: "127.0.0.1", program: "guest-server", previewable: true }];
    for (const notify of readers) notify(ports);
  } };
}
it("waits for the real listener and shares one route until the final exposure closes", async () => {
  const f = fixture(); const first = f.routes.expose(3000); const second = f.routes.expose(3000);
  await vi.waitFor(() => expect(f.opened).not.toHaveBeenCalled());
  f.listen(3000); const [a, b] = await Promise.all([first, second]);
  expect(f.opened).toHaveBeenCalledTimes(1); expect(a.url.href).toBe(b.url.href);
  await a.close(); await a.close(); expect(f.close).not.toHaveBeenCalled();
  await b.close(); expect(f.close).toHaveBeenCalledTimes(1); await f.routes.dispose();
});
it("cancels one waiting caller without withdrawing the other caller's route", async () => {
  const f = fixture(); const controller = new AbortController();
  const first = f.routes.expose(3000, controller.signal); const second = f.routes.expose(3000);
  const rejected = expect(first).rejects.toMatchObject({ code: "ABORTED" }); controller.abort(); await rejected;
  f.listen(3000); const survivor = await second;
  expect(f.opened).toHaveBeenCalledTimes(1); await survivor.close(); expect(f.close).toHaveBeenCalledTimes(1);
});
it("owns distinct ports and cancels pending admission on VM disposal", async () => {
  const f = fixture(); f.listen(3000); f.listen(4000);
  await Promise.all([f.routes.expose(3000), f.routes.expose(4000)]);
  const pending = f.routes.expose(5000); const rejection = expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await f.routes.dispose(); await rejection; expect(f.close).toHaveBeenCalledTimes(2);
});

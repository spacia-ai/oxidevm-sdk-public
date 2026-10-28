import { createVM, type ImageRef, type ProcessHandle } from "@oxidevm/sdk";
import { createAccelerationProfile, type AccelerationProfileOptions } from "@oxidevm/sdk/image-builder";
import { configureJSProcessTrace, readJSProcessTrace, type AccelerationEnvironmentRejection } from "@oxidevm/sdk/diagnostics";

export const profileMetadata: (options: AccelerationProfileOptions) => Promise<{ readonly path: string; readonly bytes: Uint8Array }> = createAccelerationProfile;

declare const swcFixtureImage: ImageRef<"userspace">;
export async function buildSWC(): Promise<ProcessHandle> {
  const vm = await createVM({ mode: "userspace", image: swcFixtureImage,
    commandInterceptors: "auto" });
  return vm.spawn({ command: "node", args: ["build.cjs"], cwd: "/workspace/swc" });
}

export async function buildNext(nextImage: ImageRef<"userspace">): Promise<void> {
  const vm = await createVM({ mode: "userspace", image: nextImage,
    commandInterceptors: "auto" });
  try {
    await configureJSProcessTrace(vm, 128);
    const process = await vm.spawn({ command: "bun", args: ["run", "build"], cwd: "/workspace" });
    const discard = (stream: ReadableStream<Uint8Array>) => stream.pipeTo(new WritableStream<Uint8Array>({ write() {} }));
    await Promise.all([discard(process.stdout), discard(process.stderr), process.exit]);
    const trace = await readJSProcessTrace(vm);
    for (const placement of trace.placements) {
      const entry: string | null = placement.entry;
      const parent: number | null = placement.parentPid;
      if (placement.placement === "linux") {
        const detail: AccelerationEnvironmentRejection | null = placement.environment;
        void detail;
      }
      void [entry, parent];
    }
  } finally { await vm.dispose(); }
}

import type { AssistanceOptions, DependencyInstallHandle, ProcessHandle } from "./vm-types.js";
import type { validateSpawnSpec } from "./vm-options.js";
import type { ControlOperations } from "./protocol.js";
import type { WorkerClient } from "./worker-client.js";

/** Advanced composition supplies this port; ordinary applications load no broker implementation. */
export interface AssistanceFrontEnd {
  assertPreparationAvailable(): void;
  approveBlockedBuilds(error: unknown, workspaceBaseSha256: string, cancellation?: AbortSignal): Promise<never>;
  spawn(spec: ReturnType<typeof validateSpawnSpec>, workspaceBaseSha256?: string): Promise<ProcessHandle>;
  cancelBootstrap(): Promise<void>;
  dispose(): void;
  connectInstallation(port: MessagePort, lifetime: AbortSignal): Promise<DependencyInstallHandle>;
}
export type AssistanceFrontEndFactory = (control: WorkerClient<ControlOperations>, options: AssistanceOptions) => AssistanceFrontEnd;

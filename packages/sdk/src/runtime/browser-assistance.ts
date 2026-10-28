import { decodeBlockedBuildIdentities, type BuildScriptDecision } from "./protocol/build-script-approval.js";
import { ASSISTANCE_LIMITS, type AssistanceBinding } from "./protocol/assistance.js";
import { ASSISTANCE_ARTIFACTS } from "./assistance-build.js";
import type { AssistancePreparation } from "./protocol/assistance-control.js";
import type { AssistanceArtifacts } from "./assistance-artifacts.js";
import { loadAssistanceManifest } from "./assistance-artifacts.js";
import { requireAssistanceAdmission } from "./assistance-admission.js";
import { decodeAssistanceBootstrapResult } from "./protocol/assistance-bootstrap.js";
import { VMError, deserializeError, serializeUnknownError } from "./errors.js";
import { GuestProcessTransport } from "./guest-process.js";
import type { ControlOperations } from "./protocol.js";
import type { WorkerClient } from "./worker-client.js";
import type { AssistanceOptions, DependencyInstallHandle, ProcessHandle } from "./vm-types.js";
import type { validateSpawnSpec } from "./vm-options.js";
import { connectDependencyInstallation } from "./dependency-installation.js";
import type { AssistanceFrontEnd } from "./assistance-front-end.js";

/** SDK document ownership is restricted to bootstrap/port transfer and public
 * handles. The control worker retains task admission and the entire lifecycle. */
export class BrowserAssistance implements AssistanceFrontEnd {
  readonly #control: WorkerClient<ControlOperations>;
  readonly #options: AssistanceOptions;
  readonly #stopped = new AbortController();
  #bootstrap: { readonly completion: Promise<void>; readonly stop: AbortController; waiters: number; ready: boolean } | undefined;
  #frame: HTMLIFrameElement | undefined;
  #processes = 0;
  #healthTimer: ReturnType<typeof setInterval> | undefined;
  #healthPending = false;
  #binding: AssistanceBinding | undefined;
  #approvingBuilds = false;

  constructor(control: WorkerClient<ControlOperations>, options: AssistanceOptions) {
    this.#control = control;
    this.#options = options;
    control.lifetime.addEventListener("abort", this.#controlLost, { once: true });
    if (control.lifetime.aborted) this.#controlLost();
  }

  assertPreparationAvailable(): void {
    if (this.#approvingBuilds) throw new VMError("FEATURE_NOT_AVAILABLE", "Wait for build-script approval before retrying preparation");
  }

  connectInstallation(port: MessagePort, lifetime: AbortSignal): Promise<DependencyInstallHandle> {
    return connectDependencyInstallation(port, lifetime);
  }

  async approveBlockedBuilds(error: unknown, workspaceBaseSha256: string, cancellation?: AbortSignal): Promise<never> {
    const callback = this.#options.approveBuildScript;
    if (!(error instanceof VMError) || error.code !== "STORAGE_ERROR" || error.detail?.["blockedBuilds"] === undefined || callback === undefined) throw error;
    const identities = decodeBlockedBuildIdentities(error.detail["blockedBuilds"]);
    if (identities.length === 0) throw error;
    this.assertPreparationAvailable();
    this.#approvingBuilds = true;
    const signal = AbortSignal.any([this.#stopped.signal, this.#control.lifetime, ...(cancellation === undefined ? [] : [cancellation])]);
    try {
      const decisions: BuildScriptDecision[] = [];
      for (const identity of identities) {
        if (signal.aborted) throw new VMError("ABORTED", "Build-script approval cancelled");
        const decision = await abortable(Promise.resolve(callback({ ...identity, signal })), signal);
        decisions.push({ ...identity, decision });
      }
      if (signal.aborted) throw new VMError("ABORTED", "Build-script approval cancelled");
      await this.#control.request("assistance-build-policy", { workspaceBaseSha256, decisions }, { signal });
    } finally { this.#approvingBuilds = false; }
    // Approval changes the next explicit attempt, never this installer's result.
    throw error;
  }

  async spawn(spec: ReturnType<typeof validateSpawnSpec>, workspaceBaseSha256?: string): Promise<ProcessHandle> {
    requireAssistanceAdmission();
    const entry = spec.args[0];
    if (entry === undefined) throw new VMError("INVALID_ARGUMENT", "Assistance requires a local script");
    if (this.#processes >= ASSISTANCE_LIMITS.processes) throw new VMError("QUOTA_EXCEEDED", "Assisted process capacity exhausted");
    const channel = new MessageChannel();
    this.#processes += 1;
    let reserved = true;
    const release = () => { if (reserved) { reserved = false; this.#processes -= 1; } };
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), 60_000);
    const signal = AbortSignal.any([this.#stopped.signal, deadline.signal, ...(spec.signal === undefined ? [] : [spec.signal])]);
    try {
      await this.#connected(signal);
      // Bootstrap is bounded independently. Native input verification remains
      // cancellable and may take longer than worker startup on the guest CPU.
      clearTimeout(timeout);
      const spawned = await this.#control.request("assistance-spawn", {
        entry, cwd: spec.cwd, args: spec.args.slice(1), env: spec.env, port: channel.port2,
        ...(workspaceBaseSha256 === undefined ? {} : { workspaceBaseSha256 }),
      }, { signal, transfer: [channel.port2] });
      const process = new GuestProcessTransport(channel.port1, spawned.pid, spawned.sessionId, {
        lifetime: this.#control.lifetime,
        write: async data => {
          for (let offset = 0; offset < data.length; offset += ASSISTANCE_LIMITS.chunk) {
            const bytes = data.slice(offset, offset + ASSISTANCE_LIMITS.chunk);
            await this.#control.request("assistance-input", { process: spawned.pid, bytes }, { transfer: [bytes.buffer] });
          }
          return data.length;
        },
        closeStdin: () => this.#control.request("assistance-input", { process: spawned.pid, bytes: null }),
        signal: value => this.#control.request("assistance-stop", { process: spawned.pid, signal: value }),
      });
      const abort = () => { void process.kill("KILL").catch(() => { /* Process exit retains the failure. */ }); };
      spec.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => { spec.signal?.removeEventListener("abort", abort); release(); };
      void process.exit.then(cleanup, cleanup);
      if (signal.aborted) {
        await process.kill("KILL");
        throw new VMError("ABORTED", "Assisted startup was aborted");
      }
      return process;
    } catch (error) {
      release(); channel.port1.close(); channel.port2.close();
      if (this.#control.lifetime.aborted) throw deserializeError(serializeUnknownError(this.#control.lifetime.reason));
      throw error;
    }
    finally { clearTimeout(timeout); }
  }

  readonly #controlLost = () => { if (this.#control.lifetime.aborted) this.dispose(); };

  cancelBootstrap(): Promise<void> {
    this.#stopped.abort();
    if (this.#bootstrap?.ready !== true) { this.#frame?.remove(); this.#frame = undefined; }
    return this.#bootstrap?.completion.catch(() => {}) ?? Promise.resolve();
  }
  dispose(): void {
    if (this.#healthTimer !== undefined) clearInterval(this.#healthTimer);
    this.#healthTimer = undefined;
    this.#control.lifetime.removeEventListener("abort", this.#controlLost);
    void this.cancelBootstrap();
    this.#frame?.remove();
    this.#frame = undefined;
  }

  async #connected(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new VMError("ABORTED", "Assisted startup was aborted");
    if (this.#bootstrap?.ready === true) await this.#checkBinding(signal);
    // Finish rollback before allowing a retry to acquire another frame or port.
    if (this.#bootstrap?.stop.signal.aborted === true) {
      await abortable(this.#bootstrap.completion.catch(() => {}), signal);
      return this.#connected(signal);
    }
    if (this.#bootstrap === undefined) {
      const stop = new AbortController();
      const attempt = { stop, waiters: 0, ready: false, completion: this.#connect(stop.signal) };
      this.#bootstrap = attempt;
      void attempt.completion.then(() => { attempt.ready = true; }, () => {
        if (this.#bootstrap === attempt) this.#bootstrap = undefined;
      });
    }
    const attempt = this.#bootstrap;
    attempt.waiters += 1;
    try { await abortable(attempt.completion, signal); }
    finally {
      attempt.waiters -= 1;
      if (attempt.waiters === 0 && !attempt.ready) attempt.stop.abort();
    }
  }

  async #checkBinding(signal: AbortSignal): Promise<void> {
    const binding = this.#binding;
    if (binding === undefined) return;
    const actual = await this.#control.request("assistance-status", undefined, { signal });
    if (this.#binding !== binding || (actual.session === binding.session && actual.generation === binding.generation)) return;
    if (actual.session !== binding.session || actual.generation <= binding.generation) {
      throw new VMError("PROTOCOL_ERROR", "Invalid assistance generation transition");
    }
    // Control fences idle generations before pause/restore/reboot. Its old
    // broker has retired; the next explicit spawn acquires a fresh bootstrap.
    if (this.#healthTimer !== undefined) clearInterval(this.#healthTimer);
    this.#healthTimer = undefined;
    this.#binding = undefined;
    this.#bootstrap = undefined;
    this.#frame?.remove();
    this.#frame = undefined;
  }

  #watchControl(binding: AssistanceBinding): void {
    this.#binding = binding;
    this.#healthTimer = setInterval(() => {
      if (this.#healthPending || this.#stopped.signal.aborted) return;
      this.#healthPending = true;
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(), 60_000);
      const signal = AbortSignal.any([deadline.signal, this.#stopped.signal]);
      void this.#checkBinding(signal).catch((error: unknown) => {
        if (this.#stopped.signal.aborted) return;
        // A live control can report a failed broker or guest. Preserve that
        // owner's failure instead of mislabelling its reply as control loss.
        this.#control.terminate(deadline.signal.aborted
          ? new VMError("GUEST_CRASH", "Assistance control lifeline lost", { cause: serializeUnknownError(error) })
          : deserializeError(serializeUnknownError(error)));
      }).finally(() => { clearTimeout(timeout); this.#healthPending = false; });
    }, 15_000);
  }

  async #connect(cancellation: AbortSignal): Promise<void> {
    const expected = ASSISTANCE_ARTIFACTS;
    if (expected === undefined || typeof document === "undefined" || !globalThis.crossOriginIsolated) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Assistance requires its isolated development document and pinned artifacts");
    }
    const signal = AbortSignal.any([this.#stopped.signal, cancellation, AbortSignal.timeout(60_000)]);
    const prepared = await this.#control.request("assistance-prepare", undefined, { signal });
    try { await this.#loadBroker(prepared, expected, signal); }
    catch (error) {
      const reservation = prepared.credits?.[0]?.reservation;
      if (reservation !== undefined) {
        try { await this.#control.request("assistance-bootstrap-release", {
          session: prepared.session, generation: prepared.generation, reservation,
        }); } catch (cleanup) {
          this.#control.terminate(new VMError("GUEST_CRASH", "Bootstrap cleanup failed", { cause: serializeUnknownError(cleanup) }));
        }
      }
      throw error;
    }
  }

  async #loadBroker(prepared: AssistancePreparation, expected: AssistanceArtifacts, signal: AbortSignal): Promise<void> {
    const { credits, ...binding } = prepared;
    const artifacts = await loadAssistanceManifest(new URL(this.#options.manifestUrl), expected, signal);
    const connection = await openExecutionFrame(new URL(`${this.#options.executionOrigin}/`),
      (port, nonce) => ({ kind: "assistance-bootstrap", binding, nonce, artifacts, port, ...(credits === undefined ? {} : { credits }) }),
      (input, nonce) => {
        const result = decodeAssistanceBootstrapResult(input);
        if (result.nonce !== nonce || result.binding.session !== binding.session || result.binding.generation !== binding.generation) throw new VMError("PROTOCOL_ERROR", "Execution bootstrap binding mismatch");
        if (result.kind === "bootstrap-failed") throw deserializeError(result.error);
        return result.receipt;
      }, signal);
    this.#frame = connection.frame;
    try {
      const { receipt, port } = connection;
      await this.#control.request("assistance-attach", { ...binding, artifacts, port, ...(receipt === undefined ? {} : { receipt }) }, { signal, transfer: [port] });
      this.#watchControl(binding);
    } catch (error) {
      connection.dispose();
      this.#frame = undefined;
      throw error;
    }
  }
}

function abortable<Result>(pending: Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return Promise.reject(new VMError("ABORTED", "Assisted startup was aborted"));
  return new Promise<Result>((resolve, reject) => {
    const abort = () => reject(new VMError("ABORTED", "Assisted startup was aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, (error: unknown) => {
      signal.removeEventListener("abort", abort); reject(deserializeError(serializeUnknownError(error)));
    });
  });
}
import { openExecutionFrame } from "./execution-frame.js";

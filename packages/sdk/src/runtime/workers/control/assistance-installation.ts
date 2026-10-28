import { decodeBlockedBuilds } from "../../protocol/build-script-approval.js";
import { INSTALLATION_DATA_GRANT_BYTES } from "../../protocol/assistance-installation.js";
import { type WorkspacePublicationResult } from "../../protocol/workspace-publication.js";
import type { SnapshotStorageClient } from "../snapshot-channel.js";
import type { WorkspaceStreamInput } from "../workspace-stream.js";
import type { AssistanceCredit } from "../../protocol/assistance-credit.js";
import type { AssistanceTraffic } from "./assistance-traffic.js";
import type { GuestAgent } from "./guest-agent.js";
import { VMError, deserializeError } from "../../errors.js";
import type { DependencyInstallHandle } from "../../vm-types.js";
import type { RegistryBinding } from "../../protocol/registry.js";
import type { RegistryGatewayPolicy } from "../../protocol/system-network.js";
import type { SystemRegistryEndpoint } from "../system-registry-endpoint.js";
import { installationStreams } from "./installation-stream.js";
import { InstallationProfileRecorder } from "./installation-profile.js";
import { activateInstallationPublication, type InstallationActivation } from "./installation-publication.js";
import { publishWorkspaceCaptures } from "../workspace-publication-client.js";
import { digestBytes } from "./workspace-restore.js";
import { InstallationProcess } from "./installation-process.js";
import type { SystemNetworkClient } from "../system-network-channel.js";

/** One preparation lease, including the interval after pnpm/registry exit.
 * Only explicit completion releases admission; abort merely stops producers. */
export class SystemInstallation {
  readonly identity: RegistryBinding;
  /** Bounded attribution only; it never gates the installation. */
  readonly profile: InstallationProfileRecorder;
  readonly #cancellation = new AbortController();
  readonly signal = this.#cancellation.signal;
  readonly #detach: () => void;
  readonly #retired: () => void;
  readonly #failed: (error: unknown) => void;
  readonly #credits: AssistanceCredit[] = [];
  #returnCredits: ((final: boolean) => Promise<void>) | undefined;
  #registry: SystemRegistryEndpoint | undefined;
  #stream: ReturnType<typeof installationStreams> | undefined;
  #opening: Promise<void> | undefined;
  #completion: Promise<void> | undefined;
  #retirement: Promise<void> | undefined;
  #process: InstallationProcess | undefined;
  readonly #captures = new Map<"dependencies" | "snapshot" | "delta", Promise<WorkspaceStreamInput>>();
  #captureGrants: Promise<void> | undefined;
  #publication: Promise<WorkspacePublicationResult> | undefined;
  #publicationFailure: VMError | undefined;
  #validateInputs = false;
  #preparationStarted = false;
  #inputsSha256: string | undefined;
  #agent: Pick<GuestAgent, "setInstallationEvents" | "creditAssistance"> | undefined;
  #traffic: AssistanceTraffic | undefined;

  constructor(identity: RegistryBinding, signal: AbortSignal | undefined, retired: () => void, failed: (error: unknown) => void) {
    this.identity = identity; this.#retired = retired; this.#failed = failed;
    this.profile = new InstallationProfileRecorder(identity.installation);
    const abort = () => this.#cancellation.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.#detach = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted === true) abort();
  }

  get inputsSha256(): string {
    if (this.#inputsSha256 === undefined) throw new VMError("PROTOCOL_ERROR", "Installation inputs have not been validated");
    return this.#inputsSha256;
  }

  get registry(): SystemRegistryEndpoint {
    if (this.#registry === undefined) throw new VMError("PROTOCOL_ERROR", "Installation registry is not ready");
    return this.#registry;
  }

  connect(network: Promise<SystemNetworkClient>, policy: RegistryGatewayPolicy,
    agent: Pick<GuestAgent, "creditAssistance" | "startInstallation" | "installation" | "setInstallationEvents" | "assistanceVersion">, traffic: AssistanceTraffic,
    options: { readonly cwd: string; readonly frozenLockfile: boolean }): Promise<void> {
    if (this.#opening !== undefined || this.#completion !== undefined || this.#retirement !== undefined) return Promise.reject(new VMError("PROTOCOL_ERROR", "Installation connection already consumed"));
    this.#agent = agent; this.#traffic = traffic; this.#validateInputs = agent.assistanceVersion === 7;
    this.#returnCredits = async final => {
      for (;;) {
        const index = this.#credits.findIndex(credit => final || credit.producer !== "installation" || credit.pool !== "control");
        const credit = this.#credits[index];
        if (credit === undefined) break;
        const returned = await agent.creditAssistance(0, { ...credit, kind: "return" });
        traffic.returnCredit(returned);
        this.#credits.splice(index, 1);
      }
    };
    this.#opening = (async () => {
      this.profile.begin("connect");
      const client = await network;
      this.profile.begin("connect:credits");
      // These windows share the VM allowance with registry framing and SDK I/O.
      // The process window includes the native relay and its delegated service.
      for (const [producer, dataBytes, controlBytes, dataEntries, controlEntries] of [
        ["installation", INSTALLATION_DATA_GRANT_BYTES, 64 * 1024, 128, 32],
        ["installation-gateway", 4 * 1024 * 1024, 256 * 1024, 256, 128],
        ["installation-process", 2 * 1024 * 1024 + 384 * 1024, 128 * 1024, 64, 64],
      ] as const) {
        for (const pool of ["data", "control"] as const) {
          if (this.signal.aborted) throw new VMError("ABORTED", "Dependency installation cancelled");
          const credit = traffic.grant({ session: this.identity.session, generation: this.identity.generation,
            process: null, producer, pool,
            bytes: pool === "data" ? dataBytes : controlBytes,
            entries: pool === "data" ? dataEntries : controlEntries });
          // A lost reply cannot prove that the guest never received the grant.
          this.#credits.push(credit);
          await agent.creditAssistance(0, credit);
        }
      }
      this.profile.end("connect:credits");
      this.profile.begin("connect:registry");
      this.#registry = await client.startRegistryGateway(this.identity.installation, policy, async credits => {
        this.profile.end("connect:registry");
        if (this.signal.aborted) throw new VMError("ABORTED", "Dependency installation cancelled");
        this.profile.begin("connect:streams");
        this.#stream = installationStreams(agent, this.identity, 1, traffic, { beforeClose: () => this.#process?.terminate(),
          observe: observation => this.profile.exchange(observation) });
        this.profile.end("connect:streams");
        this.profile.begin("connect:start");
        const reply = await agent.startInstallation(0, {
          request: { ...this.identity, sequence: 1, operation: { kind: "start", ...options } },
          credits: [...this.#credits.filter(credit => credit.producer === "installation-gateway"), ...credits],
          registry: `${policy.origin}/`,
        });
        this.profile.end("connect:start");
        if (reply.result.kind !== "ready") throw new VMError("RELAY_ERROR", "Guest installation gateway did not start", {
          ...(reply.result.kind === "error" ? { errno: reply.result.errno } : {}),
        });
        return reply.result.port;
      }, this.signal);
      if (this.signal.aborted) throw new VMError("ABORTED", "Dependency installation cancelled");
      if (this.#stream === undefined) throw new VMError("PROTOCOL_ERROR", "Missing guest installation streams");
      this.#registry.forward(this.#stream.input, this.#stream.output, this.profile);
      this.profile.end("connect");
    })();
    return this.#opening;
  }

  async startProcess(): Promise<InstallationProcess> {
    await this.#opening;
    if (this.signal.aborted || this.#completion !== undefined || this.#retirement !== undefined) throw new VMError("ABORTED", "Dependency installation cancelled");
    if (this.#process !== undefined || this.#registry === undefined || this.#stream === undefined || this.#agent === undefined || this.#traffic === undefined) {
      throw new VMError("PROTOCOL_ERROR", "Installer connection unavailable or already consumed");
    }
    const process = new InstallationProcess(this.identity, this.#stream.process, this.#traffic, () => this.finish(), error => {
      if (!this.signal.aborted) this.#failed(error);
      void this.finish().catch(() => {});
    });
    try {
      this.#agent.setInstallationEvents(this.identity, event => {
        try { process.receive(event); }
        catch { /* The process already notified the lifecycle owner. */ }
      });
    } catch (error) { process.retire(); throw error; }
    this.#process = process;
    this.profile.begin("spawn");
    await process.start();
    this.profile.end("spawn");
    this.profile.begin("install");
    return process;
  }

  /** The process result is independent of publication. Generation resolves only
   * after native activation, durable commitment and complete lease retirement. */
  async prepare(storage: SnapshotStorageClient, workspaceBaseSha256: string,
    activation: InstallationActivation): Promise<DependencyInstallHandle> {
    if (!this.#validateInputs) throw new VMError("FEATURE_NOT_AVAILABLE", "Dependency preparation requires guest v7 input validation");
    if (!/^[a-f0-9]{64}$/u.test(workspaceBaseSha256) || !Number.isSafeInteger(activation.requestId) || activation.requestId < 1) {
      throw new VMError("PROTOCOL_ERROR", "Invalid dependency preparation identity");
    }
    if (this.#preparationStarted || this.#process !== undefined) throw new VMError("PROTOCOL_ERROR", "Dependency preparation already started");
    this.#preparationStarted = true;
    let process: InstallationProcess;
    try {
      const decisions = await storage.readBuildPolicy(workspaceBaseSha256, this.signal);
      if (this.signal.aborted) throw new VMError("ABORTED", "Dependency preparation cancelled");
      if (this.#stream === undefined) throw new VMError("PROTOCOL_ERROR", "Installation transport unavailable");
      this.profile.begin("policy");
      const reply = await this.#stream.process({ kind: "set-build-policy", bytes: new TextEncoder().encode(JSON.stringify(decisions)) });
      this.profile.end("policy");
      if (reply.result.kind !== "unit") throw new VMError("STORAGE_ERROR", "Guest build policy was not activated");
      // The activated generation already matching these inputs and this
      // policy is the prepare's result: no installer, capture or publication.
      this.profile.begin("check-current");
      const current = await this.#stream.process({ kind: "check-current" });
      this.profile.end("check-current");
      if (current.result.kind === "data") {
        if (current.result.bytes.length !== 64) throw new VMError("PROTOCOL_ERROR", "Invalid current dependency generation identity");
        const generation = Array.from(current.result.bytes.subarray(0, 32), byte => byte.toString(16).padStart(2, "0")).join("");
        await this.finish();
        return completedPreparation(generation);
      }
      process = await this.startProcess();
    }
    catch (error) { await this.finish(); throw error; }
    const generation = (async () => {
      try {
        await this.materialize();
        const result = await this.publish(storage, { workspaceBaseSha256, inputsSha256: this.inputsSha256 }, activation);
        if (result.outcome.kind === "failed") throw deserializeError(result.outcome.error);
        if (!result.retired || result.outcome.dependencyGeneration === undefined) throw new VMError("PROTOCOL_ERROR", "Dependency publication has not retired");
        return result.outcome.dependencyGeneration;
      } finally { await this.finish(); }
    })();
    void generation.catch(() => {});
    return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
      exit: process.exit, kill: signal => process.kill(signal), generation };
  }

  /** Stop producers and return data grants, retaining supervision and the pinned
   * candidate lease for publication. Abort remains live until finish(). */
  retireWriters(): Promise<void> { return this.#retireWriters(false); }

  async materialize(): Promise<void> {
    if (this.#process === undefined) throw new VMError("PROTOCOL_ERROR", "Dependency materialization requires an installer");
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(new VMError("ABORTED", "Dependency installation cancelled"));
    this.signal.addEventListener("abort", abort, { once: true });
    if (this.signal.aborted) abort();
    try {
      const exit = await Promise.race([this.#process.exit, aborted.promise]);
      await Promise.race([this.#process.outputDrained, aborted.promise]);
      this.profile.end("install");
      if (exit.code !== 0) {
        if (exit.code === null || !this.#validateInputs || this.#stream === undefined || this.signal.aborted) {
          throw new VMError("STORAGE_ERROR", "Dependency installation did not succeed", { exitCode: exit.code, signal: exit.signal });
        }
        this.profile.begin("blocked-builds");
        const report = await Promise.race([this.#stream.process({ kind: "blocked-builds" }), aborted.promise]);
        this.profile.end("blocked-builds");
        if (report.result.kind !== "data") throw new VMError("STORAGE_ERROR", "Installer failed and its blocked-build report is unavailable", {
          exitCode: exit.code, ...(report.result.kind === "error" ? { errno: report.result.errno } : {}),
        });
        const blockedBuilds = decodeBlockedBuilds(report.result.bytes);
        throw new VMError("STORAGE_ERROR", blockedBuilds.length === 0 ? "Dependency installation did not succeed"
          : "Dependency build scripts require approval and an explicit installation retry", { exitCode: exit.code, blockedBuilds });
      }
    } finally { this.signal.removeEventListener("abort", abort); }
    if (this.#validateInputs && this.#inputsSha256 === undefined) {
      if (this.#stream === undefined) throw new VMError("PROTOCOL_ERROR", "Installation transport unavailable");
      const cancelled = () => this.signal.aborted;
      const abortValidation = () => { void this.finish().catch(() => {}); };
      this.signal.addEventListener("abort", abortValidation, { once: true });
      let validated;
      this.profile.begin("validate-inputs");
      try {
        if (cancelled()) throw new VMError("ABORTED", "Input validation cancelled");
        validated = await this.#stream.process({ kind: "validate-inputs" });
      } finally { this.signal.removeEventListener("abort", abortValidation); this.profile.end("validate-inputs"); }
      if (cancelled()) throw new VMError("ABORTED", "Input validation cancelled");
      if (validated.result.kind !== "data" || validated.result.bytes.length !== 64) throw new VMError("STORAGE_ERROR", "Installation inputs changed or could not be validated",
        validated.result.kind === "error" ? { errno: validated.result.errno } : undefined);
      this.#inputsSha256 = Array.from(validated.result.bytes.subarray(0, 32), byte => byte.toString(16).padStart(2, "0")).join("");
    }
    this.profile.begin("retire-writers");
    await this.retireWriters();
    this.profile.end("retire-writers");
    if (this.signal.aborted) throw new VMError("ABORTED", "Dependency installation cancelled");
    if (this.#stream === undefined) throw new VMError("PROTOCOL_ERROR", "Installation transport unavailable");
    this.profile.begin("materialize");
    await this.#stream.materialize();
    this.profile.end("materialize");
  }

  capture(source: "dependencies" | "snapshot" | "delta" = "dependencies"): Promise<WorkspaceStreamInput> {
    const existing = this.#captures.get(source);
    if (existing !== undefined) return existing;
    this.#captureGrants ??= (async () => {
      await this.materialize();
      if (this.#stream === undefined || this.#agent === undefined || this.#traffic === undefined || this.#completion !== undefined || this.signal.aborted) {
        throw new VMError("ABORTED", "Dependency capture unavailable or cancelled");
      }
      const cancelled = () => this.signal.aborted;
      for (const pool of ["data", "control"] as const) {
        if (cancelled()) throw new VMError("ABORTED", "Dependency capture cancelled");
        const credit = this.#traffic.grant({ session: this.identity.session, generation: this.identity.generation,
          process: null, producer: "storage", pool, bytes: pool === "data" ? 3 * 1024 * 1024 : 3 * 16 * 1024, entries: 6 });
        this.#credits.push(credit);
        await this.#agent.creditAssistance(0, credit);
      }
    })();
    const capture = this.#captureGrants.then(() => {
      if (this.#stream === undefined || this.signal.aborted || this.#completion !== undefined) {
        throw new VMError("ABORTED", "Capture unavailable or cancelled");
      }
      return this.#stream.capture(source);
    });
    this.#captures.set(source, capture);
    void capture.catch(() => {});
    return capture;
  }

  /** Linux moves its verified materialized copy into the committed generation
   * under storage's identity; the captured bytes never travel back. */
  async #activate(identity: { readonly generation: string; readonly inputsSha256: string }): Promise<void> {
    if (this.#stream === undefined) throw new VMError("PROTOCOL_ERROR", "Installation transport unavailable");
    this.profile.begin("activate");
    try {
      await this.#stream.activate({ generation: digestBytes(identity.generation), inputs: digestBytes(identity.inputsSha256) });
    } finally { this.profile.end("activate"); }
  }

  /** The preparation owner must verify guest input identity before calling.
   * Stream-capable preparation supplies activation to precede durable commit. */
  publish(storage: SnapshotStorageClient, metadata: { readonly workspaceBaseSha256: string; readonly inputsSha256: string },
    activation?: InstallationActivation): Promise<WorkspacePublicationResult> {
    if (this.#publication !== undefined) return Promise.reject(new VMError("PROTOCOL_ERROR", "Installation publication already consumed"));
    const { workspaceBaseSha256, inputsSha256 } = metadata;
    if (!/^[a-f0-9]{64}$/u.test(workspaceBaseSha256) || !/^[a-f0-9]{64}$/u.test(inputsSha256)) {
      return Promise.reject(new VMError("PROTOCOL_ERROR", "Invalid installation publication identity"));
    }
    this.#publication = (async () => {
      this.profile.begin("capture");
      const inputs = await Promise.all([this.capture("snapshot"), this.capture("delta"), this.capture()]);
      this.profile.end("capture");
      if (this.#validateInputs && this.#inputsSha256 !== inputsSha256) throw new VMError("PROTOCOL_ERROR", "Publication does not match validated installation inputs");
      const traffic = this.#traffic;
      if (traffic === undefined || this.signal.aborted) throw new VMError("ABORTED", "Installation publication cancelled");
      const binding = { session: this.identity.session, generation: this.identity.generation };
      const [snapshot, delta, tree] = inputs;
      this.profile.begin("publish");
      try {
        return await publishWorkspaceCaptures((publication, signal) => activation === undefined
          ? storage.publishWorkspace(publication, signal)
          : activateInstallationPublication(storage, publication, { ...activation, activate: identity => this.#activate(identity) }, signal),
          { binding, workspaceBaseSha256, snapshot, delta, dependencies: { inputsSha256, tree } }, traffic, this.signal);
      } catch (error) {
        if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) {
          this.#publicationFailure = new VMError("STORAGE_ERROR", "Dependency publication requires recovery", error.detail);
          this.#failed(this.#publicationFailure);
        }
        throw error;
      } finally { this.profile.end("publish"); }
    })();
    void this.#publication.catch(() => {});
    return this.#publication;
  }

  #retireWriters(final: boolean): Promise<void> {
    this.#retirement ??= (async () => {
      try {
        let startupFailed = false;
        let startupFailure: unknown;
        try { await this.#opening; }
        catch (error) { startupFailed = true; startupFailure = error; }
        const retired = await Promise.allSettled([final ? this.#stream?.close() : this.#stream?.retire(), this.#registry?.close()]);
        // The installer's exit and streams settle whether or not the guest
        // could retire its writers: a dead guest must not leave them pending.
        if (this.#process !== undefined) {
          this.#agent?.setInstallationEvents(undefined);
          this.#process.retire();
        }
        for (const result of retired) if (result.status === "rejected") throw result.reason;
        await this.#returnCredits?.(final);
        if (startupFailed && (!(startupFailure instanceof VMError) || startupFailure.code !== "ABORTED")) throw startupFailure;
      } catch (error) { this.#failed(error); throw error; }
    })();
    return this.#retirement;
  }

  finish(): Promise<void> {
    this.#cancellation.abort();
    this.#completion ??= (async () => {
      this.profile.begin("finish");
      try {
        await this.#retireWriters(true);
        await this.#stream?.release();
        await Promise.allSettled(this.#captures.values());
        await this.#publication?.catch(() => {});
        if (this.#publicationFailure !== undefined) throw this.#publicationFailure;
        await this.#returnCredits?.(true);
        this.profile.end("finish");
        this.#retired();
      } catch (error) { this.#failed(error); throw error; }
      finally { this.profile.end("finish"); this.#detach(); }
    })();
    return this.#completion;
  }
}

/** The handle of a prepare the activated generation already satisfied: an
 * installer that never ran, exited clean, with nothing to read or write. */
function completedPreparation(generation: string): DependencyInstallHandle {
  const stdin = new WritableStream<Uint8Array>({ write() { throw new VMError("INVALID_ARGUMENT", "No installer accepts input for a current generation"); } });
  const empty = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  return { stdin, stdout: empty(), stderr: empty(), exit: Promise.resolve({ code: 0 }), kill: () => Promise.resolve(),
    generation: Promise.resolve(generation) };
}

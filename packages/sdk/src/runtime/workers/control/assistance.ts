import { validateInstallationRequest } from "../../protocol/assistance-installation.js";
import { AgentKind } from "../../agent-protocol.js";
import type { AssistanceCredit } from "../../protocol/assistance-credit.js";
import { AssistanceTraffic } from "./assistance-traffic.js";
import { record } from "../../decode.js";
import { requireAssistanceAdmission } from "../../assistance-admission.js";
import { ASSISTANCE_ARTIFACTS } from "../../assistance-build.js";
import { matchAssistanceArtifacts } from "../../assistance-artifacts.js";
import { deserializeError, serializeUnknownError, VMError } from "../../errors.js";
import { decodeGuestProcessPortAck, PROTOCOL_VERSION, type AgentSpawnResult } from "../../protocol.js";
import { ASSISTANCE_LIMITS, isAssistanceSocketOperation, isAssistanceSupervisoryOperation, type AssistanceIdentity, type AssistanceOperation, type AssistanceSocketOperation } from "../../protocol/assistance.js";
import { PreviewRuntimeServicer, type PreviewSockets } from "./preview-runtime.js";
import { BROKER_REPLY_VERSION, decodeBrokerEvent, decodeBrokerShutdown, decodeBrokerRetired, decodeBrokerFailure, decodeBrokerHeartbeat, type AssistedDependencyIdentity } from "../../protocol/assistance-broker.js";
import { assistanceReplyCapacity, encodeAssistanceReply, type AssistanceReply } from "../../protocol/assistance-reply.js";
import type { AssistanceControlOperations, AssistancePreparation, AssistanceSpawnInput } from "../../protocol/assistance-control.js";
import { encodeAssistanceEvent, type AssistanceEvent } from "../../protocol/assistance-event.js";
import type { GuestAgent } from "./guest-agent.js";
import { SystemNetworkClient } from "../system-network-channel.js";
import { decodeRegistryFetchPolicy, type RegistryFetchPolicy } from "../../protocol/system-network.js";
import { installationGatewayPolicy } from "./installation-gateway-policy.js";
import { brokerDataCredit } from "../assistance/traffic.js";
import { SystemInstallation } from "./assistance-installation.js";
import type { InstallationProfile } from "../../protocol/assistance-installation-profile.js";
import { restoreStoredWorkspace } from "./workspace-restore.js";
import { synchronizeWorkspace } from "./workspace-sync.js";
import type { SnapshotStorageClient } from "../snapshot-channel.js";
import type { DependencyInstallHandle } from "../../vm-types.js";
import type { InstallationActivation } from "./installation-publication.js";
import { ForkSupervision } from "./assistance-fork.js";
import { RETIREMENT_STEP_MS, boundedRetirementStep, type RetirementStep, type Task, type TaskOutcome } from "./assistance-task.js";

/** Fork capability is advertised by guest 7 after its boot probe; an agent
 * without the flag simply has no forks. */
type Agent = Pick<GuestAgent, "supportsAssistance" | "assistance" | "setAssistanceEvents" | "setInstallationEvents" | "checkAssistanceHealth" | "assistanceVersion" | "superviseAssistance" | "creditAssistance" | "startInstallation" | "installation">
  & Partial<Pick<GuestAgent, "supportsFork" | "readFile">>;

/** A counted notice channel for the broker (`system-attention.ts`): the port the broker sends one
 * notice to before each message, and the hooks that count delivered messages and retire the channel. */
export interface BrokerAttention {
  readonly port: MessagePort;
  delivered(): void;
  close(): void;
}

/** The active system VM has one lifecycle/traffic owner. Neither the SDK
 * document nor an application worker may mint Linux task authority. */
export class SystemAssistance implements PreviewSockets {
  readonly #agent: Agent;
  readonly #session = crypto.randomUUID();
  #generation = 1;
  readonly #tasks = new Map<number, Task>();
  #broker: MessagePort | undefined;
  #brokerAttention: BrokerAttention | undefined;
  readonly #attention: { open(): BrokerAttention | undefined } | undefined;
  #brokerShutdown: PromiseWithResolvers<undefined> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #heartbeatSequence = 0;
  #heartbeatDeadline: number | undefined;
  #guestHeartbeatPending = false;
  #guestBinding: Promise<void> | undefined;
  #guestBound = false;
  #startingBindings = 0;
  readonly #bootstrapCredits: AssistanceCredit[] = [];
  #guestFence: Promise<void> | undefined;
  #vmSequence = 0;
  #replacing = false;
  #nextProcess = 1;
  readonly #traffic = new AssistanceTraffic(6);
  #retiredEvents = 0;
  #helperExits = 0;
  #failure: VMError | undefined;
  #disposal: Promise<void> | undefined;
  #networkPort: MessagePort | undefined;
  #network: SystemNetworkClient | undefined;
  #preview: PreviewRuntimeServicer | undefined;
  #installation: SystemInstallation | undefined;
  #lastInstallationProfile: InstallationProfile | undefined;
  #nextInstallation = 1;
  #preparation: { readonly requestId: number; readonly cancellation: AbortController } | undefined;
  #policyCommit: { requestId: number; cancellation: AbortController; work: Promise<void> } | undefined;
  #workspaceTransfer: { requestId: number; cancellation: AbortController; work: Promise<boolean> } | undefined;
  readonly #forks: ForkSupervision;

  readonly #retirementStepMs: number;

  constructor(agent: Agent, options: { readonly retirementStepMs?: number; readonly attention?: { open(): BrokerAttention | undefined } } = {}) {
    this.#retirementStepMs = options.retirementStepMs ?? RETIREMENT_STEP_MS;
    this.#attention = options.attention;
    this.#agent = agent;
    this.#forks = new ForkSupervision({
      supportsFork: () => this.#agent.supportsFork === true && this.#agent.assistanceVersion === 7,
      hasCapacity: () => this.#tasks.size < ASSISTANCE_LIMITS.processes && this.#nextProcess <= 0xffff_ffff,
      createTask: (parent, silent) => {
        const task = this.#createTask(parent.requestId, this.#nextProcess++, undefined, parent, silent);
        task.dependencies = parent.dependencies;
        parent.children.add(task);
        return task;
      },
      admit: task => this.#admit(task),
      call: (task, operation) => this.#call(task, operation),
      post: (command, transfer) => {
        if (this.#broker === undefined) throw new VMError("PROTOCOL_ERROR", "Assistance broker is not attached");
        this.#broker.postMessage(command, transfer === undefined ? [] : [...transfer]);
      },
      reply: reply => this.#reply(reply),
      retire: (task, outcome) => this.#retire(task, outcome),
      input: (process, bytes) => this.input(process, bytes),
      nextCommand: task => this.#identity(task, ++task.commandSequence),
      reserve: (task, bytes) => this.#traffic.reserve(task.process, "data", bytes),
      release: (task, reservation) => { this.#traffic.release(task.process, reservation); },
      running: task => this.#running(task),
      requireStarting: task => { this.#requireStarting(task); },
    });
  }

  #createTask(requestId: number, process: number, port: MessagePort | undefined, parent: Task | undefined, silent: boolean): Task {
    const task: Task = { requestId, process, port, parent, silent, children: new Set(), helpers: new Set(), forkOutput: new Map(), forkChunk: 0, dependencies: undefined,
      ready: Promise.withResolvers<undefined>(), guestCredits: [], brokerCredits: [], dispatch: new AbortController(), brokerRetired: undefined, brokerStarted: false, networkAdmission: undefined,
      phase: "starting", guestSequence: 0, guestEventSequence: 0, terminalSequence: undefined, commandSequence: 0, brokerSequence: 0,
      outputSequence: 0, input: undefined, inputClosed: false, output: [], childOutput: new Map(), outputBytes: 0, drain: undefined, retirement: undefined };
    void task.ready.promise.catch(() => {});
    this.#tasks.set(process, task);
    return task;
  }

  attachNetwork(port: MessagePort): void {
    try {
      requireAssistanceAdmission();
      this.assertIdle();
      if (this.#networkPort !== undefined || this.#disposal !== undefined) throw new VMError("PROTOCOL_ERROR", "System network is already attached or retired");
      this.#networkPort = port;
    } catch (error) { port.close(); throw error; }
  }

  networkFailed(): void {
    requireAssistanceAdmission();
    const failure = new VMError("RELAY_ERROR", "System network worker failed; reopen the VM");
    if (this.#network === undefined) this.#fail(failure);
    else this.#network.fail(failure);
  }

  async #closeNetwork(): Promise<void> {
    this.#preview?.close();
    this.#preview = undefined;
    await this.#network?.close();
    this.#network = undefined;
  }

  /** One guest socket operation inside a running assisted task, for the preview
   * bridge: browser connections are made by the listener's own task so guest
   * and browser clients traverse the same Linux accept queue. */
  async previewSocket(process: number, operation: AssistanceSocketOperation): Promise<AssistanceReply["result"] | undefined> {
    const task = this.#tasks.get(process);
    if (task === undefined || !this.#running(task) || task.networkAdmission === undefined) return undefined;
    return (await this.#call(task, operation)).result;
  }

  prepare(): { readonly session: string; readonly generation: number } {
    requireAssistanceAdmission();
    if (this.#replacing) throw new VMError("ABORTED", "Assistance generation is changing");
    if (this.#disposal !== undefined) throw new VMError("ABORTED", "Assistance is disposing");
    if (this.#failure !== undefined) throw this.#failure;
    if (!this.#agent.supportsAssistance) throw new VMError("FEATURE_NOT_AVAILABLE", "Guest assistance capability is unavailable; guest protocol v6 or later and a successful native admission probe are required");
    this.#agent.setAssistanceEvents(event => {
      try { this.#receiveGuest(event); } catch (error) { this.#fail(error); }
    });
    return { session: this.#session, generation: this.#generation };
  }

  async prepareBound(): Promise<AssistancePreparation> {
    this.#requireNoInstallation();
    this.#startingBindings += 1;
    try { return await this.#prepareBound(); }
    finally { this.#startingBindings -= 1; }
  }

  async #bindGuest(): Promise<{ readonly session: string; readonly generation: number }> {
    const binding = this.prepare();
    if ((this.#agent.assistanceVersion !== 6 && this.#agent.assistanceVersion !== 7)) return binding;
    this.#guestBinding ??= this.#agent.superviseAssistance(0, { ...binding, sequence: ++this.#vmSequence, operation: "bind" }).then(() => {
      this.#guestBound = true;
      this.#guestFence = undefined;
      if (this.#disposal === undefined) this.#startHeartbeat();
    }, (error: unknown) => {
      this.#failure ??= deserializeError(serializeUnknownError(error));
      throw this.#failure;
    });
    await this.#guestBinding;
    this.prepare();
    if (this.#networkPort !== undefined) {
      if (this.#network === undefined) {
        this.#network = new SystemNetworkClient(this.#networkPort, binding, this.#traffic, error => this.#fail(error));
        this.#preview?.close();
        this.#preview = new PreviewRuntimeServicer(this.#network.previewPort, this, BigInt(this.#generation));
      }
      await this.#network.ready;
      this.prepare();
    }
    return binding;
  }

  async #prepareBound(): Promise<AssistancePreparation> {
    const binding = await this.#bindGuest();
    if ((this.#agent.assistanceVersion !== 6 && this.#agent.assistanceVersion !== 7)) return binding;
    if (this.#broker !== undefined) return binding;
    if (this.#bootstrapCredits.length === 0) {
      if (ASSISTANCE_ARTIFACTS === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Missing bootstrap artifact identity");
      try {
        for (const [index, bytes] of [ASSISTANCE_ARTIFACTS.runtime.bytes, 2 * ASSISTANCE_ARTIFACTS.runtime.bytes + 4096].entries()) {
          this.#bootstrapCredits.push(this.#traffic.grant({ ...binding, producer: "bootstrap", process: null,
            pool: "data", bytes, entries: index === 0 ? 1 : 32 }));
        }
      } catch (error) {
        this.#traffic.retireGrants(binding, null, "bootstrap"); this.#bootstrapCredits.length = 0; throw error;
      }
    }
    return { ...binding, credits: this.#bootstrapCredits.slice() };
  }

  async beginInstallation(policy: RegistryFetchPolicy, signal?: AbortSignal,
    options: { readonly cwd: string; readonly frozenLockfile: boolean } = { cwd: "/workspace", frozenLockfile: true }): Promise<SystemInstallation> {
    const cancelled = () => signal?.aborted === true;
    if (cancelled()) throw new VMError("ABORTED", "Dependency installation cancelled");
    let binding = this.prepare();
    const admittedPolicy = decodeRegistryFetchPolicy(policy);
    validateInstallationRequest({ ...binding, installation: this.#nextInstallation, sequence: 1,
      operation: { kind: "start", ...options } });
    this.assertIdle();
    if ((this.#agent.assistanceVersion !== 6 && this.#agent.assistanceVersion !== 7) || this.#networkPort === undefined) {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Installation requires guest v6 and supervised system networking");
    }
    // The idle broker still owns its runtime bytes. Retire its generation before
    // lending the same VM budget to pnpm; SDK binding checks then rebootstrap.
    if (this.#broker !== undefined) {
      await this.replaceGeneration();
      binding = this.prepare();
      this.assertIdle();
      if (cancelled()) throw new VMError("ABORTED", "Dependency installation cancelled");
    }
    if (this.#nextInstallation > 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Installation identities exhausted");
    const reservation = this.#traffic.reserve(null, "control", 512);
    const installation = new SystemInstallation({ ...binding, installation: this.#nextInstallation++ }, signal,
      () => {
        this.#traffic.release(null, reservation);
        this.#lastInstallationProfile = installation.profile.snapshot();
        if (this.#installation === installation) this.#installation = undefined;
      }, error => this.#fail(error));
    this.#installation = installation;
    const network = this.#bindGuest().then(() => {
      if (this.#network === undefined) throw new VMError("RELAY_ERROR", "Installation network is unavailable");
      return this.#network;
    });
    // A frozen install's gateway prunes locked packages' metadata to what
    // pnpm's checks read; the lockfile names the versions (see the policy owner).
    const readFile = this.#agent.readFile;
    const gateway = await installationGatewayPolicy(admittedPolicy, options,
      readFile === undefined ? undefined : path => readFile.call(this.#agent, 0, path));
    installation.profile.gateway(gateway.lockfile);
    try { await installation.connect(network, gateway.policy, this.#agent, this.#traffic, options); return installation; }
    catch (error) { await installation.finish(); throw error; }
  }

  /** Attribution record of the active installation, else the last retired one. */
  installationProfile(): InstallationProfile | undefined {
    return this.#installation?.profile.snapshot() ?? this.#lastInstallationProfile;
  }

  async prepareDependencies(requestId: number, policy: RegistryFetchPolicy,
    publication: { readonly storage: SnapshotStorageClient; readonly workspaceBaseSha256: string; readonly agent: InstallationActivation["agent"] },
    options: { readonly cwd: string; readonly frozenLockfile: boolean } = { cwd: "/workspace", frozenLockfile: true }): Promise<DependencyInstallHandle> {
    this.assertIdle();
    if (this.#agent.assistanceVersion !== 7) throw new VMError("FEATURE_NOT_AVAILABLE", "Dependency preparation requires guest v7");
    if (!Number.isSafeInteger(requestId) || requestId < 1 || !/^[a-f0-9]{64}$/u.test(publication.workspaceBaseSha256)) {
      throw new VMError("PROTOCOL_ERROR", "Invalid dependency preparation identity");
    }
    if (this.#preparation !== undefined) throw new VMError("PROTOCOL_ERROR", "Dependency preparation is already active");
    const preparation = { requestId, cancellation: new AbortController() };
    this.#preparation = preparation;
    const release = () => { if (this.#preparation === preparation) this.#preparation = undefined; };
    let installation: SystemInstallation | undefined;
    try {
      installation = await this.beginInstallation(policy, preparation.cancellation.signal, options);
      const handle = await installation.prepare(publication.storage, publication.workspaceBaseSha256,
        { agent: publication.agent, requestId });
      void handle.generation.then(release, release);
      return handle;
    } catch (error) {
      try { await installation?.finish(); }
      finally { release(); }
      throw error;
    }
  }

  async commitBuildPolicy(requestId: number, storage: Pick<SnapshotStorageClient, "commitBuildPolicy">,
    request: AssistanceControlOperations["assistance-build-policy"]["request"]): Promise<void> {
    requireAssistanceAdmission();
    this.assertIdle();
    if (this.#disposal !== undefined || this.#replacing) throw new VMError("ABORTED", "Assistance is retiring");
    const cancellation = new AbortController();
    const work = Promise.resolve().then(() => storage.commitBuildPolicy(request.workspaceBaseSha256, request.decisions, cancellation.signal));
    const pending = { requestId, cancellation, work };
    this.#policyCommit = pending;
    try { await work; }
    catch (error) {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#fail(error);
      throw error;
    } finally { if (this.#policyCommit === pending) this.#policyCommit = undefined; }
  }

  #requireNoInstallation(): void {
    if (this.#policyCommit !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Wait for build approval persistence before changing VM state");
    if (this.#workspaceTransfer !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Wait for workspace transfer before starting assistance or changing VM state");
    if (this.#installation !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Finish dependency installation before starting assistance or changing VM state");
  }

  releaseBootstrap(request: AssistanceControlOperations["assistance-bootstrap-release"]["request"]): void {
    requireAssistanceAdmission();
    if (request.session !== this.#session || request.generation !== this.#generation
      || request.reservation !== this.#bootstrapCredits[0]?.reservation || this.#tasks.size !== 0) {
      throw new VMError("PROTOCOL_ERROR", "Invalid bootstrap retirement");
    }
    this.#broker?.close(); this.#broker = undefined; this.#brokerAttention?.close(); this.#brokerAttention = undefined;
    this.#heartbeatDeadline = undefined; this.#heartbeatSequence = 0;
    this.#traffic.retireGrants(request, null, "bootstrap"); this.#bootstrapCredits.length = 0;
  }

  attach(request: AssistanceControlOperations["assistance-attach"]["request"]): void {
    const { port } = request;
    try {
      this.#requireNoInstallation();
      const binding = this.prepare();
      if ((this.#agent.assistanceVersion === 6 || this.#agent.assistanceVersion === 7) && !this.#guestBound) throw new VMError("PROTOCOL_ERROR", "Guest assistance is not bound");
      if (ASSISTANCE_ARTIFACTS === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Control build has no admitted assistance artifacts");
      matchAssistanceArtifacts(request.artifacts, ASSISTANCE_ARTIFACTS);
      if (binding.session !== request.session || binding.generation !== request.generation) {
        throw new VMError("PROTOCOL_ERROR", "Stale assistance broker attachment");
      }
      if (this.#broker !== undefined) throw new VMError("PROTOCOL_ERROR", "An assistance broker is already attached");
      if ((this.#agent.assistanceVersion === 6 || this.#agent.assistanceVersion === 7)) {
        const staging = this.#bootstrapCredits[1];
        if (staging === undefined || request.receipt?.reservation !== staging.reservation || request.receipt.producer !== "bootstrap") {
          throw new VMError("PROTOCOL_ERROR", "Missing bootstrap staging receipt");
        }
        this.#traffic.returnCredit(request.receipt);
      } else if (request.receipt !== undefined) throw new VMError("PROTOCOL_ERROR", "Unexpected bootstrap receipt");
    } catch (error) { port.close(); throw error; }
    this.#broker = port;
    this.#heartbeatSequence = 0;
    this.#brokerShutdown = undefined;
    // The broker sends one notice before each message, so the guest's slices end to receive them.
    const attention = this.#brokerAttention = this.#attention?.open();
    if (attention !== undefined) port.postMessage({ kind: "attention", binding: { session: this.#session, generation: this.#generation }, port: attention.port }, [attention.port]);
    port.onmessage = (message: MessageEvent<unknown>) => {
      attention?.delivered();
      if (this.#broker !== port) return;
      void this.#receive(message.data).catch((error: unknown) => this.#fail(error));
    };
    port.onmessageerror = () => { attention?.delivered(); this.#fail(new VMError("PROTOCOL_ERROR", "Assistance broker message failed")); };
    port.start();
    this.#startHeartbeat();
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) return;
    this.#heartbeatTimer = setInterval(() => {
      try {
        this.#checkGuest();
        const port = this.#broker;
        if (port === undefined) return;
        if (this.#heartbeatDeadline !== undefined) {
          if (performance.now() >= this.#heartbeatDeadline) throw new VMError("GUEST_CRASH", "Execution broker liveness deadline exceeded");
          return;
        }
        if (this.#heartbeatSequence === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Broker heartbeat sequence exhausted");
        this.#heartbeatDeadline = performance.now() + 60_000;
        port.postMessage({ kind: "ping", binding: { session: this.#session, generation: this.#generation }, sequence: ++this.#heartbeatSequence });
      } catch (error) { this.#fail(error); }
    }, 15_000);
  }

  get rejectedRetiredEvents(): number { return this.#retiredEvents; }
  /** Fork helper exits consumed by control instead of an application child table. */
  get consumedHelperExits(): number { return this.#helperExits; }

  restoreWorkspace(requestId: number, base: string, storage: SnapshotStorageClient, agent: GuestAgent): Promise<boolean> {
    this.assertIdle();
    if (this.#disposal !== undefined || this.#replacing) return Promise.reject(new VMError("ABORTED", "VM generation is changing"));
    const cancellation = new AbortController();
    const work = Promise.resolve().then(() => restoreStoredWorkspace(agent, storage, this.#traffic, {
      binding: { session: this.#session, generation: this.#generation }, base, requestId, signal: cancellation.signal,
    })).catch((error: unknown) => {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#fail(error);
      throw error;
    }).finally(() => { if (this.#workspaceTransfer?.work === work) this.#workspaceTransfer = undefined; });
    this.#workspaceTransfer = { requestId, cancellation, work };
    return work;
  }

  async synchronizeWorkspace(requestId: number, base: string, storage: SnapshotStorageClient, agent: GuestAgent): Promise<boolean> {
    // Live saves admit only idle assistance. A disposal flush also waits for
    // retirement, while Linux execution/storage remain live through publication.
    await this.#disposal;
    this.assertIdle();
    if (this.#replacing) throw new VMError("ABORTED", "VM generation is changing");
    const cancellation = new AbortController();
    const work = Promise.resolve().then(() => synchronizeWorkspace(agent, storage, this.#traffic, {
      binding: { session: this.#session, generation: this.#generation }, base, requestId, signal: cancellation.signal,
    })).catch((error: unknown) => {
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#fail(error);
      throw error;
    }).finally(() => { if (this.#workspaceTransfer?.work === work) this.#workspaceTransfer = undefined; });
    this.#workspaceTransfer = { requestId, cancellation, work };
    return work;
  }

  assertHealthy(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  assertWorkspaceWritable(): void {
    this.assertHealthy();
    if (this.#disposal !== undefined || this.#workspaceTransfer !== undefined) {
      throw new VMError("ABORTED", "Workspace is retiring or transferring");
    }
  }

  async quiesce(): Promise<void> {
    if (this.#disposal !== undefined) { await this.#disposal; return; }
    await this.replaceGeneration();
  }

  async replaceGeneration(): Promise<void> {
    if (this.#replacing) throw new VMError("ABORTED", "Assistance generation is changing");
    if (this.#disposal !== undefined) throw new VMError("ABORTED", "Assistance is disposing");
    this.assertIdle();
    if (this.#generation === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Assistance generation exhausted");
    this.#replacing = true;
    try {
      await this.#guestBinding;
      await this.#fenceGuest();
      this.#clearHeartbeat();
      await this.#closeBroker();
      await this.#closeNetwork();
      this.#generation += 1;
    } catch (error) {
      this.#failure ??= deserializeError(serializeUnknownError(error));
      throw this.#failure;
    } finally { this.#replacing = false; }
  }

  executionStopped(error?: unknown): void {
    this.#workspaceTransfer?.cancellation.abort();
    if (this.#tasks.size !== 0 || this.#guestBinding !== undefined) this.#fail(error ?? new VMError("GUEST_CRASH", "Guest execution stopped during assistance"));
  }

  assertIdle(): void {
    this.assertHealthy();
    this.#requireNoInstallation();
    if (this.#startingBindings !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Wait for assistance startup before changing VM state");
    if (this.#tasks.size !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Stop assisted tasks before changing VM state");
    if (this.#broker === undefined && this.#bootstrapCredits.length !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Stop assistance bootstrap before changing VM state");
  }

  async spawn(requestId: number, input: AssistanceSpawnInput, storage?: Pick<SnapshotStorageClient, "readBuildPolicy">): Promise<AgentSpawnResult> {
    try {
      this.#requireNoInstallation();
      this.prepare();
      if (this.#broker === undefined) throw new VMError("PROTOCOL_ERROR", "Assistance broker is not attached");
      if (this.#tasks.size >= ASSISTANCE_LIMITS.processes || this.#nextProcess > 0xffff_ffff) {
        throw new VMError("QUOTA_EXCEEDED", "Assisted process capacity exhausted");
      }
    } catch (error) { input.port.close(); throw error; }
    const process = this.#nextProcess++;
    const task = this.#createTask(requestId, process, input.port, undefined, false);
    input.port.onmessage = (event: MessageEvent<unknown>) => {
      try { this.#ackOutput(task, event.data); } catch (error) { this.#fail(error); }
    };
    input.port.onmessageerror = () => this.#fail(new VMError("PROTOCOL_ERROR", "Assisted output channel failed"));
    input.port.start();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#initialize(task, requestId, input, storage);
      deadline = setTimeout(() => task.ready.reject(new VMError("ABORTED", "Assisted startup deadline exceeded")), 60_000);
      await task.ready.promise;
      return { pid: process, sessionId: process };
    } catch (error) {
      await this.#retire(task, { error });
      throw error;
    } finally { if (deadline !== undefined) clearTimeout(deadline); }
  }

  /** Network, broker and guest admission shared by spawned and forked tasks. */
  async #admit(task: Task): Promise<void> {
    if (this.#agent.assistanceVersion === 7 && this.#network !== undefined) {
      task.networkAdmission = this.#network.updateListener({ kind: "task-open", process: task.process });
      await task.networkAdmission;
      this.#requireStarting(task);
    }
    if ((this.#agent.assistanceVersion === 6 || this.#agent.assistanceVersion === 7)) {
      if (this.#broker === undefined) throw new VMError("PROTOCOL_ERROR", "Assistance broker is not attached");
      if (ASSISTANCE_ARTIFACTS === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Missing process runtime artifact identity");
      for (const pool of ["data", "control"] as const) task.brokerCredits.push(this.#traffic.grant({
        session: this.#session, generation: this.#generation, process: task.process, producer: "broker", pool,
        bytes: pool === "data" ? brokerDataCredit(ASSISTANCE_ARTIFACTS.runtime.bytes) : ASSISTANCE_LIMITS.stream / 16,
        entries: pool === "data" ? 128 : 32,
      }));
      this.#broker.postMessage({ kind: "reserve", identity: this.#identity(task, ++task.commandSequence), credits: task.brokerCredits });
      task.brokerStarted = true;
      await this.#grantGuest(task);
    }
    this.#requireStarting(task);
  }

  async #initialize(task: Task, requestId: number, input: AssistanceSpawnInput, storage?: Pick<SnapshotStorageClient, "readBuildPolicy">): Promise<void> {
    await this.#admit(task);
    const cwd = input.cwd === "/" ? "/workspace" : `/workspace${input.cwd}`;
    const started = await this.#call(task, { kind: "start", cwd, env: input.env }, requestId);
    if (started.result.kind !== "started") throw new VMError("PROTOCOL_ERROR", "Guest did not initialize the assisted task");
    let dependencies: AssistedDependencyIdentity | undefined;
    if (input.workspaceBaseSha256 !== undefined && this.#agent.assistanceVersion === 7) {
      if (storage === undefined) throw new VMError("STORAGE_ERROR", "Dependency admission requires workspace storage");
      const decisions = await storage.readBuildPolicy(input.workspaceBaseSha256, task.dispatch.signal);
      this.#requireStarting(task);
      const checked = await this.#call(task, { kind: "check-dependencies", policy: new TextEncoder().encode(JSON.stringify(decisions)) }, requestId);
      if (checked.result.kind === "error") throw new VMError("FEATURE_NOT_AVAILABLE", "Dependency admission failed; prepare dependencies again", {
        syscall: checked.result.syscall, errno: checked.result.errno, guestCode: checked.result.code,
      });
      if (checked.result.kind !== "data" || (checked.result.bytes.length !== 0 && checked.result.bytes.length !== 64)) {
        throw new VMError("PROTOCOL_ERROR", "Guest returned invalid dependency admission identity");
      }
      if (checked.result.bytes.length === 64) {
        const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        dependencies = { generation: hex(checked.result.bytes.subarray(0, 32)), inputsSha256: hex(checked.result.bytes.subarray(32)) };
      }
    }
    this.#requireStarting(task);
    if (this.#broker === undefined) throw new VMError("PROTOCOL_ERROR", "Assistance broker was lost during startup");
    const entry = input.entry.startsWith("/") ? input.entry : `${started.result.cwd}/${input.entry}`;
    task.dependencies = dependencies;
    task.brokerStarted = true;
    this.#broker.postMessage({ kind: "start", identity: this.#identity(task, ++task.commandSequence), entry, cwd: started.result.cwd, args: input.args, env: started.result.env,
      ...(dependencies === undefined ? {} : { dependencies }) });
  }

  #requireStarting(task: Task): void {
    if (task.phase !== "starting") throw new VMError("ABORTED", "Assisted startup was cancelled");
  }

  async #grantGuest(task: Task): Promise<void> {
    if (!this.#guestBound) throw new VMError("PROTOCOL_ERROR", "Guest assistance is not bound");
    for (const pool of ["data", "control"] as const) {
      this.#requireStarting(task);
      const credit = this.#traffic.grant({ session: this.#session, generation: this.#generation, process: task.process,
        producer: "guest", pool, bytes: pool === "data" ? 9 * ASSISTANCE_LIMITS.stream / 8 : ASSISTANCE_LIMITS.stream / 8,
        entries: pool === "data" ? 128 : 32 });
      task.guestCredits.push(credit);
      await this.#agent.creditAssistance(task.requestId, credit);
    }
  }

  cancel(requestId: number): void {
    if (this.#policyCommit?.requestId === requestId) this.#policyCommit.cancellation.abort();
    if (this.#preparation?.requestId === requestId) this.#preparation.cancellation.abort();
    if (this.#workspaceTransfer?.requestId === requestId) this.#workspaceTransfer.cancellation.abort();
    const task = [...this.#tasks.values()].find(task => task.requestId === requestId && (task.phase === "starting" || task.phase === "running"));
    if (task !== undefined) void this.#retire(task, { signal: 9 }).catch((error: unknown) => this.#fail(error));
  }

  input(process: number, bytes: Uint8Array<ArrayBuffer> | null): Promise<void> {
    this.prepare();
    const task = this.#tasks.get(process);
    if (task === undefined || task.phase !== "running" || task.inputClosed || this.#broker === undefined) {
      throw new VMError("ABORTED", "Assisted input is closed");
    }
    if (task.input !== undefined) throw new VMError("PROTOCOL_ERROR", "Concurrent assisted input");
    const charge = (bytes?.length ?? 0) * 3 + 128;
    const identity = this.#identity(task, task.commandSequence + 1);
    const completion = Promise.withResolvers<undefined>();
    const reservation = this.#traffic.reserve(task.process, "data", charge);
    task.commandSequence = identity.sequence;
    task.input = { sequence: identity.sequence, reservation, completion };
    task.inputClosed = bytes === null;
    try { this.#broker.postMessage({ kind: "input", identity, bytes }, bytes === null ? [] : [bytes.buffer]); }
    catch (error) { this.#fail(error); }
    return completion.promise;
  }

  stop(process: number, signal: "TERM" | "KILL" | "INT" | "HUP"): Promise<void> {
    const task = this.#tasks.get(process);
    if (task === undefined) return Promise.resolve();
    return this.#retire(task, { signal: { HUP: 1, INT: 2, KILL: 9, TERM: 15 }[signal] });
  }

  dispose(): Promise<void> {
    this.#disposal ??= (async () => {
      this.#clearHeartbeat();
      this.#policyCommit?.cancellation.abort();
      await this.#policyCommit?.work.catch((error: unknown) => {
        if (!(error instanceof VMError) || error.code !== "ABORTED") this.#failure ??= deserializeError(serializeUnknownError(error));
      });
      this.#workspaceTransfer?.cancellation.abort();
      await this.#workspaceTransfer?.work.catch((error: unknown) => {
        if (!(error instanceof VMError) || error.code !== "ABORTED") this.#failure ??= deserializeError(serializeUnknownError(error));
      });
      try { await this.#installation?.finish(); }
      catch (error) { this.#failure ??= deserializeError(serializeUnknownError(error)); }
      await this.#guestBinding?.catch((error: unknown) => { this.#failure ??= deserializeError(serializeUnknownError(error)); });
      const results = await Promise.allSettled([...this.#tasks.values()].map(task => this.#retire(task,
        this.#failure === undefined ? { signal: 9 } : { error: this.#failure })));
      // Each remaining owner answers within the retirement bound or names itself.
      try { await boundedRetirementStep(this.#closeBroker(), "broker-shutdown", 0, this.#retirementStepMs); }
      catch (error) { this.#failure ??= deserializeError(serializeUnknownError(error)); }
      this.#agent.setAssistanceEvents(undefined);
      try { await boundedRetirementStep(this.#fenceGuest(), "guest-fence", 0, this.#retirementStepMs); }
      catch (error) { this.#failure ??= deserializeError(serializeUnknownError(error)); }
      try { await boundedRetirementStep(this.#closeNetwork(), "network-shutdown", 0, this.#retirementStepMs); }
      catch (error) { this.#failure ??= deserializeError(serializeUnknownError(error)); }
      this.#networkPort?.close(); this.#networkPort = undefined;
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw deserializeError(serializeUnknownError(failure.reason));
      if (this.#failure !== undefined) throw this.#failure;
    })();
    return this.#disposal;
  }

  #identity(task: Task, sequence: number): AssistanceIdentity {
    if (sequence > 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Assistance sequence exhausted");
    return { session: this.#session, generation: this.#generation, process: task.process, sequence };
  }

  #receiveGuest(event: AssistanceEvent): void {
    if (event.session !== this.#session || event.generation !== this.#generation) {
      throw new VMError("PROTOCOL_ERROR", "Stale guest assistance binding");
    }
    const task = this.#tasks.get(event.process);
    if (task === undefined || task.phase === "stopping" || task.phase === "terminal") {
      if (event.process >= this.#nextProcess) throw new VMError("PROTOCOL_ERROR", "Unknown guest assistance process");
      this.#retiredEvents += 1;
      return;
    }
    if (event.sequence <= task.guestEventSequence) throw new VMError("PROTOCOL_ERROR", "Stale guest assistance event");
    task.guestEventSequence = event.sequence;
    if (event.event.kind === "failure") {
      task.terminalSequence = event.sequence;
      void this.#retire(task, { error: new VMError("GUEST_CRASH", "Authenticated Linux task failed", { errno: event.event.errno }) })
        .catch((error: unknown) => this.#fail(error));
      return;
    }
    if (task.helpers.has(event.event.child)) {
      // A fork helper's only event is its exit once the forked child retired.
      if (event.event.kind !== "exit") throw new VMError("PROTOCOL_ERROR", "Fork helper emitted child output");
      task.helpers.delete(event.event.child);
      this.#helperExits += 1;
      return;
    }
    if (!task.brokerStarted || this.#broker === undefined) throw new VMError("PROTOCOL_ERROR", "Child event before worker startup");
    const bytes = encodeAssistanceEvent(event);
    if (event.event.kind === "output") {
      const output = event.event;
      let pending = 0;
      for (const entry of task.childOutput.values()) {
        if (entry.child === output.child && entry.stream === output.stream) pending += entry.bytes;
      }
      const charge = bytes.byteLength * 2 + 128;
      if (pending + output.bytes.length > ASSISTANCE_LIMITS.stream) {
        throw new VMError("QUOTA_EXCEEDED", "Child output capacity exhausted");
      }
      task.childOutput.set(event.sequence, { child: output.child, stream: output.stream,
        bytes: output.bytes.length, reservation: this.#traffic.reserve(task.process, "data", charge), acknowledging: false });
    }
    this.#broker.postMessage({ kind: "event", identity: this.#identity(task, ++task.commandSequence), bytes }, [bytes.buffer]);
  }

  async #call(task: Task, operation: AssistanceOperation, requestId = 0, forward?: AssistanceIdentity): Promise<AssistanceReply> {
    if (isAssistanceSocketOperation(operation)) {
      if (this.#network === undefined || task.networkAdmission === undefined) {
        throw new VMError("FEATURE_NOT_AVAILABLE", "Socket operations require network-worker admission");
      }
      await task.networkAdmission;
    }
    const acknowledged = operation.kind === "ack" ? task.childOutput.get(operation.sequence) : undefined;
    if (operation.kind === "ack") {
      if (acknowledged === undefined || acknowledged.acknowledging || acknowledged.child !== operation.child
        || acknowledged.stream !== operation.stream || acknowledged.bytes !== operation.bytes) {
        throw new VMError("PROTOCOL_ERROR", "Invalid child output acknowledgement");
      }
    }
    const supervisory = isAssistanceSupervisoryOperation(operation);
    // Reserve before encoding. Eight bounded reply copies cover helper, framing,
    // reassembly, decode and broker handoff while producer windows cover storage.
    const replyBytes = assistanceReplyCapacity(operation);
    const bytes = supervisory ? 4096 : ASSISTANCE_LIMITS.request * 2 + replyBytes * 8;
    const reservation = supervisory ? this.#traffic.reserve(task.process, "control", bytes)
      : await this.#traffic.acquire(task.process, bytes, task.dispatch.signal);
    if (acknowledged !== undefined) acknowledged.acknowledging = true;
    try {
      if (!supervisory && task.dispatch.signal.aborted) throw new VMError("ABORTED", "Assistance dispatch cancelled");
      const request = { ...this.#identity(task, ++task.guestSequence), operation };
      const reply = await this.#agent.assistance(requestId, request);
      if (isAssistanceSocketOperation(operation) && (task.phase === "starting" || this.#running(task))) {
        if (this.#network === undefined) throw new VMError("RELAY_ERROR", "Socket network owner was lost");
        if (operation.kind === "socket-listen" && reply.result.kind === "socket") {
          await this.#network.updateListener({ kind: "listener-open", process: task.process,
            fd: reply.result.fd, address: reply.result.local });
        } else if (operation.kind === "socket-close" && reply.result.kind === "unit") {
          await this.#network.updateListener({ kind: "listener-close", process: task.process, fd: operation.fd });
        }
      }
      if (operation.kind === "ack" && acknowledged !== undefined && reply.result.kind === "unit"
        && task.childOutput.get(operation.sequence) === acknowledged) {
        task.childOutput.delete(operation.sequence);
        this.#traffic.release(task.process, acknowledged.reservation);
      }
      if (forward !== undefined && (task.phase === "starting" || this.#running(task))) this.#reply({ ...reply, ...forward });
      return reply;
    } finally {
      if (acknowledged !== undefined) acknowledged.acknowledging = false;
      this.#traffic.release(task.process, reservation);
    }
  }

  async #receive(value: unknown): Promise<void> {
    const envelope = record(value, "broker message");
    if (envelope["kind"] === "stopped") {
      const receipt = decodeBrokerShutdown(value);
      if (this.#brokerShutdown === undefined || receipt.binding.session !== this.#session
        || receipt.binding.generation !== this.#generation || receipt.sequence !== this.#heartbeatSequence) {
        throw new VMError("PROTOCOL_ERROR", "Invalid broker shutdown receipt");
      }
      this.#brokerShutdown.resolve(undefined);
      return;
    }
    if (envelope["kind"] === "retired") {
      const receipt = decodeBrokerRetired(value);
      const task = this.#tasks.get(receipt.identity.process);
      if (receipt.identity.session !== this.#session || receipt.identity.generation !== this.#generation
        || task?.phase !== "stopping" || receipt.identity.sequence !== task.commandSequence
        || task.brokerRetired === undefined || task.brokerCredits.length !== 2) {
        throw new VMError("PROTOCOL_ERROR", "Invalid broker retirement receipt");
      }
      for (const credit of receipt.credits) {
        if (credit.producer !== "broker" || credit.process !== task.process) throw new VMError("PROTOCOL_ERROR", "Wrong retired producer");
        this.#traffic.returnCredit(credit);
      }
      task.brokerCredits.length = 0;
      task.brokerRetired.resolve(undefined);
      return;
    }
    if (envelope["kind"] === "pong") {
      const pong = decodeBrokerHeartbeat(value);
      if (this.#brokerShutdown !== undefined && pong.binding.session === this.#session
        && pong.binding.generation === this.#generation && pong.sequence + 1 === this.#heartbeatSequence) return;
      if (pong.binding.session !== this.#session || pong.binding.generation !== this.#generation
        || pong.sequence !== this.#heartbeatSequence || this.#heartbeatDeadline === undefined) {
        throw new VMError("PROTOCOL_ERROR", "Invalid broker heartbeat reply");
      }
      this.#heartbeatDeadline = undefined;
      return;
    }
    if (envelope["kind"] === "broker-failed") {
      const failure = decodeBrokerFailure(value);
      if (failure.binding.session !== this.#session || failure.binding.generation !== this.#generation) {
        throw new VMError("PROTOCOL_ERROR", "Stale broker failure binding");
      }
      throw deserializeError(failure.error);
    }
    const event = decodeBrokerEvent(value);
    const task = this.#tasks.get(event.identity.process);
    if (event.identity.session !== this.#session || event.identity.generation !== this.#generation) {
      throw new VMError("PROTOCOL_ERROR", "Stale assistance broker binding");
    }
    // Retirement fences authority immediately. Messages already queued by that
    // worker cannot acquire resources, deliver output, or poison its successor.
    if ((task === undefined && event.identity.process < this.#nextProcess)
      || task?.phase === "stopping" || task?.phase === "terminal") {
      this.#retiredEvents += 1;
      return;
    }
    if (task === undefined || event.identity.sequence !== task.brokerSequence + 1 || !task.brokerStarted) {
      throw new VMError("PROTOCOL_ERROR", "Stale or out-of-order assistance broker event");
    }
    task.brokerSequence = event.identity.sequence;
    if (task.phase === "starting" && event.kind !== "ready" && event.kind !== "request" && event.kind !== "failed") {
      throw new VMError("PROTOCOL_ERROR", "Assisted worker is not ready");
    }
    switch (event.kind) {
      case "input-ack": {
        const input = task.input;
        if (input === undefined || input.sequence !== event.sequence) throw new VMError("PROTOCOL_ERROR", "Invalid assisted stdin acknowledgement");
        task.input = undefined;
        this.#traffic.release(task.process, input.reservation);
        input.completion.resolve(undefined);
        break;
      }
      case "ready":
        if (task.phase !== "starting") throw new VMError("PROTOCOL_ERROR", "Duplicate assisted worker readiness");
        task.phase = "running";
        task.ready.resolve(undefined);
        break;
      case "request": {
        try {
          await this.#call(task, event.operation, 0, event.identity);
        } catch (error) {
          // Task termination rejects blocked Linux calls. Their late outcomes
          // belong to the retired task, not to the reusable VM generation.
          if (task.phase === "starting" || this.#running(task)) {
            // A correlated helper failure is task-local. Retirement obtains and
            // acknowledges its retained terminal outcome; failed cleanup still
            // fences the generation through the outer receive handler.
            if (!(error instanceof VMError) || error.code !== "STORAGE_ERROR"
              || error.detail?.["agentStatus"] !== 4 || error.detail["agentKind"] !== AgentKind.assistance) throw error;
            await this.#retire(task, { error: new VMError("GUEST_CRASH", "Authenticated Linux task failed", error.detail) });
            return;
          }
          this.#retiredEvents += 1;
        }
        break;
      }
      case "output": {
        if (task.parent !== undefined && task.silent) { this.#forks.output(task, event); break; }
        // An inherited fork child's output joins its parent's public stream
        // in arrival order and is charged to the parent that shows it.
        const sink = task.parent ?? task;
        const streamBytes = sink.output.reduce((sum, output) => sum + (output.event.stream === event.stream ? output.event.bytes.length : 0), 0);
        if (sink.output.length >= 128 || streamBytes + event.bytes.byteLength > ASSISTANCE_LIMITS.stream) {
          throw new VMError("QUOTA_EXCEEDED", "Assisted output capacity exhausted");
        }
        if (sink !== task && !this.#running(sink)) break;
        const reservation = this.#traffic.reserve(sink.process, "data", event.bytes.byteLength * 2 + 128);
        sink.outputBytes += event.bytes.byteLength;
        sink.output.push({ event, reservation, sequence: undefined });
        this.#flushOutput(sink);
        break;
      }
      case "exit": case "exit-request": case "exit-signal":
        task.phase = "stopping";
        task.dispatch.abort();
        if (task.output.length !== 0) await new Promise<void>(resolve => { task.drain = resolve; });
        await this.#retire(task, event.kind === "exit-signal" ? { signal: event.signal } : { code: event.code });
        break;
      case "failed": await this.#retire(task, { error: deserializeError(event.error) }); break;
      case "fork": await this.#forks.fork(task, event); break;
      case "fork-input": await this.#forks.input(task, event); break;
      case "fork-signal": this.#forks.signal(task, event); break;
      case "fork-output-ack": this.#forks.outputAcknowledged(task, event); break;
    }
  }

  #reply(reply: AssistanceReply): void {
    const bytes = encodeAssistanceReply(reply, BROKER_REPLY_VERSION);
    this.#broker?.postMessage({ kind: "reply", identity: { session: reply.session, generation: reply.generation, process: reply.process, sequence: reply.sequence }, bytes }, [bytes.buffer]);
  }

  #flushOutput(task: Task): void {
    const first = task.output[0];
    const port = task.port;
    if (first === undefined || first.sequence !== undefined || port === undefined) return;
    first.sequence = ++task.outputSequence;
    port.postMessage({ version: PROTOCOL_VERSION, sessionId: task.process, sequence: first.sequence,
      type: first.event.stream, data: first.event.bytes });
  }

  #ackOutput(task: Task, value: unknown): void {
    if (task.phase === "terminal") return;
    const ack = decodeGuestProcessPortAck(value);
    const first = task.output[0];
    if (ack.sessionId !== task.process || first === undefined || first.sequence !== ack.sequence) {
      throw new VMError("PROTOCOL_ERROR", "Invalid assisted output acknowledgement");
    }
    task.output.shift();
    task.outputBytes -= first.event.bytes.byteLength;
    this.#traffic.release(task.process, first.reservation);
    this.#reply({ ...first.event.identity, result: { kind: "unit" } });
    if (task.output.length === 0) { task.drain?.(); task.drain = undefined; }
    else this.#flushOutput(task);
  }

  #retire(task: Task, outcome: TaskOutcome): Promise<void> {
    task.retirement ??= (async () => {
      task.ready.reject("error" in outcome ? outcome.error : new VMError("ABORTED", "Assisted startup was cancelled"));
      task.phase = "stopping";
      task.dispatch.abort();
      // Fork descendants go first, as in Linux: their groups nest under this
      // task's and a stopping parent no longer hears their termination.
      await Promise.allSettled([...task.children].map(child => this.#retire(child, { signal: 9 })));
      if (task.input !== undefined) {
        this.#traffic.release(task.process, task.input.reservation);
        task.input.completion.reject(new VMError("ABORTED", "Assisted input was stopped"));
        task.input = undefined;
      }
      try {
        if (task.brokerStarted) {
          if (task.brokerCredits.length !== 0) {
            task.brokerRetired = Promise.withResolvers<undefined>();
            if (this.#failure !== undefined) task.brokerRetired.reject(this.#failure);
            void task.brokerRetired.promise.catch(() => { /* Retained for the cleanup await below. */ });
          }
          this.#broker?.postMessage({ kind: "stop", identity: this.#identity(task, ++task.commandSequence) });
        } else {
          for (const credit of task.brokerCredits) this.#traffic.returnCredit({ ...credit, kind: "return" });
          task.brokerCredits.length = 0;
        }
        let finalOutcome = outcome;
        let stopped = await this.#step(task, "guest-stop", this.#call(task, task.terminalSequence === undefined
          ? { kind: "stop" } : { kind: "terminal-ack", sequence: task.terminalSequence }));
        if (stopped.result.kind === "terminal") {
          finalOutcome = { error: new VMError("GUEST_CRASH", "Authenticated Linux task failed", { errno: stopped.result.errno }) };
          task.terminalSequence = stopped.result.sequence;
          stopped = await this.#step(task, "terminal-ack", this.#call(task, { kind: "terminal-ack", sequence: stopped.result.sequence }));
        }
        if (stopped.result.kind !== "unit") {
          throw new VMError("GUEST_CRASH", "Linux could not retire the assisted task", {
            operation: "stop", ...(stopped.result.kind === "error" ? { ...stopped.result } : {}),
          });
        }
        while (task.guestCredits[0] !== undefined) {
          const returned = await this.#step(task, "credit-return", this.#agent.creditAssistance(0, { ...task.guestCredits[0], kind: "return" }));
          this.#traffic.returnCredit(returned);
          task.guestCredits.shift();
        }
        if (task.brokerRetired !== undefined) await this.#step(task, "broker-retired", task.brokerRetired.promise);
        if (task.networkAdmission !== undefined) {
          await this.#step(task, "network-close", task.networkAdmission);
          if (this.#network === undefined) throw new VMError("RELAY_ERROR", "Network owner lost during task retirement");
          await this.#step(task, "network-close", this.#network.updateListener({ kind: "task-close", process: task.process }));
          task.networkAdmission = undefined;
        }
        for (const entry of task.childOutput.values()) this.#traffic.release(task.process, entry.reservation);
        task.childOutput.clear();
        for (const chunk of task.forkOutput.values()) this.#traffic.release(task.process, chunk.reservation);
        task.forkOutput.clear();
        for (const output of task.output) this.#traffic.release(task.process, output.reservation);
        task.outputBytes = 0;
        task.output.length = 0;
        task.drain?.(); task.drain = undefined;
        task.phase = "terminal";
        this.#announce(task, finalOutcome);
        task.port?.close();
        this.#tasks.delete(task.process);
      } catch (error) {
        this.#failure = deserializeError(serializeUnknownError(error));
        this.#announce(task, { error });
        task.port?.close();
        throw error;
      }
    })();
    return task.retirement;
  }

  #step<T>(task: Task, step: RetirementStep, work: Promise<T>): Promise<T> {
    return boundedRetirementStep(work, step, task.process, this.#retirementStepMs);
  }

  /** A spawned task reports to its SDK port; a fork child to its parent. */
  #announce(task: Task, outcome: TaskOutcome): void {
    if (task.port !== undefined) {
      task.port.postMessage({ version: PROTOCOL_VERSION, sessionId: task.process, sequence: ++task.outputSequence,
        ...("error" in outcome ? { type: "error", error: serializeUnknownError(outcome.error) }
          : { type: "exit", termination: "code" in outcome ? { kind: "exit", code: outcome.code } : { kind: "signal", signal: outcome.signal } }) });
      return;
    }
    this.#forks.terminated(task, outcome);
  }

  async #closeBroker(): Promise<void> {
    if (this.#broker !== undefined && (this.#agent.assistanceVersion === 6 || this.#agent.assistanceVersion === 7)) {
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#brokerShutdown === undefined) {
        if (this.#heartbeatSequence === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Broker shutdown sequence exhausted");
        this.#brokerShutdown = Promise.withResolvers<undefined>();
        this.#broker.postMessage({ kind: "shutdown", binding: { session: this.#session, generation: this.#generation }, sequence: ++this.#heartbeatSequence });
      }
      await this.#brokerShutdown.promise;
    }
    this.#broker?.close(); this.#broker = undefined; this.#brokerAttention?.close(); this.#brokerAttention = undefined;
    this.#heartbeatSequence = 0;
    this.#traffic.retireGrants({ session: this.#session, generation: this.#generation }, null, "bootstrap");
    this.#bootstrapCredits.length = 0;
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#heartbeatDeadline = undefined;
    this.#guestHeartbeatPending = false;
  }

  #checkGuest(): void {
    if (this.#replacing || this.#disposal !== undefined) return;
    const supervised = (this.#agent.assistanceVersion === 6 || this.#agent.assistanceVersion === 7);
    if ((supervised ? !this.#guestBound : this.#tasks.size === 0) || this.#guestHeartbeatPending) return;
    this.#guestHeartbeatPending = true;
    const generation = this.#generation;
    const health = supervised ? this.#superviseGuest("ping") : this.#agent.checkAssistanceHealth();
    void health.catch((error: unknown) => {
      if (this.#generation === generation && this.#disposal === undefined && (supervised || this.#tasks.size !== 0)) this.#fail(error);
    }).finally(() => {
      if (this.#generation === generation) this.#guestHeartbeatPending = false;
    });
  }

  #superviseGuest(operation: "ping" | "fence" | "abort"): Promise<void> {
    if (this.#vmSequence === 0xffff_ffff) return Promise.reject(new VMError("QUOTA_EXCEEDED", "Assistance VM sequence exhausted"));
    return this.#agent.superviseAssistance(0, { session: this.#session, generation: this.#generation, sequence: ++this.#vmSequence, operation });
  }

  async #fenceGuest(): Promise<void> {
    if (!this.#guestBound) return;
    const abort = this.#failure !== undefined;
    this.#guestFence ??= this.#superviseGuest(abort ? "abort" : "fence").then(() => {
      if (abort) for (const task of this.#tasks.values()) {
        for (const credit of task.guestCredits) this.#traffic.returnCredit({ ...credit, kind: "return" });
        task.guestCredits.length = 0;
      }
      // A confirmed VM abort retires every guest producer, including a grant
      // whose installation acknowledgement or explicit return was lost.
      if (abort) for (const producer of ["installation", "installation-gateway", "installation-process"] as const) {
        this.#traffic.retireGrants({ session: this.#session, generation: this.#generation }, null, producer);
      }
      this.#guestBound = false;
      this.#guestBinding = undefined;
      this.#vmSequence = 0;
    });
    await this.#guestFence;
  }

  #running(task: Task): boolean { return task.phase === "running"; }

  #fail(error: unknown): void {
    this.#failure ??= deserializeError(serializeUnknownError(error));
    this.#brokerShutdown?.reject(this.#failure);
    for (const task of this.#tasks.values()) task.brokerRetired?.reject(this.#failure);
    void this.dispose().catch(() => { /* The shared cleanup result remains rejected for the VM owner. */ });
  }
}

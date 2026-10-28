import { expect, test } from "vitest";
import type { RelayConnectionOptions, VMNetwork } from "./network-types.js";

// These examples compile under the SDK's strict test project.
function examples(network: VMNetwork, signal: AbortSignal): readonly Promise<void>[] {
  const personal = {kind:"personal",workspaceName:"My project"} satisfies RelayConnectionOptions;
  const server = {kind:"server",url:new URL("https://app.example/oxidevm-relay/"),sessionUrl:"/api/oxidevm/relay-session",headers:{authorization:"Bearer browser-safe-credential"}} satisfies RelayConnectionOptions;
  // @ts-expect-error personal authorization never accepts a remote endpoint
  const mixed: RelayConnectionOptions = {kind:"personal",url:"https://relay.example/"};
  // @ts-expect-error server connections require an explicit endpoint
  const missing: RelayConnectionOptions = {kind:"server"};
  // @ts-expect-error personal authorization never accepts operator headers
  const credentials: RelayConnectionOptions = {kind:"personal",headers:{authorization:"secret"}};
  void mixed; void missing; void credentials;
  return [network.connect(personal,{signal}),network.connect(server),network.disconnect(),network.watch(state=>{if(state.kind==="failed")expect(typeof state.reason).toBe("string");},{signal})];
}
test("SDK connection examples have a compiler-checked public boundary",()=>{expect(typeof examples).toBe("function");});

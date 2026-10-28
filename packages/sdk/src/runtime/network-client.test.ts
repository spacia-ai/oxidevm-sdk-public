import { afterEach, expect, test, vi } from "vitest";
import { NetworkClient } from "./network-client.js";
import { serveNetworkControl } from "./workers/network-control.js";
import { RelayConnectionOwner } from "./workers/network-connection.js";

const clients: NetworkClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); vi.unstubAllGlobals(); });

test("network watch immediately observes off; discovery only starts on connect", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed")); vi.stubGlobal("fetch", fetch);
  const channel = new MessageChannel();
  const owner = new RelayConnectionOwner({origin:"https://app.example",workspaceId:"one"},{setRelay:async()=>{}});
  serveNetworkControl(channel.port2, owner, "https://app.example/");
  const client = NetworkClient.fromPort(channel.port1, "https://app.example/"); clients.push(client);
  const states: string[] = []; const abort = new AbortController();
  const watching = client.watch(state=>states.push(state.kind), {signal:abort.signal});
  expect(states).toEqual(["off"]); expect(fetch).not.toHaveBeenCalled();
  await expect(client.connect({kind:"personal"})).rejects.toMatchObject({detail:{reason:"discovery-failed"}});
  expect(client.state).toEqual({kind:"failed",reason:"discovery-failed"});
  expect(states).toContain("discovering");
  abort.abort(); await watching;
  await client.disconnect(); expect(client.state).toEqual({kind:"off"});
});

test("mixed personal options fail before a worker or network request exists", async () => {
  const worker = vi.fn<()=>Worker>().mockImplementation(()=>{throw new Error("must not start");});
  const client = new NetworkClient(worker,{origin:"https://app.example",workspaceId:"one"}); clients.push(client);
  // @ts-expect-error personal connections cannot supply a server URL
  await expect(client.connect({kind:"personal",url:"https://evil.example/"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  // @ts-expect-error personal connections cannot supply operator credentials
  await expect(client.connect({kind:"personal",headers:{authorization:"secret"}})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(client.connect({kind:"personal",workspaceName:""})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  expect(worker).not.toHaveBeenCalled();
});

test("malformed relay URLs fail as invalid arguments before a worker or network request exists", async () => {
  const worker = vi.fn<()=>Worker>().mockImplementation(()=>{throw new Error("must not start");});
  const client = new NetworkClient(worker,{origin:"https://app.example",workspaceId:"one"}); clients.push(client);
  await expect(client.connect({kind:"server",url:"relay.example"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(client.connect({kind:"server",url:"https://relay.example/",sessionUrl:"https://[session"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  expect(worker).not.toHaveBeenCalled();
});

test("an already cancelled connection settles without waiting for a state change", async () => {
  const channel = new MessageChannel();
  const owner = new RelayConnectionOwner({origin:"https://app.example",workspaceId:"one"},{setRelay:async()=>{}});
  serveNetworkControl(channel.port2,owner,"https://app.example/");
  const client=NetworkClient.fromPort(channel.port1,"https://app.example/"); clients.push(client);
  const controller=new AbortController();controller.abort();
  await expect(client.connect({kind:"personal"},{signal:controller.signal})).rejects.toMatchObject({code:"ABORTED"});
  expect(client.state).toEqual({kind:"off"});
});

test("personal-only application policy rejects server relay before worker creation", async () => {
  const worker=vi.fn<()=>Worker>().mockImplementation(()=>{throw new Error("must not start");});
  const client=new NetworkClient(worker,{origin:"https://app.example",workspaceId:"one",serverAllowed:false});clients.push(client);
  await expect(client.connect({kind:"server",url:"https://server.example/"})).rejects.toMatchObject({code:"FEATURE_NOT_AVAILABLE"});
  expect(worker).not.toHaveBeenCalled();
});

test("watch stops when the initial callback aborts its signal", async () => {
  const channel = new MessageChannel();
  const owner = new RelayConnectionOwner({origin:"https://app.example",workspaceId:"one"},{setRelay:async()=>{}});
  serveNetworkControl(channel.port2, owner, "https://app.example/");
  const client = NetworkClient.fromPort(channel.port1, "https://app.example/"); clients.push(client);
  const abort = new AbortController();
  const watching = client.watch(() => abort.abort(), {signal: abort.signal});
  expect(await Promise.race([watching.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 20, false))])).toBe(true);
});

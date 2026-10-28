import { expect, it } from "vitest";
import { SnapshotStorageClient } from "./snapshot-channel.js";
import { serveSnapshotStorage } from "./snapshot-storage-server.js";

it("projects preparation progress without storage envelope fields",async()=>{
  const ports=new MessageChannel();
  const server=serveSnapshotStorage(ports.port1,(_request,_signal,progress)=>{progress({completedBytes:1,totalBytes:3});return Promise.resolve(undefined);});
  const client=new SnapshotStorageClient(ports.port2),seen:unknown[]=[];
  try {await client.request({type:"prepare-native-image"},[],undefined,value=>seen.push(value));expect(seen).toEqual([{completedBytes:1,totalBytes:3}]);}
  finally{client.close();await server.close();}
});

it("drains accepted storage work before closing the channel", async () => {
  const ports = new MessageChannel();
  const started = Promise.withResolvers<undefined>();
  let retired = false;
  const server = serveSnapshotStorage(ports.port1, async (_request, signal) => {
    started.resolve(undefined);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    retired = true;
    return undefined;
  });
  const client = new SnapshotStorageClient(ports.port2);
  const request = client.request({ type: "abort" });
  await started.promise;
  await server.close();
  expect(retired).toBe(true);
  client.close();
  await request.catch(() => {});
});

it("shares shutdown and waits for independent producer retirement", async () => {
  const ports = new MessageChannel();
  const started = Promise.withResolvers<undefined>();
  const retirement = Promise.withResolvers<undefined>();
  const canceled = Promise.withResolvers<undefined>();
  const server = serveSnapshotStorage(ports.port1, async (_request, signal) => {
    signal.addEventListener("abort", () => canceled.resolve(undefined), { once: true });
    started.resolve(undefined);
    await retirement.promise;
    return undefined;
  });
  const client = new SnapshotStorageClient(ports.port2);
  const request = client.request({ type: "abort" });
  const outcome = request.catch(() => {});
  await started.promise;
  const closing = server.close();
  expect(server.close()).toBe(closing);
  await canceled.promise;
  let closed = false;
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  retirement.resolve(undefined);
  await closing;
  client.close();
  await outcome;
});

it("answers a response it cannot post with that request's failure and keeps serving", async () => {
  const ports = new MessageChannel();
  const server = serveSnapshotStorage(ports.port1, (request) => {
    if (request.type !== "collect") return Promise.resolve(undefined);
    // Its buffer is detached, so posting it as a transfer throws.
    const bytes = new Uint8Array(8);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return Promise.resolve(bytes);
  });
  const client = new SnapshotStorageClient(ports.port2);
  await expect(client.request({ type: "collect" })).rejects.toBeInstanceOf(Error);
  await expect(client.request({ type: "abort" })).resolves.toBeUndefined();
  client.close();
  await server.close();
});

it.each([false, true])("admits cold publication cancellation and preserves its settled committed result (late cancel: %s)", async lateCancel => {
  const ports = new MessageChannel(), cancellation = new AbortController();
  let published = false, canceled = false;
  const sourceId = "123e4567-e89b-42d3-a456-426614174000";
  const server = serveSnapshotStorage(ports.port1, async (request, signal) => {
    expect(request).toEqual({ type: "publish-native-cold", sourceId });
    published = true;
    if (lateCancel) {
      const retired = new Promise<void>(resolve => signal.addEventListener("abort", () => {
        canceled = true; resolve();
      }, { once: true }));
      cancellation.abort();
      await retired;
    }
    return undefined;
  });
  const client = new SnapshotStorageClient(ports.port2);
  try {
    await expect(client.request({ type: "publish-native-cold", sourceId }, [], cancellation.signal)).resolves.toBeUndefined();
    expect(published).toBe(true);
    expect(canceled).toBe(lateCancel);
  } finally { client.close(); await server.close(); }
});

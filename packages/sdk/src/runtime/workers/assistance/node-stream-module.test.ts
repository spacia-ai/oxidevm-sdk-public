import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeStreamModule } from "./node-streams.js";

it("exposes the real stream constructor and preserves context for overlapping pipeline completions", async () => {
  const context = createAsyncContext();
  const store = new context.AsyncLocalStorage<string>();
  const { module: stream, restore } = createNodeStreamModule(context, () => () => {});
  try {
    expect(stream.Stream).toBe(stream);
    expect(new stream.PassThrough()).toBeInstanceOf(stream);
    const promised: unknown = Reflect.get(stream.pipeline, Symbol.for("nodejs.util.promisify.custom"));
    expect(promised).toBe(stream.promises.pipeline);
    const pending = ["first", "second"].map(label => store.run(label, () => new Promise<string | undefined>((resolve, reject) => {
      const source = stream.Readable.from([label]);
      const transform = new stream.Transform({ transform(chunk, _encoding, done) {
        setTimeout(() => { done(null, chunk); }, label === "first" ? 10 : 0);
      } });
      const chunks: string[] = [];
      const output = new stream.Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
      stream.pipeline(source, transform, output, error => {
        if (error !== null && error !== undefined) { reject(error); return; }
        expect(chunks).toEqual([label]);
        resolve(store.getStore());
      });
    })));
    store.enterWith("outside");
    await expect(Promise.all(pending)).resolves.toEqual(["first", "second"]);
    expect(store.getStore()).toBe("outside");
  } finally { restore(); }
});

it("retains finished callback context, promise pipeline, and restores owned wrappers", async () => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const { module: stream, restore } = createNodeStreamModule(context, () => () => {});
  const wrapped = stream.finished;
  try {
    const output = new stream.Writable({ write(_chunk, _encoding, done) { done(); } });
    const result = store.run("finished", () => new Promise<string | undefined>((resolve, reject) => {
      stream.finished(output, error => { if (error) reject(error); else resolve(store.getStore()); });
    }));
    output.end("body");
    await expect(result).resolves.toBe("finished");
    const chunks: string[] = [];
    await stream.promises.pipeline(stream.Readable.from(["a", "b"]), new stream.Writable({
      write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); },
    }));
    expect(chunks).toEqual(["a", "b"]);
  } finally { restore(); }
  expect(stream.finished).not.toBe(wrapped);
});

it("propagates pipeline errors and retires streams in the caller's completion context", async () => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const { module: stream, restore } = createNodeStreamModule(context, () => () => {});
  try {
    const failure = new Error("write failed");
    const source = stream.Readable.from(["body"]);
    const output = new stream.Writable({ write(_chunk, _encoding, done) { done(failure); } });
    const result = store.run("failed-pipeline", () => new Promise<unknown>(resolve => {
      stream.pipeline(source, output, error => { resolve({ error, context: store.getStore() }); });
    }));
    store.enterWith("outside");
    await expect(result).resolves.toEqual({ error: failure, context: "failed-pipeline" });
    expect(source.destroyed && output.destroyed).toBe(true);
  } finally { restore(); }
});

it("accounts queued browser stream callbacks without retaining an unused stream", async () => {
  let activities = 0;
  const { module: stream, restore } = createNodeStreamModule(createAsyncContext(), () => {
    activities += 1;
    return () => { activities -= 1; };
  });
  const unused = new stream.PassThrough();
  try {
    expect(activities).toBe(0);
    let completed = false;
    const source = stream.Readable.from((async function* () { yield "a"; await Promise.resolve(); yield "b"; })());
    const done = new Promise<void>((resolve, reject) => {
      stream.pipeline(source, new stream.Writable({ write(_chunk, _encoding, callback) { callback(); } }), error => {
        completed = true;
        if (error) reject(error); else resolve();
      });
    });
    expect(activities).toBeGreaterThan(0);
    while (activities !== 0) await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(true);
    await done;
  } finally { unused.destroy(); restore(); }
});

it("keeps process stdout and stderr open when piped children reach EOF", async () => {
  const context = createAsyncContext();
  const { createOutputStream, Readable } = await import("./node-streams.js");
  const chunks: string[] = [];
  const stdout = createOutputStream(bytes => { chunks.push(new TextDecoder().decode(bytes)); }, context);
  const stderr = createOutputStream(() => {}, context);
  const { restore } = createNodeStreamModule(context, () => () => {}, undefined, { stdout, stderr });
  try {
    for (const target of [stdout, stderr]) {
      const source = Readable.from(["child"]);
      const done = new Promise<void>(resolve => { source.once("end", () => resolve()); });
      source.pipe(target); await done;
      expect(target.writableEnded).toBe(false);
      target.write("parent");
    }
    expect(chunks).toEqual(["child", "parent"]);
  } finally { restore(); stdout.destroy(); stderr.destroy(); }
});

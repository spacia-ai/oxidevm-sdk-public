import {expect,it} from "vitest";
import {OperationSupervisor,ProcessSupervisor} from "./processes.js";
import {decodeProcessId} from "../../values.js";
import type {ProcessHandle} from "../../contracts.js";
it("ignored_helper_rejection_still_fails_settle",async()=>{
  const operations=new OperationSupervisor();
  void operations.track(Promise.reject(new Error("failed helper")));
  await expect(operations.settle()).rejects.toThrow("failed helper");
});
it("utf8_matches_chunk_boundaries_and_unexpected_exit_fails",async()=>{
  const output=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([0xf0,0x9f]));c.enqueue(new Uint8Array([0x98,0x80,0x21]));}});
  const exit=Promise.withResolvers<{kind:"exited";code:number}>();
  const process:ProcessHandle={kind:"process",pid:decodeProcessId(1),snapshotKey:"process:1",stdin:new WritableStream(),stdout:output,stderr:new ReadableStream(),
    exit:exit.promise,kill:()=>Promise.resolve()};
  const supervisor=new ProcessSupervisor(new AbortController().signal,1000,new OperationSupervisor());
  const wrapped=supervisor.add("server",process);
  await wrapped.waitForOutput("😀!");
  exit.resolve({kind:"exited",code:0});await Promise.resolve();
  expect(()=>supervisor.required()).toThrow();
  await supervisor.close();
});

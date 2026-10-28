import {expect,it,vi} from "vitest";
import {runCommand} from "./context.js";
import type {VM} from "../../contracts.js";
it("finite_commands_require_expected_normal_exit",async()=>{
  const vm:Pick<VM,"exec">={exec:()=>Promise.resolve({stdout:new Uint8Array(),stderr:new Uint8Array(),exit:{kind:"exited",code:3}})};
  await expect(runCommand(vm,{command:"test"},new AbortController().signal,1000)).rejects.toMatchObject({detail:{reason:"snapshot-command-failed"}});
  await expect(runCommand(vm,{command:"test",expectedExitCode:3},new AbortController().signal,1000)).resolves.toMatchObject({exit:{kind:"exited",code:3}});
});
it("finite_command_deadline_rejects_even_when_the_operation_ignores_its_signal",async()=>{
  vi.useFakeTimers();
  try{
    const vm:Pick<VM,"exec">={exec:()=>new Promise(()=>{})};
    const rejected=expect(runCommand(vm,{command:"blocked"},new AbortController().signal,1)).rejects.toMatchObject({code:"ABORTED",detail:{reason:"snapshot-command-timeout"}});
    await vi.advanceTimersByTimeAsync(2);await rejected;
  }finally{vi.useRealTimers();}
});

import {expect,it} from "vitest";
import {decodeSnapshotBrowserResult,snapshotPreparationFailure,snapshotVerificationChecks} from "./snapshot-browser-result.js";
it("preserves a valid mixed-case dotted process identity on failure",()=>{
  expect(decodeSnapshotBrowserResult({ok:false,error:{code:"GUEST_CRASH",message:"safe",phase:"prepare",check:"original-processes",reason:"snapshot-process-exited",process:"Web.Server_1"}})).toMatchObject({error:{process:"Web.Server_1"}});
});
it("unexpected_cold_boot_is_a_failed_shipped_resume_check",()=>{
  const result=decodeSnapshotBrowserResult({ok:false,error:{code:"GUEST_CRASH",message:"safe",phase:"verify",check:"shipped-resume",reason:"snapshot-unexpected-cold-boot"}});
  expect(result.ok).toBe(false);
  if(result.ok)throw new Error("unexpected success");
  expect(snapshotVerificationChecks(result).find(check=>check.check==="shipped-resume")?.status).toBe("failed");
});
it("receipt_free_manual_backups_do_not_invent_process_proof",()=>{
  const result=decodeSnapshotBrowserResult({ok:true,result:{kind:"verified",snapshot:{id:"123e4567-e89b-42d3-a456-426614174000",createdAt:"2026-10-14T00:00:00.000Z"},receipt:false,originalProcesses:0}});
  expect(snapshotVerificationChecks(result).filter(check=>check.status==="not-applicable")).toHaveLength(2);
});
it("rejects_extra_fields_wrong_results_and_unknown_failure_checks",()=>{
  for(const value of [{ok:true,result:{kind:"verified",receipt:false,originalProcesses:1}},{ok:false,error:{code:"GUEST_CRASH",message:"raw",phase:"verify",check:"other"}}]){
    expect(()=>decodeSnapshotBrowserResult(value)).toThrow();
  }
});
it("rejects_unknown_authoring_reasons_and_private_process_names",()=>{
  const error={code:"GUEST_CRASH",message:"safe",phase:"capture",check:"original-processes"};
  for(const details of [{reason:"snapshot-invented"},{process:"private/path"}])expect(()=>decodeSnapshotBrowserResult({ok:false,error:{...error,...details}})).toThrow();
  expect(decodeSnapshotBrowserResult({ok:false,error:{...error,reason:"snapshot-process-exited",process:"web"}})).toMatchObject({error:{process:"web"}});
});
it("keeps_the_browser_failure_message_as_one_bounded_line",()=>{
  const result=decodeSnapshotBrowserResult({ok:false,error:{code:"PROTOCOL_ERROR",message:`Snapshot capture progress is stale\nor unexpected${"x".repeat(2000)}`,phase:"capture",check:"shipped-resume"}});
  if(result.ok)throw new Error("unexpected success");
  expect(result.error.message.startsWith("Snapshot capture progress is stale or unexpected")).toBe(true);
  expect(result.error.message.length).toBeLessThanOrEqual(500);
  expect(snapshotVerificationChecks(result).find(check=>check.check==="shipped-resume")).toMatchObject({status:"failed",message:result.error.message});
});
it("reports_a_preparation_failure_with_its_browser_message_and_without_a_verification_check",()=>{
  const result=decodeSnapshotBrowserResult({ok:false,error:{code:"PROTOCOL_ERROR",message:"Snapshot capture progress is stale or unexpected",phase:"capture",check:"shipped-resume"}});
  if(result.ok)throw new Error("unexpected success");
  const error=snapshotPreparationFailure(result.error);
  expect(error.code).toBe("PROTOCOL_ERROR");
  expect(error.message).toBe("Snapshot preparation did not complete: Snapshot capture progress is stale or unexpected");
  expect(error.detail).toEqual({phase:"capture",reason:"snapshot-preparation-failed",browserMessage:"Snapshot capture progress is stale or unexpected"});
});

it("keeps a rejected checkpoint begin's summary through the browser result and the preparation failure",()=>{
  const checkpoint={phase:"initial-round",domain:"runtime",owner:"files",causes:["not-quiesced"]};
  const result=decodeSnapshotBrowserResult({ok:false,error:{code:"PROTOCOL_ERROR",message:"Native checkpoint could not begin",phase:"capture",check:"shipped-resume",checkpoint}});
  if(result.ok)throw new Error("expected a failure");
  expect(result.error.checkpoint).toEqual(checkpoint);
  expect(snapshotPreparationFailure(result.error).detail).toMatchObject({phase:"capture",checkpoint});
  expect(()=>decodeSnapshotBrowserResult({ok:false,error:{code:"PROTOCOL_ERROR",message:"x",phase:"capture",check:"shipped-resume",checkpoint:{...checkpoint,phase:"invented"}}})).toThrow();
});

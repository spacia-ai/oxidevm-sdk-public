import {expect,it} from "vitest";
import {parseArguments} from "./arguments.js";
import {snapshotFailureDetail,snapshotFailureText} from "./snapshot-errors.js";
import {VMError} from "@oxidevm/sdk";
it("retains the SDK's validated process name in safe failure detail",()=>{
  expect(snapshotFailureDetail(new VMError("GUEST_CRASH","safe",{process:"Web.Server_1"}))).toEqual({process:"Web.Server_1"});
  expect(snapshotFailureDetail(new VMError("GUEST_CRASH","safe",{process:"private/path"}))).toEqual({});
});
it("keeps_the_browser_message_and_check_and_prints_them",()=>{
  const detail=snapshotFailureDetail(new VMError("PROTOCOL_ERROR","Snapshot preparation did not complete: stale",
    {phase:"capture",reason:"snapshot-preparation-failed",check:"shipped-resume",browserMessage:"Snapshot capture progress is stale or unexpected"}));
  expect(detail).toEqual({phase:"capture",reason:"snapshot-preparation-failed",check:"shipped-resume",browserMessage:"Snapshot capture progress is stale or unexpected"});
  expect(snapshotFailureText("PROTOCOL_ERROR",detail)).toBe("PROTOCOL_ERROR: Snapshot command failed (phase capture, reason snapshot-preparation-failed, check shipped-resume): Snapshot capture progress is stale or unexpected\n");
  expect(snapshotFailureText("ABORTED",undefined)).toBe("ABORTED: Snapshot command failed\n");
  for(const browserMessage of ["two\nlines","x".repeat(501),7])expect(snapshotFailureDetail(new VMError("PROTOCOL_ERROR","m",{browserMessage}))).toEqual({});
  expect(snapshotFailureDetail(new VMError("PROTOCOL_ERROR","m",{check:"invented"}))).toEqual({});
});
it("snapshot_grammar_requires_trust_and_signing_without_extra_flags",()=>{
  expect(parseArguments(["snapshot","pack","saved.oxvm"],{OXIDEVM_SIGNING_KEY_FILE:"B.pem"})).toMatchObject({command:"snapshot pack",recipe:"oxidevm.snapshot.ts",signingKey:"B.pem"});
  expect(parseArguments(["snapshot","test","dist"],{OXIDEVM_SNAPSHOT_TRUST_FILE:"B.public.json"})).toMatchObject({command:"snapshot test",trust:"B.public.json"});
  expect(parseArguments(["assets","install","--snapshot","dist"],{OXIDEVM_SNAPSHOT_TRUST_FILE:"B.public.json"})).toMatchObject({command:"assets install",snapshot:"dist",trust:"B.public.json"});
  for(const args of [["snapshot","test","dist"],["snapshot","inspect","dist","--browser","chromium"],["snapshot","pack","saved","--signing-key","x","--timeout-ms","0"],["snapshot","test","dist","--trust","a","--trust","b"]]){
    expect(()=>parseArguments(args,{})).toThrow();
  }
  expect(()=>parseArguments(["assets","install","--image","a","--snapshot","b","--trust","B"],{})).toThrow();
});

it("prints a rejected checkpoint begin's phase, owner and causes", () => {
  const checkpoint = { phase: "initial-round", domain: "runtime", owner: "files", causes: ["not-quiesced"] };
  const detail = snapshotFailureDetail(new VMError("PROTOCOL_ERROR", "Snapshot preparation did not complete: Native checkpoint could not begin",
    { phase: "capture", reason: "snapshot-preparation-failed", checkpoint, browserMessage: "Native checkpoint could not begin" }));
  expect(detail).toMatchObject({ checkpoint });
  expect(snapshotFailureText("PROTOCOL_ERROR", detail)).toBe("PROTOCOL_ERROR: Snapshot command failed (phase capture, reason snapshot-preparation-failed, checkpoint initial-round runtime/files not-quiesced): Native checkpoint could not begin\n");
  expect(snapshotFailureDetail(new VMError("PROTOCOL_ERROR", "x", { checkpoint: { ...checkpoint, owner: "private/path" } }))).toEqual({});
});

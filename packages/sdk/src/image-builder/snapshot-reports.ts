import {exactKeys,integer,record,string} from "../runtime/decode.js";
import {VMError} from "../runtime/errors.js";
import {decodeSHA256,type RuntimeMode} from "../values.js";
import {decodeSnapshotId,SNAPSHOT_KINDS} from "../runtime/protocol/snapshots.js";
import {decodeShippedName} from "../runtime/managed-start.js";
import {snapshotBrowser} from "./snapshot-recipe.js";
import type {SnapshotTestReport,SnapshotCheck,SnapshotCheckResult,SnapshotBuildResult,SnapshotInspectResult,SnapshotCapturedSummary} from "./snapshot-contracts.js";
export const SNAPSHOT_CHECKS:readonly SnapshotCheck[]=["bundle-signature","image-integrity","snapshot-integrity","browser-features","shipped-resume","authoring-receipt","original-processes","custom-verification"];
export function snapshotMode(value:unknown):RuntimeMode {if(value!=="system"&&value!=="userspace")invalid();return value;}
function text(value:unknown,label:string):string {const valueText=string(value,label);if(valueText.length===0||valueText.length>8192)invalid();return valueText;}
function name(value:unknown):string {const result=decodeShippedName(value);if(result===undefined)invalid();return result;}
function shipped(value:unknown):{id:string;kind:"shipped"} {
  const snapshot=record(value,"reported snapshot");exactKeys(snapshot,["id","kind"]);if(snapshot["kind"]!=="shipped")invalid();
  return {id:decodeSnapshotId(snapshot["id"]),kind:"shipped"};
}
function check(value:unknown):SnapshotCheckResult {
  const input=record(value,"snapshot check"),check=SNAPSHOT_CHECKS.find(check=>check===input["check"]);if(check===undefined)invalid();
  if(input["status"]==="passed"){exactKeys(input,["check","status"]);return {check,status:"passed"};}
  if(input["status"]==="failed"){exactKeys(input,["check","status","message"]);return {check,status:"failed",message:text(input["message"],"failure message")};}
  exactKeys(input,["check","status","reason"]);
  if(input["status"]!=="not-applicable"||input["reason"]!=="receipt-absent"||check!=="authoring-receipt"&&check!=="original-processes")invalid();
  return {check,status:"not-applicable",reason:"receipt-absent"};
}
export function decodeSnapshotTestReport(value:unknown):SnapshotTestReport {
  const input=record(value,"snapshot test report");
  exactKeys(input,["schemaVersion","result","name","mode","bundleSHA256","snapshotManifestSHA256","imageManifestSHA256","snapshot","sdkVersion","engineReleaseId","browser","verifier","checks"]);
  if(input["schemaVersion"]!==1||input["result"]!=="passed"&&input["result"]!=="failed"||!Array.isArray(input["checks"]))invalid();
  const checks=Array.from<unknown>(input["checks"]).map(check);
  if(checks.length!==SNAPSHOT_CHECKS.length||new Set(checks.map(check=>check.check)).size!==checks.length||(input["result"]==="failed")!==checks.some(check=>check.status==="failed"))invalid();
  const browser=record(input["browser"],"browser"),verifier=record(input["verifier"],"verifier");
  exactKeys(browser,["name","version"]);exactKeys(verifier,["source","sha256"]);
  const source=verifier["source"];if(source!=="bundled"&&source!=="override")invalid();
  return {schemaVersion:1,result:input["result"],name:name(input["name"]),mode:snapshotMode(input["mode"]),bundleSHA256:input["bundleSHA256"]===null?null:decodeSHA256(input["bundleSHA256"],"bundle digest"),
    snapshotManifestSHA256:decodeSHA256(input["snapshotManifestSHA256"],"state digest"),imageManifestSHA256:decodeSHA256(input["imageManifestSHA256"],"image digest"),snapshot:shipped(input["snapshot"]),
    sdkVersion:text(input["sdkVersion"],"SDK version"),engineReleaseId:text(input["engineReleaseId"],"engine release"),browser:{name:snapshotBrowser(browser["name"]),version:text(browser["version"],"browser version")},verifier:{source,sha256:decodeSHA256(verifier["sha256"],"verifier hash")},checks};
}
export function decodeSnapshotBuildResult(value:unknown):SnapshotBuildResult {
  const input=record(value,"snapshot build result");
  exactKeys(input,["name","mode","bundlePath","referencePath","bundleSHA256","snapshotManifestSHA256","imageManifestSHA256","snapshot","sdkVersion","engineReleaseId","verification","distribution"]);
  const verification=record(input["verification"],"verification"),distribution=record(input["distribution"],"distribution");
  exactKeys(verification,["status","browser","browserVersion","resume"]);exactKeys(distribution,["status"]);
  if(verification["status"]!=="passed"||verification["resume"]!=="shipped"||distribution["status"]!=="development-only")invalid();
  return {name:name(input["name"]),mode:snapshotMode(input["mode"]),bundlePath:text(input["bundlePath"],"bundle path"),referencePath:text(input["referencePath"],"reference path"),bundleSHA256:decodeSHA256(input["bundleSHA256"],"bundle hash"),
    snapshotManifestSHA256:decodeSHA256(input["snapshotManifestSHA256"],"state hash"),imageManifestSHA256:decodeSHA256(input["imageManifestSHA256"],"image hash"),snapshot:shipped(input["snapshot"]),sdkVersion:text(input["sdkVersion"],"SDK version"),engineReleaseId:text(input["engineReleaseId"],"engine release"),
    verification:{status:"passed",browser:snapshotBrowser(verification["browser"]),browserVersion:text(verification["browserVersion"],"browser version"),resume:"shipped"},distribution:{status:"development-only"}};
}
export function decodeSnapshotCapturedSummary(value:unknown):SnapshotCapturedSummary {
  const input=record(value,"captured state");exactKeys(input,["id","mode","kind","capturedAtUnixMs","memoryMiB","vcpus","stateFormatVersion"]);
  const kind=SNAPSHOT_KINDS.find(kind=>kind===input["kind"]);if(kind===undefined)invalid();
  return {id:decodeSnapshotId(input["id"]),mode:snapshotMode(input["mode"]),kind,
    capturedAtUnixMs:integer(input["capturedAtUnixMs"],"capture time",0),memoryMiB:integer(input["memoryMiB"],"memory",16,3072),vcpus:integer(input["vcpus"],"vCPUs",1,4),stateFormatVersion:integer(input["stateFormatVersion"],"state format",1)};
}
export function decodeSnapshotInspectResult(value:unknown):SnapshotInspectResult {
  const input=record(value,"snapshot inspection"),authentication=record(input["authentication"],"authentication");
  const common={integrity:"verified" as const,snapshot:decodeSnapshotCapturedSummary(input["snapshot"])};
  if(input["integrity"]!=="verified")invalid();
  if(input["kind"]==="backup"){
    exactKeys(input,["kind","integrity","snapshot","fileBytes","authentication"]);exactKeys(authentication,["kind"]);if(authentication["kind"]!=="unsigned")invalid();
    return {...common,kind:"backup",fileBytes:integer(input["fileBytes"],"backup bytes",0,16*1024**3),authentication:{kind:"unsigned"}};
  }
  exactKeys(input,["kind","integrity","snapshot","name","bundleSHA256","snapshotManifestSHA256","imageManifestSHA256","sdkVersion","engineReleaseId","verifierSHA256","artifactCount","artifactBytes","distribution","authentication"]);
  const distribution=record(input["distribution"],"distribution");exactKeys(distribution,["status"]);if(input["kind"]!=="bundle"||distribution["status"]!=="development-only")invalid();
  const auth=authentication["kind"];exactKeys(authentication,["kind"],auth==="verified"?["keyId"]:[]);if(auth!=="verified"&&auth!=="unverified")invalid();
  return {...common,kind:"bundle",name:name(input["name"]),bundleSHA256:decodeSHA256(input["bundleSHA256"],"bundle hash"),snapshotManifestSHA256:decodeSHA256(input["snapshotManifestSHA256"],"state hash"),imageManifestSHA256:decodeSHA256(input["imageManifestSHA256"],"image hash"),
    sdkVersion:text(input["sdkVersion"],"SDK version"),engineReleaseId:text(input["engineReleaseId"],"engine release"),verifierSHA256:decodeSHA256(input["verifierSHA256"],"verifier hash"),
    artifactCount:integer(input["artifactCount"],"artifact count",1,65_542),artifactBytes:integer(input["artifactBytes"],"artifact bytes",0),distribution:{status:"development-only"},
    authentication:auth==="verified"?{kind:"verified",keyId:text(authentication["keyId"],"key id")}:{kind:"unverified"}};
}
export function decodeSnapshotBuildEvidence(value:unknown):{verificationSHA256:string} {
  const input=record(value,"snapshot build evidence");
  exactKeys(input,["format","schemaVersion","bundleSHA256","operation","backupSHA256","preparationSHA256","files","verificationSHA256"]);
  if(input["format"]!=="oxidevm-snapshot-build"||input["schemaVersion"]!==1||input["bundleSHA256"]!==null||input["operation"]!=="build"&&input["operation"]!=="pack")invalid();
  decodeSHA256(input["backupSHA256"],"backup digest");
  if(input["preparationSHA256"]!==null)decodeSHA256(input["preparationSHA256"],"preparation digest");
  if(!Array.isArray(input["files"])||input["files"].length>4096||input["operation"]==="pack"&&input["files"].length!==0)invalid();
  const destinations=new Set<string>();
  for(const value of Array.from<unknown>(input["files"])){
    const file=record(value,"staged file evidence");exactKeys(file,["to","bytes","sha256"]);
    const to=text(file["to"],"staged destination");
    if(!to.startsWith("/workspace/")||to.includes("\\")||to.includes("%")||to.slice(1).split("/").some(part=>part===""||part==="."||part==="..")||destinations.has(to))invalid();
    destinations.add(to);integer(file["bytes"],"staged bytes",0,16*1024**2);decodeSHA256(file["sha256"],"staged digest");
  }
  return {verificationSHA256:decodeSHA256(input["verificationSHA256"],"verification evidence digest")};
}
function invalid():never {throw new VMError("PROTOCOL_ERROR","Snapshot report is invalid");}

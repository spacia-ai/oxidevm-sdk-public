import {expect,it} from "vitest";
import {decodeSnapshotTestReport,SNAPSHOT_CHECKS} from "./snapshot-reports.js";
const report={schemaVersion:1,result:"passed",name:"ready",mode:"userspace",bundleSHA256:null,snapshotManifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32),
  snapshot:{id:"123e4567-e89b-42d3-a456-426614174000",kind:"shipped"},sdkVersion:"0.1.0-alpha.32",engineReleaseId:"ef".repeat(32),
  browser:{name:"chromium",version:"149"},verifier:{source:"bundled",sha256:"00".repeat(32)}};
it("reports_require_exact_complete_noncontradictory_checks",()=>{
  const checks=SNAPSHOT_CHECKS.map(check=>({check,status:"passed"}));
  expect(decodeSnapshotTestReport({...report,checks}).result).toBe("passed");
  expect(()=>decodeSnapshotTestReport({...report,checks:checks.slice(1)})).toThrow();
  expect(()=>decodeSnapshotTestReport({...report,checks,result:"failed"})).toThrow();
  expect(()=>decodeSnapshotTestReport({...report,checks,extra:1})).toThrow();
});

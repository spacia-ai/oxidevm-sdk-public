import {expect,it} from "vitest";
import {decodeAuthoringReceipt,encodeAuthoringReceipt,snapshotData} from "./snapshot-authoring-receipt.js";
it("receipt_rejects_cycles_nonfinite_extra_fields_and_oversize",()=>{
  const receipt={format:"oxidevm-snapshot-authoring",schemaVersion:1,data:{token:"proof"},processes:[{name:"shell",pid:1,snapshotKey:"process:1",kind:"terminal"}]} as const;
  expect(decodeAuthoringReceipt(JSON.parse(new TextDecoder().decode(encodeAuthoringReceipt(receipt))))).toEqual(receipt);
  expect(()=>decodeAuthoringReceipt({...receipt,extra:1})).toThrow();
  expect(()=>snapshotData({bad:Number.NaN})).toThrow();
  const cyclic:Record<string,unknown>={};cyclic["self"]=cyclic;
  expect(()=>snapshotData(cyclic)).toThrow();
  expect(()=>encodeAuthoringReceipt({...receipt,data:"x".repeat(1024**2)})).toThrow();
});

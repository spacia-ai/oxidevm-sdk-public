import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { record, string, integer } from "../decode.js";
import { decodeRelayFailure } from "../relay-errors.js";
import { decodeRelayFrame, encodeRelayFrame } from "./relay-wire.js";
const input: unknown = JSON.parse(readFileSync(new URL("./fixtures/relay-v2.json",import.meta.url),"utf8"));
if(!Array.isArray(input))throw new Error("Invalid conformance vectors");
for(const value of input){
  const row=record(value,"relay conformance vector");
  const name=string(row["name"],"vector name");
  test(`shared Rust/TypeScript relay vector: ${name}`,()=>{
    const hex=string(row["hex"],"vector bytes");if(!/^(?:[a-f0-9]{2})*$/.test(hex))throw new Error("Invalid fixture bytes");
    const bytes=new Uint8Array(hex.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=Number.parseInt(hex.slice(i*2,i*2+2),16);
    const session=BigInt(string(row["session"],"fixture session"));
    if(row["reason"]!==undefined){const reason=decodeRelayFailure(row["reason"]);expect(()=>decodeRelayFrame(bytes.buffer,session)).toThrow();try{decodeRelayFrame(bytes.buffer,session);}catch(error:unknown){expect(error).toMatchObject({detail:{reason}});}}
    else {const frame=decodeRelayFrame(bytes.buffer,session);expect(frame.kind).toBe(integer(row["kind"],"fixture kind"));expect(new Uint8Array(encodeRelayFrame(frame))).toEqual(bytes);}
  });
}
test("outgoing frame identities never wrap to another session or sequence", () => {
  const frame = {kind:3,session:1n,stream:1n,sequence:0n,window:0,payload:new Uint8Array([1])};
  for (const field of ["session","stream","sequence"] as const) {
    for (const value of [-1n, 0x10000000000000000n]) expect(() => encodeRelayFrame({...frame,[field]:value})).toThrow();
  }
});

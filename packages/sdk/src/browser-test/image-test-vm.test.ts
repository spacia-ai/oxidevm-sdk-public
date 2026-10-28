import {generateKeyPairSync} from "node:crypto";
import {expect,it} from "vitest";
import {decodePublicVMOptions} from "../vm-options.js";
import {imageTestVMOptions} from "./image-test-vm.js";

const publicKey=generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).toString("base64");
const image={manifestUrl:"/image.json",manifestSHA256:"ab".repeat(32),trust:{algorithm:"Ed25519" as const,keyId:"test",publicKey}};

it("tests a Userspace image without the hosted acceleration assets a local runtime lacks",()=>{
  const options=imageTestVMOptions("userspace",image,"image_test_a",new AbortController().signal);
  expect(options).toMatchObject({mode:"userspace",commandInterceptors:"off",workspaceId:"image_test_a"});
  expect(decodePublicVMOptions(options)).toMatchObject({mode:"userspace",acceleration:"off"});
});

it("opens a System image test without resuming an earlier workspace",()=>{
  const options=imageTestVMOptions("system",image,"image_test_b",new AbortController().signal);
  expect(options).toMatchObject({mode:"system",restorePoint:"none",workspaceId:"image_test_b"});
  expect(options).not.toHaveProperty("acceleration");
});

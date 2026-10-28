import {mkdtemp,mkdir,writeFile,rm,readFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {request} from "node:http";
import {expect,it} from "vitest";
import {startSnapshotServer} from "./snapshot-server.js";
const identity={version:1,buildId:"123e4567-e89b-42d3-a456-426614174000",token:"a".repeat(64)} as const;
it("server_rejects_bad_host_origin_token_sequence_and_private_paths_and_bounds_upload",async()=>{
  const root=await mkdtemp(join(tmpdir(),"oxidevm-server-"));
  await mkdir(join(root,"assets"));await writeFile(join(root,"assets","client.js"),"export {}");
  await writeFile(join(root,"assets","headers.json"),"{}");
  await writeFile(join(root,"key.pem"),"private");
  const backupPath=join(root,"backup.oxvm");
  const server=await startSnapshotServer({identity,configuration:{probe:true},backupPath,browserDir:join(root,"assets"),engineDir:join(root,"assets"),previewDir:join(root,"assets"),files:new Map()});
  const send=(data:unknown)=>fetch(`${server.origin}/transport`,{method:"POST",headers:{"Origin":server.origin,"Content-Type":"application/json"},body:JSON.stringify(data)});
  try{
    expect((await fetch(`${server.origin}/key.pem`)).status).toBe(404);
    const badHost=await new Promise<number>((resolve,reject)=>{const connection=request(`${server.origin}/fixture.json`,{headers:{Host:"evil.test"}},response=>{resolve(response.statusCode??0);response.resume();});connection.on("error",reject);connection.end();});
    expect(badHost).toBe(404);
    expect((await send({...identity,sequence:1,type:"upload-begin",bytes:3})).status).toBe(200);
    expect((await send({...identity,sequence:1,type:"upload-begin",bytes:3})).status).toBe(404);
    expect((await fetch(`${server.origin}/upload`,{method:"POST",headers:{"Origin":server.origin,"Authorization":`Bearer ${identity.token}`,"X-OxideVM-Sequence":"2","X-OxideVM-Offset":"0"},body:new Uint8Array([1,2,3])})).status).toBe(200);
    expect((await send({...identity,sequence:3,type:"upload-end"})).status).toBe(200);
    expect(await readFile(backupPath)).toEqual(Buffer.from([1,2,3]));
  }finally{await server.close();await rm(root,{recursive:true,force:true});}
});

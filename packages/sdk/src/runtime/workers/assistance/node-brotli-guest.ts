import { nativeGuestArguments, nativeGuestFrames } from "./native-guest.ts";

/** The managed guest's original Node owns Brotli. Data and control acknowledgements
 * use separate bounded pipes, so paused output does not hide errors or completed writes. */
export const brotliGuestSource = String.raw`
'use strict';
const zlib = require('node:zlib');
const {once} = require('node:events');
const MAX_DATA = 65536, MAX_CONTROL = 16384;
function protocol() { return Object.assign(new Error('Invalid Brotli helper request'), {code:'ERR_BROTLI_BRIDGE_PROTOCOL'}); }
function object(value, required, optional=[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocol();
  if (required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key))) throw protocol();
  return value;
}
${nativeGuestFrames}
function event(value) { return send(1,Buffer.from(JSON.stringify(value))); }
function errorEvent(error) {
  return event({kind:'error',code:typeof error.code==='string'?error.code:'ERR_BROTLI_BRIDGE',message:String(error.message).slice(0,8192),
    ...(Number.isInteger(error.errno)?{errno:error.errno}:{})});
}
async function main() {
  const request = object(JSON.parse(process.argv[1]),['mode','options']);
  if (request.mode !== 'compress' && request.mode !== 'decompress') throw protocol();
  const options=object(request.options,[],['chunkSize','params','flush','finishFlush','highWaterMark']);
  for (const name of ['chunkSize','flush','finishFlush','highWaterMark']) {
    if (options[name] !== undefined && (typeof options[name] !== 'number' || !Number.isFinite(options[name]))) throw protocol();
  }
  if (options.params !== undefined) {
    const params=options.params;
    if (params===null || typeof params!=='object' || Array.isArray(params) || Object.keys(params).length>16) throw protocol();
    for (const [key,value] of Object.entries(params)) {
      if (!/^(0|[1-9][0-9]?)$/.test(key) || (typeof value!=='boolean' && (typeof value!=='number'||!Number.isFinite(value)))) throw protocol();
    }
  }
  // Piped output is bounded independently of Webpack's large preferred chunk.
  if (options.chunkSize!==undefined) options.chunkSize=Math.min(options.chunkSize,MAX_DATA);
  const codec=request.mode==='compress'?zlib.createBrotliCompress(options):zlib.createBrotliDecompress(options);
  let failure; let ended=false; let sending=false; let outputBytes=0;
  const waiters=[];
  function drained() {
    if (failure===undefined && (sending || codec.readableLength!==0)) return;
    for (const waiter of waiters.splice(0)) failure===undefined?waiter.resolve():waiter.reject(failure);
  }
  function drainOutput() { return new Promise((resolve,reject)=>{waiters.push({resolve,reject});drained()}); }
  function codecCompletion(invoke) {
    return new Promise((resolve,reject)=>{
      if (failure!==undefined) { reject(failure);return; }
      function done(error) { codec.removeListener('error',failed);error?reject(error):resolve(); }
      function failed(error) { done(error); }
      codec.once('error',failed);
      try { invoke(done); } catch(error) { done(error); }
    });
  }
  codec.on('error',error=>{failure??=error;drained()});
  codec.on('data',chunk=>{
    codec.pause();sending=true;
    (async()=>{
      for (let offset=0;offset<chunk.length;offset+=MAX_DATA) await send(0,chunk.subarray(offset,offset+MAX_DATA));
      outputBytes+=chunk.length;
      if (!Number.isSafeInteger(outputBytes)) throw protocol();
    })().then(()=>{sending=false;codec.resume();drained()},error=>{
      failure??=error;sending=false;codec.destroy(error);process.stdin.destroy();drained();
    });
  });
  const output=once(codec,'end').then(async()=>{await drainOutput();await event({kind:'end'})}).catch(error=>{
    failure??=error;codec.destroy(error);process.stdin.destroy();drained();
  });
  await event({kind:'ready'});
  const input=(async()=>{
    try {
      for await (const [tag,payload] of frames()) {
        if (ended) throw protocol();
        if (tag===0) {
          await codecCompletion(done=>codec.write(payload,done));
          await drainOutput(); await event({kind:'written',count:payload.length,outputBytes});
          continue;
        }
        let request; try { request=JSON.parse(payload.toString('utf8')); } catch { throw protocol(); }
        object(request,['kind'],['operation']);
        if (request.kind==='flush') {
          object(request,['kind','operation']);
          if (!Number.isInteger(request.operation)||request.operation<0||request.operation>3) throw protocol();
          await codecCompletion(done=>codec.flush(request.operation,done));
          await drainOutput(); await event({kind:'flushed',outputBytes});
        } else if (request.kind==='end') {
          object(request,['kind']); ended=true;
          await codecCompletion(done=>codec.end(done));
          await output;
          if (failure!==undefined) throw failure;
          await event({kind:'finished',outputBytes});
        } else throw protocol();
      }
      if (!ended) throw protocol();
    } catch(error) { failure??=error; codec.destroy(error); }
  })();
  await Promise.all([input,output]); codec.destroy();
  if (failure!==undefined) await errorEvent(failure);
  await event({kind:'close',hadError:failure!==undefined});
}
main().catch(async error=>{
  try { await errorEvent(error); await event({kind:'close',hadError:true}); }
  catch { process.exitCode=1; }
}).finally(()=>{process.stdin.destroy();process.stdout.end();process.stderr.end()});
`;

export function brotliGuestArguments(mode: "compress" | "decompress", options: Readonly<Record<string, unknown>>): string[] {
  return nativeGuestArguments(brotliGuestSource, { mode, options });
}

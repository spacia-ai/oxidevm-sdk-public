import { nativeGuestArguments, nativeGuestFrames } from "./native-guest.js";
import { HTTP2_SERVICE_PROTOCOL_VERSION } from "./node-http2-wire.js";

/** Only this fixed program runs in the original guest Node. HTTP/2, TLS and
 * sockets keep their native semantics; application code stays in its worker. */
export const http2GuestSource = String.raw`
'use strict';
const http2 = require('node:http2');
const MAX_DATA = 65536, MAX_CONTROL = 16384;
function protocol() { return Object.assign(new Error('Invalid HTTP/2 bridge record'), {code:'ERR_HTTP2_BRIDGE_PROTOCOL'}); }
function object(value, required, optional=[]) {
  if (!value || typeof value!=='object' || Array.isArray(value) || required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key))) throw protocol();
  return value;
}
function id(value, zero=false) { if(!Number.isSafeInteger(value)||value<(zero?0:1)||value>2147483647)throw protocol(); return value; }
function json(bytes) { try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw protocol();} }
${nativeGuestFrames}
let events=Promise.resolve(), queued=0;
function event(value) {
  if(++queued>256)throw protocol();
  const next=events.then(()=>send(1,Buffer.from(JSON.stringify(value)))).finally(()=>{queued--;});events=next;return next;
}
const sessions=new Map(), pending=new Set(); let server, nextSession=0, streamCount=0, initialized=false, serverClosed=false, finishing=false;
function errorInfo(error) { return {code:typeof error.code==='string'?error.code:'ERR_HTTP2_BRIDGE',message:String(error.message).slice(0,4096)}; }
function options(value) {
  object(value,[],['ca','key','cert','passphrase','servername','rejectUnauthorized','ALPNProtocols','minVersion','maxVersion','settings','allowHTTP1','host']);
  const output={...value};
  for(const name of ['ca','key','cert']) if(output[name]!==undefined) {
    if(typeof output[name]!=='string'||output[name].length>49152)throw protocol();
    output[name]=Buffer.from(output[name],'base64');
  }
  if(output.passphrase!==undefined&&(typeof output.passphrase!=='string'||output.passphrase.length>4096))throw protocol();
  for(const name of ['servername','host'])if(output[name]!==undefined&&(typeof output[name]!=='string'||output[name].length>4096||output[name].includes('\0')))throw protocol();
  for(const name of ['rejectUnauthorized','allowHTTP1'])if(output[name]!==undefined&&typeof output[name]!=='boolean')throw protocol();
  if(output.ALPNProtocols!==undefined&&(!Array.isArray(output.ALPNProtocols)||output.ALPNProtocols.length>32||output.ALPNProtocols.some(x=>typeof x!=='string'||x.length>255)))throw protocol();
  for(const name of ['minVersion','maxVersion'])if(output[name]!==undefined&&!['TLSv1','TLSv1.1','TLSv1.2','TLSv1.3'].includes(output[name]))throw protocol();
  if(output.settings!==undefined)settings(output.settings);
  return output;
}
function settings(value) {
  object(value,[],['headerTableSize','enablePush','initialWindowSize','maxFrameSize','maxConcurrentStreams','maxHeaderSize','maxHeaderListSize','enableConnectProtocol']);
  for(const [name,item]of Object.entries(value))if(name==='enablePush'||name==='enableConnectProtocol'?typeof item!=='boolean':!Number.isSafeInteger(item)||item<0||item>4294967295)throw protocol();
  return value;
}
function headers(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>128)throw protocol();
  for(const [name,item]of Object.entries(value)) {
    if(!/^:?[!#$%&'*+.^_\x60|~0-9a-z-]+$/.test(name))throw protocol();
    const values=Array.isArray(item)?item:[item];
    if(values.length>128||values.some(v=>typeof v!=='string'&&typeof v!=='number'||typeof v==='string'&&/[\r\n\0]/.test(v)))throw protocol();
  }
  return value;
}
function socketInfo(session) {
  const s=session.socket;
  return {localAddress:s.localAddress,localPort:s.localPort,localFamily:s.localFamily,remoteAddress:s.remoteAddress,remotePort:s.remotePort,remoteFamily:s.remoteFamily,encrypted:!!s.encrypted,authorized:s.authorized??false,alpnProtocol:session.alpnProtocol??false};
}
function begin(request){id(request);if(pending.size>=256||pending.has(request))throw protocol();pending.add(request);}
function complete(value){pending.delete(value.request);void event(value);finish();}
function reply(request,error) { if(request)complete({kind:'reply',request,error:error?errorInfo(error):null}); }
function commandError(value,error) {
  if(value.kind==='settings')complete({kind:'settings-ack',request:id(value.request),error:errorInfo(error),settings:{},duration:0});
  else if(value.kind==='ping')complete({kind:'ping-ack',request:id(value.request),error:errorInfo(error),data:'',duration:0});
  else reply(value.request,error);
}
function finish() {
  if(finishing||sessions.size!==0||pending.size!==0||server&&!serverClosed)return;
  finishing=true;
  void event({kind:'done'}).finally(()=>{process.stdin.destroy();});
}
function retireSession(state) {
  if(!state.closed||state.streams.size!==0)return;
  sessions.delete(state.key); void event({kind:'session-close',session:state.key}); finish();
}
function streamProgress(state) {
  if(state.retired)return;
  if(state.ended&&!state.inflight&&!state.endSent){state.endSent=true;void event({kind:'end',session:state.session.key,stream:state.key});}
  if(state.closed&&!state.inflight&&(state.stream.readableLength===0||state.forced)) {
    state.retired=true;
    state.session.streams.delete(state.key);streamCount--;
    void event({kind:'stream-close',session:state.session.key,stream:state.key,rstCode:state.stream.rstCode});retireSession(state.session);
  }
}
function pump(state) {
  if(!state.credit||state.inflight||state.retired||state.forced)return;
  const bytes=state.stream.read(Math.min(state.stream.readableLength,MAX_DATA-8));if(!bytes)return;
  state.credit=false;state.inflight=true;
  const payload=Buffer.allocUnsafe(bytes.length+8);payload.writeUInt32BE(state.session.key,0);payload.writeUInt32BE(state.key,4);bytes.copy(payload,8);
  void send(0,payload).catch(error=>state.stream.destroy(error));
}
function addStream(session,stream,key) {
  if(streamCount>=128){stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);throw Object.assign(new Error('HTTP/2 bridge stream limit'),{code:'ERR_HTTP2_OUT_OF_STREAMS'});}
  const state={session,stream,key,credit:false,inflight:false,ended:false,endSent:false,closed:false,forced:false,retired:false};session.streams.set(key,state);streamCount++;
  const record=(kind,more={})=>event({kind,session:session.key,stream:key,...more});
  stream.on('readable',()=>pump(state));
  stream.on('end',()=>{state.ended=true;streamProgress(state);});
  stream.on('close',()=>{state.closed=true;streamProgress(state);});
  stream.on('error',error=>{state.forced=true;void record('stream-error',errorInfo(error));});
  for(const kind of ['aborted','wantTrailers','timeout'])stream.on(kind,()=>{void record(kind);});
  for(const kind of ['response','headers','trailers'])stream.on(kind,(values,flags,raw)=>{void record(kind,{headers:values,flags,rawHeaders:raw??[]});});
  stream.on('ready',()=>{void record('stream-ready',{id:stream.id});});
  return state;
}
function addSession(session,key,client) {
  if(sessions.size>=64){session.destroy();throw Object.assign(new Error('HTTP/2 bridge session limit'),{code:'ERR_HTTP2_OUT_OF_SESSIONS'});}
  const state={session,key,streams:new Map(),closed:false};sessions.set(key,state);
  const record=(kind,more={})=>event({kind,session:key,...more});
  session.on('error',error=>{void record('session-error',errorInfo(error));});
  session.on('close',()=>{state.closed=true;retireSession(state);});
  session.on('timeout',()=>{void record('session-timeout');});
  for(const kind of ['localSettings','remoteSettings'])session.on(kind,value=>{void record(kind,{settings:value});});
  session.on('goaway',(code,lastStreamID,data)=>{void record('goaway',{code,lastStreamID,data:data?data.toString('base64'):''});});
  if(client)session.on('connect',()=>{void record('connect',{socket:socketInfo(session)});});
  else void record('session',{socket:socketInfo(session)});
  session.on('stream',(stream,values,flags,raw)=>{
    try{addStream(state,stream,stream.id);void record('stream',{stream:stream.id,id:stream.id,headers:values,flags,rawHeaders:raw??[]});}
    catch(error){stream.destroy(error);}
  });
  return state;
}
function initialize(value) {
  object(value,['version','role','options'],['authority','listen']);if(value.version!==${HTTP2_SERVICE_PROTOCOL_VERSION})throw protocol();
  const opts=options(value.options);
  if(value.role==='client') {
    if(typeof value.authority!=='string'||value.authority.length>4096||value.listen!==undefined)throw protocol();
    addSession(http2.connect(value.authority,opts),1,true);
  } else if(value.role==='server'||value.role==='secure-server') {
    if(value.authority!==undefined)throw protocol();
    const listen=object(value.listen,['port','host','backlog']);
    if(!Number.isSafeInteger(listen.port)||listen.port<0||listen.port>65535||typeof listen.host!=='string'||listen.host.length>4096||!Number.isSafeInteger(listen.backlog)||listen.backlog<1||listen.backlog>4096)throw protocol();
    server=value.role==='server'?http2.createServer(opts):http2.createSecureServer(opts);
    server.on('session',session=>{addSession(session,++nextSession,false);});
    server.on('error',error=>{void event({kind:'server-error',...errorInfo(error)});if(!server.listening){serverClosed=true;finish();}});
    server.on('timeout',()=>{void event({kind:'server-timeout'});});
    server.on('close',()=>{serverClosed=true;void event({kind:'server-close'});finish();});
    server.listen(listen.port,listen.host,listen.backlog,()=>{void event({kind:'listening',address:server.address()});});
  } else throw protocol();
}
async function command(value) {
  const kind=value.kind;
  if(kind==='server-close'){object(value,['kind']);server.close();return;}
  if(kind==='server-timeout'){object(value,['kind','duration']);server.setTimeout(value.duration);return;}
  const s=sessions.get(id(value.session));if(!s){if(value.request)commandError(value,Object.assign(new Error('Closed HTTP/2 session'),{code:'ERR_HTTP2_INVALID_SESSION'}));return;}
  const session=s.session;
  if(kind==='request') {
    object(value,['kind','session','stream','headers','options']);id(value.stream);if(s.streams.has(value.stream))throw protocol();
    object(value.options,[],['endStream','waitForTrailers']);for(const v of Object.values(value.options))if(typeof v!=='boolean')throw protocol();
    const stream=session.request(headers(value.headers),value.options);addStream(s,stream,value.stream);
    if(stream.id!==undefined)void event({kind:'stream-ready',session:s.key,stream:value.stream,id:stream.id});return;
  }
  if(kind==='session-close'){object(value,['kind','session']);session.close();return;}
  if(kind==='session-destroy'){object(value,['kind','session','code']);for(const state of s.streams.values())state.forced=true;session.destroy(undefined,id(value.code,true));return;}
  if(kind==='session-timeout'){object(value,['kind','session','duration']);session.setTimeout(value.duration);return;}
  if(kind==='settings'){object(value,['kind','session','request','settings']);session.settings(settings(value.settings),(error,result,duration)=>{complete({kind:'settings-ack',request:id(value.request),error:error?errorInfo(error):null,settings:result??{},duration:duration??0});});return;}
  if(kind==='ping'){object(value,['kind','session','request','data']);if(typeof value.data!=='string'||Buffer.from(value.data,'base64').length!==8)throw protocol();session.ping(Buffer.from(value.data,'base64'),(error,duration,data)=>{complete({kind:'ping-ack',request:id(value.request),error:error?errorInfo(error):null,duration:duration??0,data:data?data.toString('base64'):''});});return;}
  if(kind==='goaway'){object(value,['kind','session','code','lastStreamID','data']);if(typeof value.data!=='string')throw protocol();session.goaway(id(value.code,true),id(value.lastStreamID,true),Buffer.from(value.data,'base64'));return;}
  const state=s.streams.get(id(value.stream));if(!state){reply(value.request,Object.assign(new Error('Closed HTTP/2 stream'),{code:'ERR_HTTP2_INVALID_STREAM'}));return;}
  const stream=state.stream;
  if(kind==='read'){object(value,['kind','session','stream']);state.inflight=false;state.credit=true;pump(state);streamProgress(state);}
  else if(kind==='respond'){object(value,['kind','session','stream','headers','options','request']);object(value.options,[],['endStream','waitForTrailers']);stream.respond(headers(value.headers),value.options);reply(id(value.request));}
  else if(kind==='trailers'){object(value,['kind','session','stream','headers','request']);stream.sendTrailers(headers(value.headers));reply(id(value.request));}
  else if(kind==='additional-headers'){object(value,['kind','session','stream','headers','request']);stream.additionalHeaders(headers(value.headers));reply(id(value.request));}
  else if(kind==='end'){object(value,['kind','session','stream','request']);if(stream.writableFinished)reply(id(value.request));else stream.end(error=>reply(id(value.request),error));}
  else if(kind==='stream-close'){object(value,['kind','session','stream','code']);state.forced=true;stream.close(id(value.code,true));streamProgress(state);}
  else if(kind==='stream-timeout'){object(value,['kind','session','stream','duration']);stream.setTimeout(value.duration);}
  else throw protocol();
}
async function main() {
  for await(const [tag,payload]of frames()) {
    if(!initialized){if(tag!==0)throw protocol();initialize(json(payload));initialized=true;continue;}
    if(tag===1){
      const value=object(json(payload),['kind'],['session','stream','request','headers','options','code','duration','settings','data','lastStreamID']);
      if(value.request!==undefined)begin(value.request);
      try{await command(value);}catch(error){if(value.request&&error.code!=='ERR_HTTP2_BRIDGE_PROTOCOL')commandError(value,error);else throw error;}
      continue;
    }
    if(payload.length<=12)throw protocol();
    const session=id(payload.readUInt32BE(0)),stream=id(payload.readUInt32BE(4)),request=id(payload.readUInt32BE(8));
    begin(request);
    const target=sessions.get(session)?.streams.get(stream)?.stream;
    if(!target){reply(request,Object.assign(new Error('Closed HTTP/2 stream'),{code:'ERR_HTTP2_INVALID_STREAM'}));continue;}
    target.write(payload.subarray(12),error=>reply(request,error));
  }
}
main().catch(error=>{if(!finishing)void event({kind:'fatal',...errorInfo(error)});}).finally(()=>{
  for(const state of sessions.values()){for(const stream of state.streams.values())stream.forced=true;state.session.destroy();}
  if(server&&!serverClosed){server.close();serverClosed=true;}
  void events.finally(()=>{process.stdin.destroy();process.stdout.end();process.stderr.end();});
});
`;

/** Private keys and other options travel on framed stdin, never in argv. */
export function http2GuestArguments(): string[] { return nativeGuestArguments(http2GuestSource, {}); }

import { nativeGuestFrames, nativeGuestArguments } from "./native-guest.ts";

/** Runs only in the managed guest's original Node. TLS, trust roots and network
 * access remain Linux-owned. Each write is acknowledged after the TLS stream's
 * write callback; both directions stop reading while their destination blocks. */
export const tlsGuestSource = String.raw`
'use strict';
const tls = require('node:tls');
const { once } = require('node:events');
const MAX_DATA = 65536;
const MAX_CONTROL = 16384;
function protocol() {
  return Object.assign(new Error('Invalid TLS bridge frame'), { code: 'ERR_TLS_BRIDGE_PROTOCOL' });
}
function object(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocol();
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw protocol();
  return value;
}
${nativeGuestFrames}
function event(value) { return send(1, Buffer.from(JSON.stringify(value))); }
async function main() {
  const options = object(JSON.parse(process.argv[1]), ['host', 'port'], ['servername', 'ca', 'rejectUnauthorized', 'ALPNProtocols', 'minVersion', 'maxVersion']);
  if (typeof options.host !== 'string' || options.host.length > 4096 || options.host.includes('\0') || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw protocol();
  if (options.ca !== undefined && (typeof options.ca !== 'string' || Buffer.byteLength(options.ca) > 65536)) throw protocol();
  if (options.servername !== undefined && (typeof options.servername !== 'string' || options.servername.length > 4096 || options.servername.includes('\0'))) throw protocol();
  if (options.rejectUnauthorized !== undefined && typeof options.rejectUnauthorized !== 'boolean') throw protocol();
  if (options.ALPNProtocols !== undefined && (!Array.isArray(options.ALPNProtocols) || options.ALPNProtocols.length > 32 || options.ALPNProtocols.some(value => typeof value !== 'string' || Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > 255))) throw protocol();
  for (const key of ['minVersion', 'maxVersion']) if (options[key] !== undefined && !['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'].includes(options[key])) throw protocol();
  const socket = tls.connect(options);
  const address = () => ({ localAddress: socket.localAddress, localPort: socket.localPort, localFamily: socket.localFamily, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, remoteFamily: socket.remoteFamily });
  let connected = Promise.resolve(); let finished = Promise.resolve();
  socket.once('finish', () => { finished = event({ kind: 'finished' }); void finished.catch(error => socket.destroy(error)); });
  socket.once('connect', () => { connected = event({ kind: 'connect', ...address() }); void connected.catch(error => socket.destroy(error)); });
  let failure; let stopping = false; let ended = false; let timeoutPending = false;
  socket.on('error', error => { failure ??= error; });
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.on('timeout', () => {
    if (timeoutPending || stopping) return;
    timeoutPending = true;
    event({ kind: 'timeout' }).catch(error => { failure ??= error; socket.destroy(error); }).finally(() => { timeoutPending = false; });
  });
  const input = (async () => {
    try {
      for await (const [tag, payload] of frames()) {
        if (ended) throw protocol();
        if (tag === 0) {
          await new Promise((resolve, reject) => socket.write(payload, error => error ? reject(error) : resolve()));
          await event({ kind: 'written', count: payload.length });
          continue;
        }
        let value; try { value = JSON.parse(payload.toString('utf8')); } catch { throw protocol(); }
        object(value, ['kind'], ['enabled', 'delay', 'duration']);
        if (value.kind === 'end') {
          object(value, ['kind']); ended = true;
          await new Promise((resolve, reject) => socket.end(error => error ? reject(error) : resolve()));
        } else if (value.kind === 'no-delay') {
          object(value, ['kind', 'enabled']); if (typeof value.enabled !== 'boolean') throw protocol();
          socket.setNoDelay(value.enabled);
        } else if (value.kind === 'keep-alive') {
          object(value, ['kind', 'enabled', 'delay']);
          if (typeof value.enabled !== 'boolean' || typeof value.delay !== 'number' || !Number.isFinite(value.delay)) throw protocol();
          socket.setKeepAlive(value.enabled, value.delay);
        } else if (value.kind === 'timeout') {
          object(value, ['kind', 'duration']);
          if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0) throw protocol();
          socket.setTimeout(value.duration);
        } else if (value.kind === 'destroy') {
          object(value, ['kind']); stopping = true; socket.destroy(); break;
        } else throw protocol();
      }
      if (!ended && !stopping && !socket.readableEnded) throw protocol();
    } catch (error) { if (!stopping) { failure ??= error; socket.destroy(error); } }
  })();
  try {
    await once(socket, 'secureConnect');
    await connected;
    await event({ kind: 'secure', authorized: socket.authorized, authorizationError: socket.authorizationError ?? null,
      servername: socket.servername ?? options.servername ?? null, alpnProtocol: socket.alpnProtocol,
      protocol: socket.getProtocol(), cipher: socket.getCipher(),
      ...address() });
    for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
      for (let offset = 0; offset < chunk.length; offset += MAX_DATA) await send(0, chunk.subarray(offset, offset + MAX_DATA));
    }
    if (!stopping) {
      await event({ kind: 'end' });
      if (!socket.writableFinished) await new Promise((resolve, reject) => socket.end(error => error ? reject(error) : resolve()));
    }
  } catch (error) { if (!stopping) failure ??= error; }
  finally { stopping = true; socket.destroy(); process.stdin.destroy(); }
  await input; await closed; await finished;
  if (failure) await event({ kind: 'error', code: typeof failure.code === 'string' ? failure.code : 'ERR_TLS_BRIDGE', message: String(failure.message).slice(0, 8192) });
  await event({ kind: 'close', hadError: failure !== undefined });
}
main().catch(async error => {
  await event({ kind: 'error', code: typeof error.code === 'string' ? error.code : 'ERR_TLS_BRIDGE_PROTOCOL', message: String(error.message).slice(0, 8192) });
  await event({ kind: 'close', hadError: true });
}).finally(() => { process.stdin.destroy(); process.stdout.end(); process.stderr.end(); });
`;

/** The existing spawn wire bounds each argument below 4096 UTF-8 bytes. Keep
 * that boundary intact, including for PEM chains and Unicode hostnames. Only
 * this module's constant program is evaluated by the original guest Node. */
export function tlsGuestArguments(options: Readonly<Record<string, unknown>>): string[] {
  return nativeGuestArguments(tlsGuestSource, options);
}

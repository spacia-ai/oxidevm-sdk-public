'use strict';

const assert = require('node:assert/strict');
const native = require('./node_modules/oxidevm-node-api-conformance/conformance.node');

module.exports = async function conformance() {
  assert.deepStrictEqual(process.argv, [process.execPath, '/workspace/swc/build.cjs']);
  assert.strictEqual(native.metadata(), [process.pid, process.ppid, process.getuid(), process.getgid(), process.cwd()].join(':'));
  if (process.env.OXIDEVM_NODE_API_CRASH === '1') native.crash();
  const value = { marker: 'same JavaScript object' };
  assert.strictEqual(native.echo(value), value);
  assert.strictEqual(native.callback(item => native.echo(item), value), value);
  const exception = new Error('callback failure');
  assert.throws(() => native.callback(() => { throw exception; }, value), error => error === exception);
  native.retain(value);
  assert.strictEqual(native.recall(), value);
  native.release();
  const box = new native.Box(value);
  assert.strictEqual(box.value, value);
  globalThis.keepNativeBox = box;
  assert.throws(() => native.fail(), error => error.code === 'E_FIXTURE' && error.message === 'native failure');
  assert.deepStrictEqual(await Promise.all([1, 2, 3, 4].map(() => native.async(Buffer.from('abc')))), ['sum:294', 'sum:294', 'sum:294', 'sum:294']);
  await assert.rejects(native.async(Buffer.alloc(0)), reason => reason === 'sum:0');
  if (process.env.OXIDEVM_NODE_API_UNCAUGHT === '1') {
    if (process.env.OXIDEVM_NODE_API_UNCAUGHT_REENTRY === '1') process.once('uncaughtException', () => native.echo(value));
    await native.async(Buffer.from('throw'));
    await new Promise(() => {});
  }
  let monitored;
  process.once('uncaughtExceptionMonitor', error => { monitored = error; });
  const uncaught = new Promise(resolve => process.once('uncaughtException', (error, origin) => {
    assert.strictEqual(error, monitored);
    assert.strictEqual(error.code, 'E_ASYNC');
    assert.strictEqual(error.message, 'async completion failure');
    assert.strictEqual(origin, 'uncaughtException');
    resolve();
  }));
  assert.strictEqual(await native.async(Buffer.from('throw')), 'sum:564');
  await uncaught;
  assert.strictEqual(native.echo(value), value);
  if (process.env.OXIDEVM_NODE_API_HOLD === '1') await native.async(Buffer.from('hold'));
  process.stdout.write('conformance:ok\n');
};

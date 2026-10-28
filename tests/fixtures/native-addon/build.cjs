'use strict';

const fs = require('node:fs');
const path = require('node:path');
const swc = require('@swc/core');
if (process.env.OXIDEVM_NODE_API_UNSUPPORTED === '1') require('node:tls');

const input = path.join(process.cwd(), 'src');
const output = path.join(process.cwd(), 'dist');
const names = fs.readdirSync(input).filter(name => name.endsWith('.tsx')).sort();
if (names.length !== 20) throw new Error('Expected twenty TSX inputs');
fs.mkdirSync(output, { recursive: true });

function visit(value) {
  if (value === null || typeof value !== 'object') return;
  if (value.type === 'StringLiteral' && value.value === 'original') {
    value.value = 'visited';
    delete value.raw;
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(visit);
    else visit(child);
  }
}

async function build(name) {
  const source = fs.readFileSync(path.join(input, name), 'utf8');
  const ast = swc.parseSync(source, { syntax: 'typescript', tsx: true, target: 'es2022' });
  visit(ast);
  const printed = swc.printSync(ast, { sourceMaps: true, sourceFileName: name });
  const result = await swc.transform(printed.code, {
    filename: name,
    sourceMaps: true,
    inputSourceMap: printed.map,
    jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022', transform: { react: { runtime: 'automatic' } } },
    module: { type: 'commonjs' },
  });
  if (!result.code.includes('visited') || result.code.includes('original')) throw new Error('AST visit was lost');
  if (typeof result.map !== 'string') throw new Error('Missing source map');
  fs.writeFileSync(path.join(output, name + '.js'), result.code);
  fs.writeFileSync(path.join(output, name + '.map'), result.map);
}

async function main() {
  if (process.env.OXIDEVM_NODE_API_CONFORMANCE === '1') await require('./conformance.cjs')();
  for (let offset = 0; offset < names.length; offset += 4) {
    await Promise.all(names.slice(offset, offset + 4).map(build));
  }
  process.stdout.write('built:20 swc:' + swc.version + '\n');
}

main().catch(error => {
  process.stderr.write(String(error.message) + '\n');
  process.exitCode = 1;
});

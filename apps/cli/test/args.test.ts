import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandArgs } from '../src/args.ts';
import { parseKeyValue } from '../src/dotenv.ts';
import { UsageError } from '../src/errors.ts';

test('parseKeyValue splits on the first equals sign only', () => {
  assert.deepEqual(parseKeyValue('DATABASE_URL=postgres://u:p@h/db?sslmode=require'), {
    key: 'DATABASE_URL',
    value: 'postgres://u:p@h/db?sslmode=require',
  });
});

test('parseKeyValue accepts an empty value', () => {
  assert.deepEqual(parseKeyValue('EMPTY='), { key: 'EMPTY', value: '' });
});

test('parseKeyValue rejects arguments without a key or an equals sign', () => {
  assert.throws(() => parseKeyValue('NOEQUALS'), UsageError);
  assert.throws(() => parseKeyValue('=value'), UsageError);
});

test('parseKeyValue rejects invalid variable names', () => {
  assert.throws(() => parseKeyValue('1BAD=x'), /invalid variable name/);
  assert.throws(() => parseKeyValue('BAD-NAME=x'), /invalid variable name/);
});

test('parseCommandArgs collects repeated flags and positionals', () => {
  const args = parseCommandArgs(['svc', '--env', 'A=1', '--env', 'B=2', '--json'], {
    env: { type: 'string', multiple: true },
  });
  assert.deepEqual(args.positionals, ['svc']);
  assert.deepEqual(args.strs('env'), ['A=1', 'B=2']);
  assert.equal(args.bool('json'), true);
  assert.equal(args.bool('no-deploy'), false);
});

test('parseCommandArgs keeps the last value of a single-valued flag', () => {
  const args = parseCommandArgs(['--type', 'web', '--type', 'worker'], { type: { type: 'string' } });
  assert.equal(args.str('type'), 'worker');
});

test('parseCommandArgs parses integers and rejects non-integers', () => {
  const ok = parseCommandArgs(['--instances', '3'], { instances: { type: 'string' } });
  assert.equal(ok.int('instances'), 3);
  const bad = parseCommandArgs(['--instances', 'three'], { instances: { type: 'string' } });
  assert.throws(() => bad.int('instances'), /whole number/);
});

test('parseCommandArgs rejects unknown flags as usage errors', () => {
  assert.throws(() => parseCommandArgs(['--nope']), UsageError);
});

test('parseCommandArgs enforces the positional limit', () => {
  const args = parseCommandArgs(['a', 'b']);
  assert.throws(() => args.maxPositionals(1, 'nav test'), /unexpected argument "b"/);
});

test('parseCommandArgs understands the short help flag', () => {
  assert.equal(parseCommandArgs(['-h']).bool('help'), true);
});

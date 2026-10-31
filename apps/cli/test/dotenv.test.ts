import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv, serializeDotEnv, type EnvPair } from '../src/dotenv.ts';
import { UsageError } from '../src/errors.ts';

test('parses comments, blank lines, export prefixes and spaces around equals', () => {
  const text = [
    '# a comment',
    '',
    'export API_KEY=abc123',
    '  SPACED = value here   # trailing comment',
    'EMPTY=',
    'HASH=abc#def',
  ].join('\n');
  assert.deepEqual(parseDotEnv(text), [
    { key: 'API_KEY', value: 'abc123' },
    { key: 'SPACED', value: 'value here' },
    { key: 'EMPTY', value: '' },
    { key: 'HASH', value: 'abc#def' },
  ]);
});

test('keeps # inside quoted values and ignores the comment after the closing quote', () => {
  const pairs = parseDotEnv('QUOTED="hello # not comment"   # real comment');
  assert.deepEqual(pairs, [{ key: 'QUOTED', value: 'hello # not comment' }]);
});

test('single-quoted values are literal, without escape processing', () => {
  assert.deepEqual(parseDotEnv("SINGLE='no \\n escapes'"), [{ key: 'SINGLE', value: 'no \\n escapes' }]);
});

test('double-quoted values process escapes', () => {
  const pairs = parseDotEnv('ESC="line1\\nline2 \\"q\\" back\\\\slash"');
  assert.deepEqual(pairs, [{ key: 'ESC', value: 'line1\nline2 "q" back\\slash' }]);
});

test('double-quoted values may span multiple lines', () => {
  const pairs = parseDotEnv('PRIVATE_KEY="-----BEGIN-----\nabc\ndef\n-----END-----"\nNEXT=1');
  assert.deepEqual(pairs, [
    { key: 'PRIVATE_KEY', value: '-----BEGIN-----\nabc\ndef\n-----END-----' },
    { key: 'NEXT', value: '1' },
  ]);
});

test('duplicate keys keep the first position and the last value', () => {
  const pairs = parseDotEnv('A=1\nB=2\nA=3');
  assert.deepEqual(pairs, [{ key: 'A', value: '3' }, { key: 'B', value: '2' }]);
});

test('handles CRLF line endings', () => {
  assert.deepEqual(parseDotEnv('A=1\r\nB="x\r\ny"\r\n'), [
    { key: 'A', value: '1' },
    { key: 'B', value: 'x\ny' },
  ]);
});

test('reports an unterminated quote with its line number', () => {
  assert.throws(() => parseDotEnv('OK=1\nBAD="never closed'), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /line 2: unterminated " quote for BAD/);
    return true;
  });
});

test('rejects lines that are not KEY=VALUE', () => {
  assert.throws(() => parseDotEnv('just words'), /line 1: expected KEY=VALUE/);
});

test('serialized values parse back to the same pairs', () => {
  const pairs: EnvPair[] = [
    { key: 'PLAIN', value: 'plain-value_1.2' },
    { key: 'SPACES', value: 'has space' },
    { key: 'QUOTES', value: 'quote"and\\back' },
    { key: 'MULTI', value: 'multi\nline\tvalue' },
    { key: 'EMPTY', value: '' },
    { key: 'HASH', value: 'x#y' },
    { key: 'URL', value: 'postgres://user:p@ss@host:5432/db?sslmode=require' },
  ];
  const text = serializeDotEnv(pairs);
  assert.deepEqual(parseDotEnv(text), pairs);
});

test('serializeDotEnv leaves simple values unquoted', () => {
  assert.equal(serializeDotEnv([{ key: 'A', value: 'simple' }]), 'A=simple\n');
  assert.equal(serializeDotEnv([]), '');
});

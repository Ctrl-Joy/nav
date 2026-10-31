import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorEnabled, durationBetween, formatDuration, kv, paint, relativeTime, sparkline, table, visibleWidth,
} from '../src/output.ts';

const savedNoColor = process.env.NO_COLOR;

beforeEach(() => {
  delete process.env.NO_COLOR;
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
});

test('table aligns columns to the widest cell and pads all but the last column', () => {
  const rendered = table(['name', 'status'], [['web', 'live'], ['worker-long-name', 'failed']]);
  const lines = rendered.split('\n');
  assert.equal(lines[0], `${'NAME'.padEnd(16)}  STATUS`);
  assert.equal(lines[1], `${'web'.padEnd(16)}  live`);
  assert.equal(lines[2], `${'worker-long-name'}  failed`);
});

test('table right-aligns numeric columns when asked', () => {
  const rendered = table(['n', 'label'], [['1', 'a'], ['100', 'b']], { align: ['right', 'left'] });
  assert.deepEqual(rendered.split('\n'), [
    '  N  LABEL',
    '  1  a',
    '100  b',
  ]);
});

test('table measures colored cells by their visible width', () => {
  const colored = '\u001b[32mlive\u001b[0m';
  assert.equal(visibleWidth(colored), 4);
  const rendered = table(['s', 'x'], [[colored, 'a']]);
  const [, row] = rendered.split('\n');
  assert.equal(row, `${colored}  a`);
});

test('table tolerates rows shorter than the header', () => {
  const rendered = table(['a', 'b', 'c'], [['1']]);
  assert.equal(rendered.split('\n')[1], '1');
});

test('kv aligns keys and prints a dash for missing values', () => {
  const rendered = kv([['Name', 'web'], ['Workspace', null]]);
  assert.deepEqual(rendered.split('\n'), [
    'Name       web',
    'Workspace  -',
  ]);
});

test('relativeTime renders past, future and missing times', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(relativeTime('2026-11-01T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-11-01T11:55:00Z', now), '5m ago');
  assert.equal(relativeTime('2026-11-01T09:00:00Z', now), '3h ago');
  assert.equal(relativeTime('2026-10-30T12:00:00Z', now), '2d ago');
  assert.equal(relativeTime('2026-11-01T12:10:00Z', now), 'in 10m');
  assert.equal(relativeTime(null, now), '-');
});

test('sparkline scales values across the bar range', () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline([]), '');
  assert.equal(sparkline([5, 5, 5]), '▄▄▄');
});

test('formatDuration uses ms, seconds, minutes and hours', () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

test('durationBetween returns a dash without a start time', () => {
  assert.equal(durationBetween(null, null), '-');
  assert.equal(durationBetween('2026-11-01T12:00:00Z', '2026-11-01T12:00:03Z'), '3s');
});

test('colors are off when the stream is not a terminal', () => {
  assert.equal(colorEnabled({ isTTY: false }), false);
  assert.equal(paint('x', 'red', { isTTY: false }), 'x');
});

test('colors are off when NO_COLOR is set, and on for a terminal otherwise', () => {
  assert.equal(colorEnabled({ isTTY: true }), true);
  process.env.NO_COLOR = '1';
  assert.equal(colorEnabled({ isTTY: true }), false);
  assert.equal(paint('x', 'red', { isTTY: true }), 'x');
});

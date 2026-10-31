import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, type SSEMessage } from '../src/api.ts';

async function collect(chunks: Array<Uint8Array | string>): Promise<SSEMessage[]> {
  async function* source(): AsyncGenerator<Uint8Array | string> {
    for (const chunk of chunks) yield chunk;
  }
  const messages: SSEMessage[] = [];
  for await (const message of parseSSE(source())) messages.push(message);
  return messages;
}

test('parses named events and their data', async () => {
  const messages = await collect(['event: log\ndata: {"id":1}\n\nevent: end\ndata: {}\n\n']);
  assert.deepEqual(messages, [
    { event: 'log', data: '{"id":1}', id: null },
    { event: 'end', data: '{}', id: null },
  ]);
});

test('reassembles lines split across chunks', async () => {
  const messages = await collect(['event: lo', 'g\nda', 'ta: 1', '\n', '\n']);
  assert.deepEqual(messages, [{ event: 'log', data: '1', id: null }]);
});

test('joins multiple data lines with newlines', async () => {
  const messages = await collect(['data: first\ndata: second\n\n']);
  assert.equal(messages[0]?.data, 'first\nsecond');
});

test('defaults the event name to message and ignores comments and retry', async () => {
  const messages = await collect([': keepalive\n\nretry: 1000\ndata: hi\n\n']);
  assert.deepEqual(messages, [{ event: 'message', data: 'hi', id: null }]);
});

test('accepts CRLF line endings', async () => {
  const messages = await collect(['event: x\r\ndata: y\r\n\r\n']);
  assert.deepEqual(messages, [{ event: 'x', data: 'y', id: null }]);
});

test('skips blocks that carry no data', async () => {
  const messages = await collect(['event: ping\n\ndata: real\n\n']);
  assert.deepEqual(messages, [{ event: 'message', data: 'real', id: null }]);
});

test('discards an event still pending at end of stream', async () => {
  const messages = await collect(['data: complete\n\ndata: partial\n']);
  assert.deepEqual(messages.map((m) => m.data), ['complete']);
});

test('removes exactly one leading space after the colon', async () => {
  const messages = await collect(['data:  two spaces\n\n']);
  assert.equal(messages[0]?.data, ' two spaces');
});

test('treats a field name without a colon as having an empty value', async () => {
  const messages = await collect(['data\n\n']);
  assert.deepEqual(messages, [{ event: 'message', data: '', id: null }]);
});

test('records the id field', async () => {
  const messages = await collect(['id: 42\ndata: x\n\n']);
  assert.equal(messages[0]?.id, '42');
});

test('decodes a UTF-8 sequence split across byte chunks', async () => {
  const bytes = new TextEncoder().encode('data: héllo\n\n');
  const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
  const messages = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
  assert.equal(messages[0]?.data, 'héllo');
});

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

// Reads a line without echoing it.
export async function askSecret(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write(question);
    muted = true;
    const answer = await new Promise<string>((resolve) => rl.question('', resolve));
    muted = false;
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

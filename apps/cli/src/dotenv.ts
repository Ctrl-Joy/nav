import { UsageError } from './errors.ts';

export interface EnvPair {
  key: string;
  value: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

// Parses a KEY=VALUE command-line argument. The value may itself contain "=".
export function parseKeyValue(arg: string): EnvPair {
  const eq = arg.indexOf('=');
  if (eq === -1) throw new UsageError(`expected KEY=VALUE, got "${arg}"`);
  const key = arg.slice(0, eq);
  if (!isValidEnvKey(key)) {
    throw new UsageError(`invalid variable name "${key}"`, 'names use letters, digits and underscores and must not start with a digit');
  }
  return { key, value: arg.slice(eq + 1) };
}

const DOUBLE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function unescapeDouble(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match, code: string) => DOUBLE_ESCAPES[code] ?? code);
}

// Index of the closing quote in s (which starts after the opening quote), or -1.
function findClosingQuote(s: string, quote: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === '"' && ch === '\\') {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

// Parses dotenv text: comments, blank lines, an optional "export" prefix, spaces around "=",
// inline comments after unquoted values, and single, double or backtick quoted values
// (double-quoted values may span lines and use \n \r \t \" \\ escapes). Duplicate keys keep the
// first position and the last value.
export function parseDotEnv(text: string): EnvPair[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const values = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const lineNo = i + 1;
    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    if (eq === -1) throw new UsageError(`line ${lineNo}: expected KEY=VALUE`);
    const key = body.slice(0, eq).trim();
    if (!isValidEnvKey(key)) throw new UsageError(`line ${lineNo}: invalid variable name "${key}"`);
    const rest = body.slice(eq + 1).trimStart();
    const quote = rest.charAt(0);
    let value: string;
    if (quote === '"' || quote === "'" || quote === '`') {
      let acc = rest.slice(1);
      let close = findClosingQuote(acc, quote);
      while (close === -1) {
        i++;
        if (i >= lines.length) throw new UsageError(`line ${lineNo}: unterminated ${quote} quote for ${key}`);
        acc += `\n${lines[i] ?? ''}`;
        close = findClosingQuote(acc, quote);
      }
      const trailing = acc.slice(close + 1).trim();
      if (trailing !== '' && !trailing.startsWith('#')) {
        throw new UsageError(`line ${lineNo}: unexpected text after the closing quote of ${key}`);
      }
      const raw = acc.slice(0, close);
      value = quote === '"' ? unescapeDouble(raw) : raw;
    } else {
      const comment = rest.search(/\s#/);
      const raw = rest.startsWith('#') ? '' : comment === -1 ? rest : rest.slice(0, comment);
      value = raw.trim();
    }
    values.set(key, value);
  }
  return [...values].map(([key, value]) => ({ key, value }));
}

function needsQuotes(value: string): boolean {
  return !/^[A-Za-z0-9_./:@%+,-]*$/.test(value);
}

function quoteDouble(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export function serializeDotEnv(pairs: EnvPair[]): string {
  const lines = pairs.map(({ key, value }) => `${key}=${needsQuotes(value) ? quoteDouble(value) : value}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

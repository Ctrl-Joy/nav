import type { EnvVar } from '@nav/shared';

/** Parse a .env file (KEY=value, `export` prefix, quotes, comments, \n escapes in double quotes). */
export function parseDotenv(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if (q === '"' || q === "'" || q === '`') {
      let body = value.slice(1);
      while (!endsWithQuote(body, q) && i + 1 < lines.length) {
        i++;
        body += '\n' + lines[i];
      }
      value = endsWithQuote(body, q) ? body.trimEnd().slice(0, -1) : body;
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    const existing = out.findIndex((e) => e.key === key);
    if (existing >= 0) out.splice(existing, 1);
    out.push({ key, value });
  }
  return out;
}

function endsWithQuote(body: string, q: string): boolean {
  const t = body.trimEnd();
  return t.length > 0 && t[t.length - 1] === q && t[t.length - 2] !== '\\';
}

export function serializeDotenv(vars: EnvVar[]): string {
  return vars
    .filter((v) => v.key)
    .map((v) => {
      const needsQuotes = /[\s#"'\n]/.test(v.value);
      const value = needsQuotes
        ? `"${v.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
        : v.value;
      return `${v.key}=${value}`;
    })
    .join('\n');
}

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

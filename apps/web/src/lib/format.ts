export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${bytes < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatNumber(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${+(n / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e4) return `${+(n / 1e3).toFixed(digits)}k`;
  if (abs >= 100) return Math.round(n).toLocaleString();
  return `${+n.toFixed(2)}`;
}

export function formatPrice(n: number): string {
  return n === 0 ? '$0' : `$${n}`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

export function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`;
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turn "https://github.com/acme/app.git" into "acme/app". */
export function repoSlug(url: string | null | undefined): string {
  if (!url) return '';
  const m = url.replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/);
  return m?.[1] ?? url;
}

/** Browser-safe slug (mirrors @nav/shared slugify). */
export function hostnameOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

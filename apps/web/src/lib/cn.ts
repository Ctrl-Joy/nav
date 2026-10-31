export type ClassValue = string | false | null | undefined | 0;

/** Tiny className joiner (no dependency). */
export function cn(...values: ClassValue[]): string {
  let out = '';
  for (const v of values) if (v) out += (out ? ' ' : '') + v;
  return out;
}

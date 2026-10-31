// Path pattern matcher for static_routes / static_headers.
//   exact:   /about
//   params:  /blog/:year/:slug        -> { year, slug }
//   splat:   /old/*                   -> { splat }   (also matches /old and /old/)
//            /*                       -> everything
// Destinations substitute :name and :splat.

export type Params = Record<string, string>;
export type Matcher = (path: string) => Params | null;

const cache = new Map<string, Matcher>();

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\\/]/g, '\\$&');
}

export function compilePattern(pattern: string): Matcher {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const names: string[] = [];
  let re = '^';
  let i = 0;
  let src = pattern.startsWith('/') ? pattern : `/${pattern}`;
  let trailingSplat = false;
  if (src.endsWith('/*')) { trailingSplat = true; src = src.slice(0, -2); }
  while (i < src.length) {
    const c = src[i];
    if (c === ':' ) {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (m) {
        names.push(m[1]);
        re += '([^/]+)';
        i += m[0].length;
        continue;
      }
    }
    if (c === '*') {
      names.push('splat');
      re += '(.*)';
      i++;
      continue;
    }
    re += escapeRe(c);
    i++;
  }
  if (trailingSplat) {
    names.push('splat');
    re += '(?:/(.*))?';
  } else if (!src.endsWith('/')) {
    re += '/?';
  }
  re += '$';
  const rx = new RegExp(re);
  const matcher: Matcher = (path) => {
    const m = rx.exec(path);
    if (!m) return null;
    const params: Params = {};
    names.forEach((n, idx) => { params[n] = m[idx + 1] ?? ''; });
    return params;
  };
  if (cache.size > 2000) cache.clear();
  cache.set(pattern, matcher);
  return matcher;
}

export function matchPath(pattern: string, path: string): Params | null {
  return compilePattern(pattern)(path);
}

/** Substitute :name / :splat placeholders. Unknown placeholders are left as-is (e.g. ports in URLs). */
export function applyParams(destination: string, params: Params): string {
  return destination.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name] : whole);
}

export interface RouteRule { type: 'redirect' | 'rewrite'; source: string; destination: string }

export interface RuleMatch { rule: RouteRule; destination: string }

/** First matching rule wins. */
export function matchRules(rules: RouteRule[], path: string): RuleMatch | null {
  for (const rule of rules) {
    if (!rule || typeof rule.source !== 'string' || typeof rule.destination !== 'string') continue;
    const params = matchPath(rule.source, path);
    if (params) return { rule, destination: applyParams(rule.destination, params) };
  }
  return null;
}

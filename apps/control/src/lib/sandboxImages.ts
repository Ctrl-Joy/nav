// Which images a sandbox may run. A sandbox image is always pulled from its registry (never taken from the node's
// local image cache, which also holds other tenants' builds), so only public images on an allowlist are accepted:
// the platform defaults (SANDBOX_IMAGES) plus repository prefixes an operator lists in NAV_SANDBOX_IMAGES
// (comma-separated, e.g. "python,ghcr.io/acme/"). NAV's own build tags (nav/...) and bare image IDs never qualify.
import { SANDBOX_IMAGES } from '@nav/shared';

/** Drops the implicit Docker Hub registry and library/ namespace: docker.io/library/python:3 -> python:3. */
function canonical(ref: string): string {
  return ref.trim().toLowerCase().replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '');
}

export function sandboxImagePrefixes(env = process.env.NAV_SANDBOX_IMAGES): string[] {
  return (env ?? '').split(',').map((p) => canonical(p)).filter(Boolean);
}

/**
 * The rules every node enforces whatever the allowlist says: a reference must name a repository (not an image ID
 * or a bare digest, which only identify something in the local cache), and never NAV's own build images.
 */
export function forbiddenImageReason(ref: string): string | null {
  const r = canonical(ref);
  if (!r || !/^[a-z0-9][a-z0-9._\-/:@]*$/.test(r)) return 'not a valid image reference';
  if (r.startsWith('sha256:') || /^[0-9a-f]{12,64}$/.test(r)) return 'image IDs and bare digests are not allowed; name a repository';
  if (r.startsWith('nav/') || /^(localhost|127\.)/.test(r)) return 'NAV build images and local registries cannot be used for sandboxes';
  return null;
}

/** Null when the reference may be used for a sandbox, otherwise why not. */
export function sandboxImageError(ref: string, prefixes = sandboxImagePrefixes()): string | null {
  const forbidden = forbiddenImageReason(ref);
  if (forbidden) return forbidden;
  const r = canonical(ref);
  const repo = r.split('@')[0];
  if (Object.values(SANDBOX_IMAGES).some((d) => canonical(d) === r || canonical(d) === repo)) return null;
  const ok = prefixes.some((p) => {
    if (p.endsWith('/') || p.endsWith(':')) return repo.startsWith(p);
    // A bare repository prefix matches itself and its tags/digests, never a longer name (python != pythonx).
    return repo === p || repo.startsWith(`${p}:`) || repo.startsWith(`${p}/`);
  });
  return ok ? null : `image is not on this platform's sandbox allowlist (defaults: ${Object.values(SANDBOX_IMAGES).join(', ')}; operators add more with NAV_SANDBOX_IMAGES)`;
}

/** The repository part of a reference, without tag or digest: ghcr.io:443/a/b:1@sha256:.. -> ghcr.io:443/a/b. */
export function imageRepository(ref: string): string {
  const noDigest = ref.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

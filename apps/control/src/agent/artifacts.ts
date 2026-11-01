// Moves builds between nodes: publish to the store after a build, localize before running, retire when pruned.
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { deleteStoredArtifact, downloadArtifact, fetchDir, publishDir, relocate, uploadArtifact } from '@nav/shared/artifacts';
import { config } from '@nav/shared/config';
import { q } from '../db/pool.ts';
import { enqueue } from '../lib/core.ts';
import { NODE_TTL_S } from './cluster.ts';
import { registryAuth, type Ctx } from './handlers.ts';
import type { Artifact } from './runtime/types.ts';

const artifactsDir = path.join(config.dataDir, 'artifacts');

/** Images built by NAV live only where they were built; registry images can be pulled by any node. */
const isBuiltImage = (a: Artifact) => a.kind === 'image' && a.ref.startsWith('nav/');
const dirKey = (a: Artifact & { kind: 'dir' }) => a.store?.key ?? path.basename(a.root);

async function clusterSize(): Promise<number> {
  const r = await q('SELECT count(*)::int AS n FROM nodes WHERE last_heartbeat > now() - make_interval(secs => $1)', [NODE_TTL_S]);
  return r[0].n;
}

/** Records the builder and, when other nodes may run it, uploads the build to the store. */
export async function publish(ctx: Ctx, artifact: Artifact, key: string, log: (l: string) => void): Promise<Artifact> {
  const placed: Artifact = { ...artifact, nodeId: ctx.nodeId };
  if (artifact.kind === 'image' && !isBuiltImage(artifact)) return placed;
  if (config.artifactUpload === 'never' || (config.artifactUpload === 'auto' && (await clusterSize()) < 2)) return placed;
  log('==> Uploading build to the artifact store');
  const started = Date.now();
  const store = artifact.kind === 'dir'
    ? await publishDir(key, artifact.root)
    : await uploadArtifact(key, (await ctx.driver.saveImage!(artifact.ref)).pipe(createGzip({ level: 1 })));
  log(`==> Uploaded ${(store.size / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { ...placed, store };
}

/** Returns the artifact as it exists on this node, fetching it from the store (or registry) first if needed. */
export async function localize(ctx: Ctx, artifact: Artifact, log: (l: string) => void = () => {}): Promise<Artifact> {
  if (artifact.kind === 'image') {
    if (!ctx.driver.hasImage || (await ctx.driver.hasImage(artifact.ref))) return artifact;
    if (!isBuiltImage(artifact)) {
      await ctx.driver.pullImage!(artifact.ref, log, await registryAuth(artifact.registryCredentialId));
      return artifact;
    }
    if (!artifact.store) throw new Error(`image ${artifact.ref} exists only on node ${artifact.nodeId ?? 'unknown'} and was not uploaded`);
    log('==> Fetching image from the artifact store');
    const file = path.join(config.dataDir, 'tmp', `${artifact.store.key}.${randomBytes(4).toString('hex')}.tgz`);
    try {
      await downloadArtifact(artifact.store, file);
      await ctx.driver.loadImage!(createReadStream(file).pipe(createGunzip()));
    } finally {
      await rm(file, { force: true });
    }
    return artifact;
  }
  const local = path.join(artifactsDir, dirKey(artifact));
  if (existsSync(local)) return path.resolve(artifact.root) === local ? artifact : relocate(artifact, local);
  if (!artifact.store) throw new Error(`build exists only on node ${artifact.nodeId ?? 'unknown'} and was not uploaded`);
  log('==> Fetching build from the artifact store');
  return relocate(artifact, await fetchDir(artifact.store, artifactsDir));
}

/** Removes this node's copy of an artifact. */
export async function removeLocal(ctx: Ctx, artifact: Artifact): Promise<void> {
  if (artifact.kind === 'dir') await rm(path.join(artifactsDir, dirKey(artifact)), { recursive: true, force: true }).catch(() => {});
  else await ctx.driver.removeArtifact(artifact);
}

/** Deletes an artifact everywhere: the store copy now, each node's copy through a node-targeted cleanup job. */
export async function retire(artifacts: Artifact[], serviceId?: string): Promise<void> {
  if (!artifacts.length && !serviceId) return;
  for (const a of artifacts) if (a.store) await deleteStoredArtifact(a.store.key);
  const nodes = await q('SELECT id FROM nodes WHERE last_heartbeat > now() - interval \'1 day\'');
  for (const n of nodes) await enqueue('node_cleanup', { artifacts, serviceId: serviceId ?? null }, { nodeId: n.id, maxAttempts: 3 });
}

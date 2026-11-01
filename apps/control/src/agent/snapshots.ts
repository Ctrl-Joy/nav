// Disk snapshots: a service's persistent disk is archived into the artifact store (so a snapshot outlives the node)
// and can be restored in place. Both jobs run on the node that holds the disk.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { downloadArtifact, extractInto, publishDir, uploadArtifact } from '@nav/shared/artifacts';
import { config } from '@nav/shared/config';
import { one, q } from '../db/pool.ts';
import { changed, enqueue } from '../lib/core.ts';
import { activeInstances, stopInstances } from './cluster.ts';
import type { Ctx } from './handlers.ts';
import { shipLog } from './util.ts';

const diskDir = (serviceId: string, name: string) => path.join(config.dataDir, 'disks', serviceId, name);

async function docker() {
  const Docker = (await import('dockerode')).default;
  return new Docker();
}

export async function handleDiskSnapshot(ctx: Ctx, payload: { snapshotId: string }): Promise<void> {
  const snap = await one('SELECT * FROM disk_snapshots WHERE id = $1', [payload.snapshotId]);
  const svc = snap && await one('SELECT * FROM services WHERE id = $1', [snap.service_id]);
  if (!snap || !svc?.disk || snap.status !== 'pending') return;
  const log = (l: string, level = 'info') => shipLog({ serviceId: svc.id, stream: 'system' }, l, level);
  try {
    let store;
    if (ctx.driver.name === 'docker') {
      // Archive from a running instance on this node, which has the volume mounted.
      const entry = [...ctx.instances.entries.values()].find((e) => e.serviceId === svc.id && e.handle && !e.stopping);
      if (!entry) throw new Error('the service must be running on this node to snapshot its disk');
      const archive = await (await docker()).getContainer(entry.handle!.ref).getArchive({ path: svc.disk.mountPath });
      store = await uploadArtifact(snap.id, (archive as NodeJS.ReadableStream & import('node:stream').Readable).pipe(createGzip({ level: 6 })));
    } else {
      const dir = diskDir(svc.id, svc.disk.name);
      await mkdir(dir, { recursive: true });
      store = await publishDir(snap.id, dir);
    }
    await q("UPDATE disk_snapshots SET status = 'completed', store = $2, size_bytes = $3, finished_at = now() WHERE id = $1", [snap.id, store, store.size]);
    log(`==> Disk snapshot ${snap.id} completed (${(store.size / 1048576).toFixed(1)} MB compressed)`);
  } catch (err) {
    await q("UPDATE disk_snapshots SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [snap.id, (err as Error).message.slice(0, 500)]);
    log(`==> Disk snapshot failed: ${(err as Error).message}`, 'error');
  }
  await changed(svc.workspace_id, 'service', svc.id, svc.id);
}

/** Stops the service, replaces the disk's contents with the snapshot, then brings the service back. */
export async function handleDiskRestore(ctx: Ctx, payload: { snapshotId: string }): Promise<void> {
  const snap = await one('SELECT * FROM disk_snapshots WHERE id = $1', [payload.snapshotId]);
  const svc = snap && await one('SELECT * FROM services WHERE id = $1', [snap.service_id]);
  if (!snap?.store || !svc?.disk) return;
  const log = (l: string, level = 'info') => shipLog({ serviceId: svc.id, stream: 'system' }, l, level);
  await q("UPDATE disk_snapshots SET status = 'restoring' WHERE id = $1", [snap.id]);
  const file = path.join(config.dataDir, 'tmp', `${snap.id}.${randomBytes(4).toString('hex')}.tgz`);
  try {
    log(`==> Restoring disk ${svc.disk.name} from snapshot ${snap.id}: stopping the service`);
    await stopInstances((await activeInstances(svc.id)).map((r) => r.id), 30_000, true);
    await downloadArtifact(snap.store, file);
    if (ctx.driver.name === 'docker') {
      const d = await docker();
      const volume = `nav-disk-${svc.id}-${svc.disk.name}`;
      await d.getVolume(volume).remove().catch(() => {});
      const deploy = await one('SELECT artifact FROM deploys WHERE id = $1', [svc.current_deploy_id]);
      if (deploy?.artifact?.kind !== 'image') throw new Error('the service has no image to restore into');
      const helper = await d.createContainer({ Image: deploy.artifact.ref, Cmd: ['true'], Labels: { 'nav.tmp': '1' }, HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: svc.disk.mountPath }] } });
      try {
        // getArchive put the mount directory itself at the top of the archive.
        await helper.putArchive(createReadStream(file).pipe(createGunzip()) as unknown as NodeJS.ReadableStream, { path: path.posix.dirname(svc.disk.mountPath) });
      } finally {
        await helper.remove({ force: true }).catch(() => {});
      }
    } else {
      const dir = diskDir(svc.id, svc.disk.name);
      await rm(dir, { recursive: true, force: true });
      await extractInto(createReadStream(file).pipe(createGunzip()), dir);
    }
    await q("UPDATE disk_snapshots SET status = 'completed' WHERE id = $1", [snap.id]);
    log('==> Disk restored; starting the service');
  } catch (err) {
    await q("UPDATE disk_snapshots SET status = 'completed' WHERE id = $1", [snap.id]);
    log(`==> Disk restore failed: ${(err as Error).message}`, 'error');
  } finally {
    await rm(file, { force: true });
    await enqueue('scale', { serviceId: svc.id }, { concurrencyKey: `svc:${svc.id}` });
    await changed(svc.workspace_id, 'service', svc.id, svc.id);
  }
}

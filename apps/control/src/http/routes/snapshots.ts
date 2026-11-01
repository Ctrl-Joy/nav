// Disk snapshots of a service's persistent disk: list, take one now, restore.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { id } from '@nav/shared/ids';
import { one, q, type Row } from '../../db/pool.ts';
import { HttpError, badRequest, enqueue, notFound } from '../../lib/core.ts';
import { workspaceRole } from '../auth.ts';

const out = (r: Row) => ({ id: r.id, serviceId: r.service_id, kind: r.kind, status: r.status, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), error: r.error, createdAt: r.created_at, finishedAt: r.finished_at });

/** Snapshot jobs run on the node that holds the disk. */
export async function snapshotJob(kind: 'disk_snapshot' | 'disk_restore', svc: Row, snapshotId: string): Promise<void> {
  const node = svc.node_id ?? (await one("SELECT node_id FROM instances WHERE service_id = $1 AND status <> 'stopped' ORDER BY started_at DESC LIMIT 1", [svc.id]))?.node_id ?? null;
  await enqueue(kind, { snapshotId }, { nodeId: node ?? undefined, concurrencyKey: `disk:${svc.id}` });
}

async function svcWithDisk(req: FastifyRequest, min: 'viewer' | 'developer' | 'admin'): Promise<Row> {
  const svc = await one('SELECT * FROM services WHERE id = $1', [(req.params as { id: string }).id]);
  if (!svc) throw notFound('service');
  await workspaceRole(req, svc.workspace_id, min).catch((err) => { throw err.status === 403 ? err : notFound('service'); });
  if (!svc.disk) throw badRequest('this service has no persistent disk');
  return svc;
}

export async function snapshotRoutes(app: FastifyInstance) {
  app.get('/services/:id/disk/snapshots', async (req) => {
    const svc = await svcWithDisk(req, 'viewer');
    return { items: (await q('SELECT * FROM disk_snapshots WHERE service_id = $1 ORDER BY created_at DESC LIMIT 50', [svc.id])).map(out) };
  });

  app.post('/services/:id/disk/snapshots', async (req, reply) => {
    const svc = await svcWithDisk(req, 'developer');
    if (await one("SELECT 1 FROM disk_snapshots WHERE service_id = $1 AND status IN ('pending','restoring')", [svc.id])) throw new HttpError(409, 'busy', 'a snapshot or restore is already in progress');
    const row = await one("INSERT INTO disk_snapshots (id, service_id, kind) VALUES ($1,$2,'manual') RETURNING *", [id('dsn'), svc.id]);
    await snapshotJob('disk_snapshot', svc, row!.id);
    return reply.status(201).send(out(row!));
  });

  app.post('/disk-snapshots/:id/restore', async (req) => {
    const snap = await one('SELECT * FROM disk_snapshots WHERE id = $1', [(req.params as { id: string }).id]);
    if (!snap) throw notFound('snapshot');
    const svc = await one('SELECT * FROM services WHERE id = $1', [snap.service_id]);
    await workspaceRole(req, svc!.workspace_id, 'admin').catch((err) => { throw err.status === 403 ? err : notFound('snapshot'); });
    if (snap.status !== 'completed') throw badRequest(`snapshot is ${snap.status}`);
    await snapshotJob('disk_restore', svc!, snap.id);
    return out(snap);
  });
}

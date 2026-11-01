// Internal API for agents and the edge (not for users): the artifact store that moves builds between nodes.
// Authenticated by a token derived from the master key; never routed through the public edge.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ARTIFACT_KEY, nodeToken } from '@nav/shared/artifacts';
import { config } from '@nav/shared/config';
import { HttpError } from '../../lib/core.ts';

const storeDir = path.join(config.dataDir, 'store', 'artifacts');

function requireNode(req: FastifyRequest): void {
  const want = Buffer.from(`Bearer ${nodeToken()}`);
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'unauthorized', 'node token required');
}

function keyOf(req: FastifyRequest): string {
  const key = (req.params as { key: string }).key;
  if (!ARTIFACT_KEY.test(key)) throw new HttpError(400, 'bad_key', 'invalid artifact key');
  return key;
}

export async function internalRoutes(api: FastifyInstance): Promise<void> {
  // Uploads are streamed to disk as they arrive instead of being buffered.
  api.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  api.put('/artifacts/:key', async (req) => {
    requireNode(req);
    const key = keyOf(req);
    await mkdir(storeDir, { recursive: true });
    const tmp = path.join(storeDir, `.${key}.${randomBytes(4).toString('hex')}`);
    const h = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > config.artifactMaxBytes) return cb(new HttpError(413, 'too_large', `artifact exceeds ${config.artifactMaxBytes / 1048576} MB`));
        h.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req.body as Readable, meter, createWriteStream(tmp));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const meta = { key, digest: h.digest('hex'), size };
    // Same key, same build: an upload retried after a timeout simply replaces the earlier copy.
    await rename(tmp, path.join(storeDir, `${key}.tgz`));
    await writeFile(path.join(storeDir, `${key}.json`), JSON.stringify(meta));
    return meta;
  });

  api.get('/artifacts/:key', async (req, reply) => {
    requireNode(req);
    const key = keyOf(req);
    const file = path.join(storeDir, `${key}.tgz`);
    if (!existsSync(file)) throw new HttpError(404, 'not_found', 'artifact not found');
    const meta = JSON.parse(await readFile(path.join(storeDir, `${key}.json`), 'utf8').catch(() => '{}'));
    reply.header('content-length', (await stat(file)).size);
    if (meta.digest) reply.header('x-nav-digest', meta.digest);
    return reply.type('application/octet-stream').send(createReadStream(file));
  });

  api.delete('/artifacts/:key', async (req, reply) => {
    requireNode(req);
    const key = keyOf(req);
    await rm(path.join(storeDir, `${key}.tgz`), { force: true });
    await rm(path.join(storeDir, `${key}.json`), { force: true });
    return reply.status(204).send();
  });
}

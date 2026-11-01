// Wires sandboxes into the agent: picks the sandbox driver matching the node's driver and recovers after a restart.
import { config } from '@nav/shared/config';
import { q } from '../../db/pool.ts';
import { dockerSandboxDriver } from './docker.ts';
import { SandboxManager } from './manager.ts';
import { processSandboxDriver } from './process.ts';

export function sandboxManagerFor(driverName: 'process' | 'docker'): SandboxManager {
  if (driverName === 'docker') return new SandboxManager(dockerSandboxDriver(), process.env.NAV_SANDBOXES === '0' ? 'sandboxes are disabled on this node' : null);
  // The process driver gives no isolation at all: only for development unless an operator explicitly opts in.
  const allowed = config.env !== 'production' || process.env.NAV_ALLOW_UNISOLATED_SANDBOXES === '1';
  const reason = process.env.NAV_SANDBOXES === '0'
    ? 'sandboxes are disabled on this node'
    : allowed ? null : 'this node uses the process driver, which cannot isolate sandboxes (set NAV_ALLOW_UNISOLATED_SANDBOXES=1 to allow it anyway)';
  return new SandboxManager(processSandboxDriver(), reason);
}

/**
 * After an agent restart: containers that are still running are adopted; process sandboxes died with the agent
 * and are marked failed. Leftover files and containers of anything else are removed.
 */
export async function recoverSandboxes(mgr: SandboxManager, nodeId: string): Promise<void> {
  const rows = await q("SELECT id FROM sandboxes WHERE node_id = $1 AND status IN ('starting','running','stopping')", [nodeId]);
  const keep = new Set<string>();
  for (const r of rows) {
    if (await mgr.adopt(r.id).catch(() => false)) keep.add(r.id);
    else await q("UPDATE sandboxes SET status = 'failed', error = 'the node agent restarted', stopped_at = now() WHERE id = $1", [r.id]);
  }
  await mgr.driver.sweep?.(keep).catch((err) => console.error('[agent] sandbox sweep', (err as Error).message));
}

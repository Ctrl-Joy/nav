// Host firewall for sandbox egress. Docker's bridge NATs a sandbox straight onto the node's networks, so "egress"
// would also reach the node's private network, cloud metadata (169.254.169.254) and the node itself. On Linux,
// when the agent may manage iptables (root or CAP_NET_ADMIN), it installs two chains, idempotently at start:
//  - NAV-SANDBOX-EGRESS, jumped to from DOCKER-USER (forwarded traffic): drops packets from the sandbox egress
//    subnet to RFC 1918, CGNAT, link-local and loopback ranges and the node's own addresses; DNS to the node's
//    upstream resolvers stays allowed so Docker's embedded resolver keeps working. It also drops traffic from any
//    Docker bridge (app networks) to link-local addresses, i.e. the cloud metadata service.
//  - NAV-SANDBOX-INPUT, jumped to from INPUT: drops everything a sandbox sends to the node itself (the agent,
//    databases and other daemons listening on the host). Docker's embedded DNS lives in the container's own
//    network namespace and does not pass through here.
// Elsewhere (macOS / Windows dev, rootless agents) nothing is applied and the agent says so; sandboxes then report
// egressFiltered: false. Only IPv4 is handled: the egress network is created without IPv6.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const EGRESS_CHAIN = 'NAV-SANDBOX-EGRESS';
export const INPUT_CHAIN = 'NAV-SANDBOX-INPUT';
/** Destinations a sandbox may never reach through its egress network. */
export const BLOCKED_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8'];

/** One iptables invocation: `check` first (skip when it succeeds), `ignoreError` for "chain already exists". */
export interface FirewallStep { args: string[]; check?: string[]; ignoreError?: boolean }

export interface FirewallInput {
  /** The sandbox egress bridge subnet, e.g. 172.30.0.0/16. */
  subnet: string;
  /** The node's own IPv4 addresses. */
  nodeAddresses: string[];
  /** Upstream DNS resolvers (from /etc/resolv.conf) that must stay reachable on port 53. */
  resolvers: string[];
}

/** The iptables argument lists that install the rules (pure, so it can be unit tested without iptables). */
export function egressFirewallSteps(input: FirewallInput): FirewallStep[] {
  const { subnet } = input;
  const steps: FirewallStep[] = [];
  const chain = (name: string) => {
    steps.push({ args: ['-w', '-N', name], ignoreError: true });
    steps.push({ args: ['-w', '-F', name] });
  };
  chain(EGRESS_CHAIN);
  for (const ns of [...new Set(input.resolvers.filter((r) => net.isIPv4(r) && !r.startsWith('127.')))]) {
    for (const proto of ['udp', 'tcp']) steps.push({ args: ['-w', '-A', EGRESS_CHAIN, '-s', subnet, '-d', `${ns}/32`, '-p', proto, '--dport', '53', '-j', 'RETURN'] });
  }
  const own = [...new Set(input.nodeAddresses.filter((a) => net.isIPv4(a)))].map((a) => `${a}/32`);
  for (const dest of [...BLOCKED_RANGES, ...own]) steps.push({ args: ['-w', '-A', EGRESS_CHAIN, '-s', subnet, '-d', dest, '-j', 'DROP'] });
  // App networks (and the default bridge): no cloud metadata service either.
  for (const iface of ['br-+', 'docker0']) steps.push({ args: ['-w', '-A', EGRESS_CHAIN, '-i', iface, '-d', '169.254.0.0/16', '-j', 'DROP'] });
  steps.push({ args: ['-w', '-A', EGRESS_CHAIN, '-j', 'RETURN'] });
  steps.push({ check: ['-w', '-C', 'DOCKER-USER', '-j', EGRESS_CHAIN], args: ['-w', '-I', 'DOCKER-USER', '1', '-j', EGRESS_CHAIN] });

  chain(INPUT_CHAIN);
  steps.push({ args: ['-w', '-A', INPUT_CHAIN, '-s', subnet, '-j', 'DROP'] });
  steps.push({ args: ['-w', '-A', INPUT_CHAIN, '-j', 'RETURN'] });
  steps.push({ check: ['-w', '-C', 'INPUT', '-j', INPUT_CHAIN], args: ['-w', '-I', 'INPUT', '1', '-j', INPUT_CHAIN] });
  return steps;
}

/** nameserver lines of a resolv.conf. */
export function parseResolvConf(text: string): string[] {
  return text.split('\n').map((l) => /^\s*nameserver\s+(\S+)/.exec(l)?.[1]).filter((x): x is string => !!x);
}

/** Whether this process may change the firewall: root, or CAP_NET_ADMIN (bit 12) in its effective set. */
async function canManageFirewall(): Promise<boolean> {
  if (process.getuid?.() === 0) return true;
  const status = await readFile('/proc/self/status', 'utf8').catch(() => '');
  const cap = /^CapEff:\s*([0-9a-f]+)/m.exec(status)?.[1];
  return !!cap && (BigInt(`0x${cap}`) & (1n << 12n)) !== 0n;
}

export type IptablesRunner = (args: string[]) => Promise<void>;
const iptables: IptablesRunner = async (args) => { await run('iptables', args, { timeout: 15_000 }); };

/**
 * Installs (or refreshes) the rules for `subnet`. Never throws: returns whether they are in place and logs clearly
 * when they cannot be applied.
 */
export async function applyEgressFirewall(subnet: string, opts: { runner?: IptablesRunner; log?: (m: string) => void } = {}): Promise<boolean> {
  const log = opts.log ?? ((m: string) => console.warn(`[agent] ${m}`));
  if (process.platform !== 'linux') {
    log('sandbox egress filtering is unavailable on this OS: sandboxes with network access can reach private networks reachable from this host');
    return false;
  }
  if (!opts.runner && !(await canManageFirewall())) {
    log('sandbox egress filtering NOT applied: the agent needs root or CAP_NET_ADMIN to install iptables rules; sandboxes with network access can reach private networks and this node');
    return false;
  }
  const exec = opts.runner ?? iptables;
  const nodeAddresses = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4').map((a) => a!.address);
  const resolvers = parseResolvConf(await readFile('/etc/resolv.conf', 'utf8').catch(() => ''));
  try {
    for (const step of egressFirewallSteps({ subnet, nodeAddresses, resolvers })) {
      if (step.check && (await exec(step.check).then(() => true, () => false))) continue;
      await exec(step.args).catch((err) => { if (!step.ignoreError) throw err; });
    }
    console.log(`[agent] sandbox egress filtering applied for ${subnet}`);
    return true;
  } catch (err) {
    log(`sandbox egress filtering NOT applied (iptables failed: ${(err as Error).message.split('\n')[0]}); sandboxes with network access can reach private networks and this node`);
    return false;
  }
}

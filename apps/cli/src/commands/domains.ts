import type { CustomDomain } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext } from '../context.ts';
import { UsageError } from '../errors.ts';
import { dim, green, out, printJson, red, table } from '../output.ts';

const LIST_USAGE = 'nav domains <service> [--json]';
const ADD_USAGE = 'nav domains add <service> <domain> [--json]';
const VERIFY_USAGE = 'nav domains verify <domainId> [--json]';
const RM_USAGE = 'nav domains rm <domainId> [--json]';

interface DomainListResponse {
  items: CustomDomain[];
}

function dnsText(domain: CustomDomain): string {
  return `${domain.dnsRecordType} ${domain.dnsTarget}`;
}

async function listDomains(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', LIST_USAGE);
  args.maxPositionals(1, LIST_USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const { items } = await ctx.client.get<DomainListResponse>(`/services/${svc.id}/custom-domains`);
  if (args.bool('json')) {
    printJson(items);
    return;
  }
  if (items.length === 0) {
    out(`No custom domains on ${svc.name}. Add one with nav domains add ${svc.name} <domain>.`);
    return;
  }
  out(table(
    ['domain', 'id', 'verification', 'certificate', 'point dns to', 'redirect to'],
    items.map((d) => [
      d.domain,
      d.id,
      d.verificationStatus,
      d.certStatus,
      dnsText(d),
      d.redirectTo ?? '-',
    ]),
  ));
}

async function addDomain(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', ADD_USAGE);
  const domain = args.arg(1, 'domain', ADD_USAGE).trim().toLowerCase();
  args.maxPositionals(2, ADD_USAGE);
  if (!/^[a-z0-9*][a-z0-9.*-]*\.[a-z]{2,}$/.test(domain)) {
    throw new UsageError(`"${domain}" does not look like a domain name`, 'use a form like app.example.com');
  }
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const created = await ctx.client.post<CustomDomain>(`/services/${svc.id}/custom-domains`, { domain });
  if (args.bool('json')) {
    printJson(created);
    return;
  }
  out(`${green('Added')} ${created.domain} (${created.id})`);
  out(`Create a ${created.dnsRecordType} record pointing to ${created.dnsTarget}, then run:`);
  out(`  nav domains verify ${created.id}`);
}

async function verifyDomain(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const id = args.arg(0, 'domain id', VERIFY_USAGE);
  args.maxPositionals(1, VERIFY_USAGE);
  const ctx = await workspaceContext();
  const domain = await ctx.client.post<CustomDomain>(`/custom-domains/${id}/verify`);
  if (args.bool('json')) {
    printJson(domain);
  } else {
    const verified = domain.verificationStatus === 'verified';
    const issued = domain.certStatus === 'issued';
    out(`${domain.domain}: DNS ${verified ? green('verified') : red(domain.verificationStatus)}, `
      + `certificate ${issued ? green('issued') : domain.certStatus}`);
    if (domain.lastError) out(red(domain.lastError));
    if (!verified) out(dim(`Point a ${domain.dnsRecordType} record to ${domain.dnsTarget}, then verify again.`));
  }
  if (domain.verificationStatus === 'failed' || domain.certStatus === 'failed') process.exitCode = 1;
}

async function removeDomain(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const id = args.arg(0, 'domain id', RM_USAGE);
  args.maxPositionals(1, RM_USAGE);
  const ctx = await workspaceContext();
  await ctx.client.del(`/custom-domains/${id}`);
  if (args.bool('json')) printJson({ deleted: id });
  else out(`Removed domain ${id}`);
}

async function domainsCommand(argv: string[]): Promise<void> {
  switch (argv[0]) {
    case 'add': return addDomain(argv.slice(1));
    case 'verify': return verifyDomain(argv.slice(1));
    case 'rm': return removeDomain(argv.slice(1));
    default: return listDomains(argv);
  }
}

export const domainCommands: CommandDef[] = [
  {
    name: 'domains',
    summary: 'List, add, verify and remove custom domains',
    usage: [LIST_USAGE, ADD_USAGE, VERIFY_USAGE, RM_USAGE],
    run: domainsCommand,
  },
];

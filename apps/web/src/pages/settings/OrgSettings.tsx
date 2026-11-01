import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Building2, CheckCircle2, FileClock, Globe, KeyRound, Mail, Plus, RefreshCw, Search, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useMe } from '@/api/auth';
import {
  useAddOrgDomain, useAddOrgMember, useAttachWorkspace, useCreateOrgWorkspace, useCreateScimToken, useDeleteOrgDomain, useDeleteOrgSaml, useDetachWorkspace,
  useMapScimGroup, useOrg, useOrgAuditLogs, useOrgDomains, useOrgMembers, useOrgSaml, useOrgScim, useOrgWorkspaces, useRemoveOrgMember, useRevokeScimToken,
  useUpdateOrg, useUpdateOrgMember, useUpdateOrgSaml, useVerifyOrgDomain,
} from '@/api/orgs';
import type { OrgDetail, OrgRole, SamlSettings } from '@/api/types';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge, Button, CopyButton, CopyField, Empty, ErrorState, Field, IconButton, Input, Select, SkeletonRows, Switch, Table, TBody, Td, Textarea, Th, THead, Tr,
  useConfirm, useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/time';
import { useTitle } from '@/lib/useTitle';
import { EditActions, EditLink, Row, Section } from './parts';

const ORG_ROLES: { value: OrgRole; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
];

const WS_ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'developer', label: 'Developer' },
  { value: 'viewer', label: 'Viewer' },
];

const SECTIONS: { id: string; label: string; admin?: boolean }[] = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'domains', label: 'Verified Domains', admin: true },
  { id: 'saml', label: 'SAML SSO', admin: true },
  { id: 'scim', label: 'SCIM Provisioning', admin: true },
  { id: 'audit', label: 'Audit Log', admin: true },
];

function GeneralSection({ org, isAdmin }: { org: OrgDetail; isAdmin: boolean }) {
  const { ws, user } = useWorkspace();
  const update = useUpdateOrg(org.id);
  const workspaces = useOrgWorkspaces(org.id);
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [editing, setEditing] = useState(false);
  const [mfaError, setMfaError] = useState(false);
  useEffect(() => setName(org.name), [org.name]);

  const save = async (body: Parameters<typeof update.mutateAsync>[0], done: string) => {
    setMfaError(false);
    try {
      await update.mutateAsync(body);
      toast.success(done);
      return true;
    } catch (err) {
      if (isApiError(err) && err.code === 'mfa_required') setMfaError(true);
      else toast.fromError(err, 'Could not update the organization');
      return false;
    }
  };

  return (
    <Section id="general" title="General">
      <form
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (await save({ name: name.trim() }, 'Organization renamed')) setEditing(false);
        }}
      >
        <Row label="Name" htmlFor="org-name">
          <Input id="org-name" tall value={name} onChange={(e) => setName(e.target.value)} disabled={!editing} />
          {editing ? (
            <EditActions onCancel={() => { setName(org.name); setEditing(false); }} loading={update.isPending} disabled={!name.trim() || name.trim() === org.name} />
          ) : (
            isAdmin && <EditLink onClick={() => setEditing(true)} label="Edit organization name" />
          )}
        </Row>
      </form>
      <Row label="Organization ID">
        <CopyField value={org.id} />
      </Row>
      <Row label="Default workspace" description="Where people who join through SSO or SCIM land, and the role they get there." htmlFor="org-default-ws">
        <div className="flex flex-wrap gap-2">
          <Select
            id="org-default-ws"
            className="min-w-48 flex-1"
            value={org.defaultWorkspaceId ?? ''}
            disabled={!isAdmin || update.isPending}
            placeholder="None"
            options={(workspaces.data?.items ?? []).map((w) => ({ value: w.id, label: w.name }))}
            onChange={(e) => save({ defaultWorkspaceId: e.target.value || null }, 'Default workspace updated')}
          />
          <Select
            aria-label="Default role"
            className="w-36"
            value={org.defaultRole}
            disabled={!isAdmin || update.isPending}
            options={WS_ROLES}
            onChange={(e) => save({ defaultRole: e.target.value as OrgDetail['defaultRole'] }, 'Default role updated')}
          />
        </div>
      </Row>
      <Row label="Require two-factor authentication" description="Applies to every workspace in the organization. Members without 2FA can't open them until they turn it on.">
        <Switch
          checked={org.requireTwoFactor}
          disabled={!isAdmin || update.isPending}
          onChange={(v) => save({ requireTwoFactor: v }, v ? 'Two-factor authentication required' : 'Two-factor authentication optional')}
          label={org.requireTwoFactor ? 'Required' : 'Optional'}
        />
        {(mfaError || (!user.mfaEnabled && !org.requireTwoFactor && isAdmin)) && (
          <p role={mfaError ? 'alert' : undefined} className={cn('mt-2 text-[13px]', mfaError ? 'text-danger' : 'text-fg-muted')}>
            Turn on 2FA for your own account before requiring it.{' '}
            <Link to={`/w/${ws}/account#security`} className="text-accent hover:underline">Set it up</Link>
          </p>
        )}
      </Row>
    </Section>
  );
}

function MembersSection({ org, isAdmin, isOwner }: { org: OrgDetail; isAdmin: boolean; isOwner: boolean }) {
  const { user } = useWorkspace();
  const members = useOrgMembers(org.id);
  const add = useAddOrgMember(org.id);
  const update = useUpdateOrgMember(org.id);
  const remove = useRemoveOrgMember(org.id);
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await add.mutateAsync({ email: email.trim(), role });
      toast.success('Member added', email.trim());
      setEmail('');
    } catch (err) {
      toast.fromError(err, 'Could not add member');
    }
  };

  return (
    <Section id="members" title="Members" description="Org owners and admins can manage every workspace in the organization. Members only see the workspaces they belong to.">
      {isAdmin && (
        <form onSubmit={submit} className="mb-6 flex flex-wrap items-end gap-3">
          <Field label="Email" className="min-w-56 flex-1">
            {(id) => <Input id={id} type="email" leading={<Mail className="size-3.5" />} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />}
          </Field>
          <Field label="Role" className="w-36">
            {(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value as OrgRole)} options={ORG_ROLES.filter((r) => r.value !== 'owner' || isOwner)} />}
          </Field>
          <Button type="submit" variant="primary" icon={<UserPlus className="size-4" />} loading={add.isPending} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}>
            Add
          </Button>
        </form>
      )}
      {members.isPending ? (
        <SkeletonRows rows={3} />
      ) : members.isError ? (
        <ErrorState error={members.error} onRetry={() => members.refetch()} />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Member</Th>
              <Th>Role</Th>
              <Th className="hidden md:table-cell">Sign-in</Th>
              <Th className="w-10"><span className="sr-only">Actions</span></Th>
            </tr>
          </THead>
          <TBody>
            {members.data.items.map((m) => {
              const self = m.userId === user.id;
              const editable = isAdmin && !self && (m.role !== 'owner' || isOwner);
              return (
                <Tr key={m.userId}>
                  <Td>
                    <div className="font-medium">{m.name || m.email} {self && <span className="text-xs font-normal text-fg-subtle">(you)</span>}</div>
                    <div className="text-xs text-fg-subtle">{m.email}</div>
                  </Td>
                  <Td>
                    {editable ? (
                      <Select
                        size="sm"
                        className="w-32"
                        aria-label={`Role for ${m.email}`}
                        value={m.role}
                        options={ORG_ROLES.filter((r) => r.value !== 'owner' || isOwner)}
                        onChange={(e) => update.mutate({ userId: m.userId, role: e.target.value as OrgRole }, { onError: (err) => toast.fromError(err, 'Could not change role') })}
                      />
                    ) : (
                      <Badge className="capitalize">{m.role}</Badge>
                    )}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1.5">
                      {m.samlLinked && <Badge tone="info">SAML</Badge>}
                      {m.scimManaged && <Badge tone="accent">SCIM</Badge>}
                      {m.mfaEnabled ? <Badge tone="success">2FA</Badge> : <Badge>No 2FA</Badge>}
                    </div>
                  </Td>
                  <Td>
                    {(editable || self) && (
                      <IconButton
                        label={self ? 'Leave organization' : `Remove ${m.email}`}
                        icon={<Trash2 className="size-4" />}
                        onClick={async () => {
                          const ok = await confirm({
                            title: self ? 'Leave this organization?' : `Remove ${m.email}?`,
                            body: 'They are also removed from every workspace the organization owns.',
                            confirmText: self ? 'Leave' : 'Remove',
                            danger: true,
                          });
                          if (!ok) return;
                          remove.mutate(m.userId, {
                            onSuccess: () => (self ? navigate('/app') : toast.success('Member removed')),
                            onError: (err) => toast.fromError(err, 'Could not remove member'),
                          });
                        }}
                      />
                    )}
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </Section>
  );
}

function WorkspacesSection({ org, isAdmin, isOwner }: { org: OrgDetail; isAdmin: boolean; isOwner: boolean }) {
  const { ws, workspace } = useWorkspace();
  const list = useOrgWorkspaces(org.id);
  const create = useCreateOrgWorkspace(org.id);
  const attach = useAttachWorkspace(org.id);
  const detach = useDetachWorkspace(org.id);
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const canAttach = isAdmin && !workspace.orgId && workspace.role === 'owner';

  return (
    <Section id="workspaces" title="Workspaces" description="Workspaces owned by this organization.">
      {isAdmin && (
        <form
          className="mb-6 flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const created = await create.mutateAsync(name.trim());
              toast.success('Workspace created', name.trim());
              setName('');
              navigate(`/w/${created.id}`);
            } catch (err) {
              toast.fromError(err, 'Could not create workspace');
            }
          }}
        >
          <Field label="New workspace" className="min-w-56 flex-1">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Production" />}
          </Field>
          <Button type="submit" icon={<Plus className="size-4" />} loading={create.isPending} disabled={!name.trim()}>
            Create
          </Button>
          {canAttach && (
            <Button
              type="button"
              loading={attach.isPending}
              onClick={() => attach.mutate(ws, { onSuccess: () => toast.success('Workspace moved', `${workspace.name} now belongs to ${org.name}`), onError: (err) => toast.fromError(err, 'Could not move workspace') })}
            >
              Move “{workspace.name}” here
            </Button>
          )}
        </form>
      )}
      {list.isPending ? (
        <SkeletonRows rows={2} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data.items.length ? (
        <Empty compact title="No workspaces" description="Create one above." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Workspace</Th>
              <Th className="hidden sm:table-cell">Members</Th>
              <Th className="hidden sm:table-cell">Resources</Th>
              <Th className="w-10"><span className="sr-only">Actions</span></Th>
            </tr>
          </THead>
          <TBody>
            {list.data.items.map((w) => (
              <Tr key={w.id}>
                <Td>
                  <Link to={`/w/${w.id}`} className="font-medium hover:underline">{w.name}</Link>
                  {org.defaultWorkspaceId === w.id && <Badge tone="accent" className="ml-2">Default</Badge>}
                  <div className="font-mono text-xs text-fg-subtle">{w.slug}</div>
                </Td>
                <Td className="hidden sm:table-cell">{w.members}</Td>
                <Td className="hidden sm:table-cell">{w.services} services · {w.databases} databases</Td>
                <Td>
                  {isOwner && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={async () => {
                        const ok = await confirm({ title: `Detach ${w.name}?`, body: 'The workspace keeps its members and resources, but org admins lose access and SSO users are no longer placed in it.', confirmText: 'Detach', danger: true });
                        if (ok) detach.mutate(w.id, { onSuccess: () => toast.success('Workspace detached'), onError: (err) => toast.fromError(err, 'Could not detach workspace') });
                      }}
                    >
                      Detach
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </Section>
  );
}

function DomainsSection({ org }: { org: OrgDetail }) {
  const domains = useOrgDomains(org.id);
  const add = useAddOrgDomain(org.id);
  const verify = useVerifyOrgDomain(org.id);
  const remove = useDeleteOrgDomain(org.id);
  const toast = useToast();
  const confirm = useConfirm();
  const [domain, setDomain] = useState('');

  return (
    <Section
      id="domains"
      title="Verified Domains"
      description="Prove your organization owns an email domain by publishing a DNS TXT record. SAML and SCIM only accept users whose email is in a verified domain."
    >
      <form
        className="mb-6 flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await add.mutateAsync(domain.trim().toLowerCase());
            setDomain('');
          } catch (err) {
            toast.fromError(err, 'Could not add domain');
          }
        }}
      >
        <Field label="Domain" className="min-w-56 flex-1">
          {(id) => <Input id={id} leading={<Globe className="size-3.5" />} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="company.com" />}
        </Field>
        <Button type="submit" icon={<Plus className="size-4" />} loading={add.isPending} disabled={!domain.trim()}>Add domain</Button>
      </form>
      {domains.isPending ? (
        <SkeletonRows rows={2} />
      ) : domains.isError ? (
        <ErrorState error={domains.error} onRetry={() => domains.refetch()} />
      ) : !domains.data.items.length ? (
        <Empty compact icon={<Globe className="size-4" />} title="No domains yet" description="Add the domain your team's email addresses use." />
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {domains.data.items.map((d) => (
            <li key={d.id} className="py-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[14px] text-fg">{d.domain}</span>
                {d.verified ? <Badge tone="success"><CheckCircle2 className="mr-1 inline size-3" />Verified</Badge> : <Badge tone="warning">Pending</Badge>}
                <span className="ml-auto flex gap-2">
                  {!d.verified && (
                    <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={verify.isPending && verify.variables === d.id}
                      onClick={() => verify.mutate(d.id, {
                        onSuccess: (r) => (r.verified ? toast.success('Domain verified', r.domain) : toast.error('Not verified yet', r.lastError ?? 'The TXT record was not found.')),
                        onError: (err) => toast.fromError(err, 'Could not verify'),
                      })}
                    >
                      Verify
                    </Button>
                  )}
                  <IconButton label={`Remove ${d.domain}`} icon={<Trash2 className="size-4" />} onClick={async () => {
                    if (await confirm({ title: `Remove ${d.domain}?`, body: 'SAML and SCIM stop accepting users from this domain. If it is the last verified domain, SAML is turned off.', confirmText: 'Remove', danger: true })) {
                      remove.mutate(d.id, { onError: (err) => toast.fromError(err, 'Could not remove domain') });
                    }
                  }} />
                </span>
              </div>
              {!d.verified && (
                <div className="mt-3 grid gap-2 rounded-[3px] bg-panel p-3 text-[13px]">
                  <p className="text-fg-muted">Add this TXT record at your DNS provider, then select Verify. DNS changes can take a few minutes.</p>
                  <div className="grid gap-2 sm:grid-cols-[80px_minmax(0,1fr)] sm:items-center">
                    <span className="text-fg-muted">Name</span><CopyField value={d.txtName} />
                    <span className="text-fg-muted">Value</span><CopyField value={d.txtValue} />
                  </div>
                  {d.lastError && <p className="text-xs text-danger">{d.lastError}{d.lastCheckedAt ? <> · checked <RelativeTime value={d.lastCheckedAt} /></> : null}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SamlSection({ org }: { org: OrgDetail }) {
  const saml = useOrgSaml(org.id);
  const domains = useOrgDomains(org.id);
  const update = useUpdateOrgSaml(org.id);
  const reset = useDeleteOrgSaml(org.id);
  const toast = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState<'metadata' | 'manual'>('metadata');
  const [metadataXml, setMetadataXml] = useState('');
  const [entityId, setEntityId] = useState('');
  const [ssoUrl, setSsoUrl] = useState('');
  const [certificate, setCertificate] = useState('');
  const [binding, setBinding] = useState<'redirect' | 'post'>('redirect');
  const [error, setError] = useState<string | null>(null);
  const s: SamlSettings | undefined = saml.data;
  useEffect(() => {
    if (!s) return;
    setEntityId(s.idp.entityId ?? '');
    setSsoUrl(s.idp.ssoUrl ?? '');
    setBinding(s.idp.binding);
  }, [s]);
  const hasVerified = (domains.data?.items ?? []).some((d) => d.verified);

  if (saml.isPending) return <Section id="saml" title="SAML SSO"><SkeletonRows rows={3} /></Section>;
  if (saml.isError || !s) return <Section id="saml" title="SAML SSO"><ErrorState error={saml.error} onRetry={() => saml.refetch()} /></Section>;

  const save = async (body: { enabled: boolean; enforce: boolean; withIdp?: boolean }, done: string) => {
    setError(null);
    const idp = body.withIdp
      ? mode === 'metadata' ? { metadataXml } : { entityId, ssoUrl, certificate: certificate || undefined, binding }
      : {};
    try {
      await update.mutateAsync({ enabled: body.enabled, enforce: body.enforce, ...idp });
      toast.success(done);
      if (body.withIdp) { setMetadataXml(''); setCertificate(''); }
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Could not save SAML settings');
    }
  };

  return (
    <Section id="saml" title="SAML SSO" description="Let members sign in through your identity provider (Okta, Microsoft Entra ID, Google Workspace, ...). New users are created on first sign-in and added to the default workspace.">
      <Row label="Service provider details" description="Enter these in your identity provider, or give it the metadata URL.">
        <div className="grid gap-2 text-[13px]">
          <span className="text-fg-muted">Entity ID / metadata URL</span><CopyField value={s.sp.entityId} />
          <span className="text-fg-muted">ACS (reply) URL</span><CopyField value={s.sp.acsUrl} />
          <span className="text-fg-muted">Sign-in URL</span><CopyField value={s.sp.loginUrl} />
          <span className="text-fg-muted">NameID format: email address · AuthnRequests are signed (certificate in the metadata)</span>
        </div>
      </Row>
      <Row label="Identity provider" description={s.configured ? <>Configured: <span className="break-all font-mono text-xs">{s.idp.entityId}</span></> : 'Paste your IdP metadata, or enter its details.'}>
        {s.configured && (
          <ul className="mb-3 space-y-1 text-xs text-fg-muted">
            <li className="break-all">SSO URL: <span className="font-mono">{s.idp.ssoUrl}</span> ({s.idp.binding === 'post' ? 'HTTP-POST' : 'HTTP-Redirect'})</li>
            {s.idp.certificates.map((c, i) => (
              <li key={i} className="break-all">Signing certificate: {c.subject}{c.notAfter ? ` · expires ${formatDateTime(c.notAfter)}` : ''}</li>
            ))}
          </ul>
        )}
        <div className="mb-3 flex gap-2 text-[13px]">
          {(['metadata', 'manual'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={cn('rounded-[3px] border px-2.5 py-1', mode === m ? 'border-accent text-fg' : 'border-border text-fg-muted hover:text-fg')}>
              {m === 'metadata' ? 'Metadata XML' : 'Enter manually'}
            </button>
          ))}
        </div>
        {mode === 'metadata' ? (
          <Textarea mono rows={6} aria-label="IdP metadata XML" value={metadataXml} onChange={(e) => setMetadataXml(e.target.value)} placeholder={'<md:EntityDescriptor entityID="https://idp.example.com/..." ...>'} />
        ) : (
          <div className="grid gap-3">
            <Field label="IdP entity ID / issuer">{(id) => <Input id={id} value={entityId} onChange={(e) => setEntityId(e.target.value)} />}</Field>
            <Field label="SSO URL">{(id) => <Input id={id} value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} placeholder="https://" />}</Field>
            <Field label="Binding">{(id) => <Select id={id} value={binding} onChange={(e) => setBinding(e.target.value as 'redirect' | 'post')} options={[{ value: 'redirect', label: 'HTTP-Redirect' }, { value: 'post', label: 'HTTP-POST' }]} />}</Field>
            <Field label="Signing certificate (PEM)" optional={s.configured}>{(id) => <Textarea id={id} mono rows={5} value={certificate} onChange={(e) => setCertificate(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />}</Field>
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="primary" loading={update.isPending} disabled={mode === 'metadata' ? !metadataXml.trim() : !entityId.trim() || !ssoUrl.trim()} onClick={() => save({ enabled: s.enabled, enforce: s.enforce, withIdp: true }, 'Identity provider saved')}>
            Save identity provider
          </Button>
        </div>
      </Row>
      <Row label="Enable SAML" description={hasVerified ? 'People with an email in a verified domain can use "Sign in with SSO".' : 'Verify a domain first.'}>
        <Switch checked={s.enabled} disabled={update.isPending || (!s.enabled && (!s.configured || !hasVerified))} onChange={(v) => save({ enabled: v, enforce: v ? s.enforce : false }, v ? 'SAML enabled' : 'SAML disabled')} label={s.enabled ? 'On' : 'Off'} />
      </Row>
      <Row label="Require SSO" description="Accounts with an email in a verified domain must sign in through SAML: passwords and other providers are refused. Sign in with SSO once yourself before turning this on.">
        <Switch checked={s.enforce} disabled={update.isPending || !s.enabled} onChange={(v) => save({ enabled: s.enabled, enforce: v }, v ? 'SSO is now required' : 'SSO is optional')} label={s.enforce ? 'Required' : 'Optional'} />
      </Row>
      {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
      {s.configured && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline-danger" loading={reset.isPending} onClick={async () => {
            if (await confirm({ title: 'Remove SAML configuration?', body: 'SAML sign-in stops immediately and the service provider certificate is replaced. You will have to set up your identity provider again.', confirmText: 'Remove', danger: true })) {
              reset.mutate(undefined, { onSuccess: () => toast.success('SAML configuration removed'), onError: (err) => toast.fromError(err, 'Could not remove') });
            }
          }}>
            Remove configuration
          </Button>
        </div>
      )}
    </Section>
  );
}

function ScimSection({ org }: { org: OrgDetail }) {
  const scim = useOrgScim(org.id);
  const workspaces = useOrgWorkspaces(org.id);
  const create = useCreateScimToken(org.id);
  const revoke = useRevokeScimToken(org.id);
  const map = useMapScimGroup(org.id);
  const toast = useToast();
  const confirm = useConfirm();
  const [token, setToken] = useState<string | null>(null);

  return (
    <Section
      id="scim"
      title="SCIM Provisioning"
      description="Let your identity provider create, update and deactivate users. Deactivated users are removed from the organization and its workspaces, and their sessions and API keys are revoked."
    >
      {scim.isPending ? (
        <SkeletonRows rows={3} />
      ) : scim.isError ? (
        <ErrorState error={scim.error} onRetry={() => scim.refetch()} />
      ) : (
        <>
          <Row label="SCIM base URL" description={`${scim.data.users.active} active of ${scim.data.users.total} provisioned users.`}>
            <CopyField value={scim.data.baseUrl} />
          </Row>
          <Row label="Bearer tokens" description="Paste a token into your IdP's SCIM connector. It is shown once.">
            {token && (
              <div className="mb-3 rounded-[3px] bg-panel p-3">
                <p className="mb-2 text-xs text-fg-muted">New token (shown once):</p>
                <CopyField value={token} />
              </div>
            )}
            <ul className="mb-3 divide-y divide-border border-y border-border text-[13px]">
              {scim.data.tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2">
                  <KeyRound className="size-3.5 text-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{t.name}</span> <span className="font-mono text-xs text-fg-subtle">{t.prefix}…</span>
                    <span className="block text-xs text-fg-subtle">Last used {t.lastUsedAt ? <RelativeTime value={t.lastUsedAt} /> : 'never'}</span>
                  </span>
                  <Button size="xs" variant="ghost" onClick={async () => {
                    if (await confirm({ title: `Revoke ${t.name}?`, body: 'Your IdP can no longer provision users with it.', confirmText: 'Revoke', danger: true })) {
                      revoke.mutate(t.id, { onError: (err) => toast.fromError(err, 'Could not revoke') });
                    }
                  }}>Revoke</Button>
                </li>
              ))}
              {!scim.data.tokens.length && <li className="py-2 text-fg-muted">No tokens yet.</li>}
            </ul>
            <Button size="sm" icon={<Plus className="size-3.5" />} loading={create.isPending} onClick={() => create.mutate('SCIM', { onSuccess: (r) => setToken(r.token), onError: (err) => toast.fromError(err, 'Could not create a token') })}>
              Generate token
            </Button>
          </Row>
          <Row label="Group mappings" description="Members of a pushed group get the chosen role in a workspace. Roles granted by hand are never lowered.">
            {!scim.data.groups.length ? (
              <p className="text-[13px] text-fg-muted">No groups pushed yet.</p>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {scim.data.groups.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                    <span className="min-w-32 flex-1 font-medium">{g.displayName} <span className="font-normal text-fg-subtle">· {g.members}</span></span>
                    <Select
                      size="sm"
                      className="w-40"
                      aria-label={`Workspace for ${g.displayName}`}
                      value={g.workspaceId ?? ''}
                      placeholder="Not mapped"
                      options={(workspaces.data?.items ?? []).map((w) => ({ value: w.id, label: w.name }))}
                      onChange={(e) => map.mutate({ groupId: g.id, workspaceId: e.target.value || null, role: e.target.value ? (g.role ?? 'developer') : null }, { onError: (err) => toast.fromError(err, 'Could not map group') })}
                    />
                    <Select
                      size="sm"
                      className="w-32"
                      aria-label={`Role for ${g.displayName}`}
                      value={g.role ?? ''}
                      disabled={!g.workspaceId}
                      placeholder="—"
                      options={WS_ROLES}
                      onChange={(e) => g.workspaceId && map.mutate({ groupId: g.id, workspaceId: g.workspaceId, role: e.target.value as 'admin' | 'developer' | 'viewer' }, { onError: (err) => toast.fromError(err, 'Could not map group') })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </>
      )}
    </Section>
  );
}

function AuditSection({ org }: { org: OrgDetail }) {
  const [action, setAction] = useState('');
  const [filter, setFilter] = useState<string | undefined>(undefined);
  useEffect(() => {
    const t = setTimeout(() => setFilter(action.trim() || undefined), 350);
    return () => clearTimeout(t);
  }, [action]);
  const logs = useOrgAuditLogs(org.id, { action: filter });
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Section id="audit" title="Audit Log" description="Organization settings, SAML sign-ins, SCIM changes, and every change in the organization's workspaces.">
      <Input className="mb-3 w-full sm:w-72" leading={<Search className="size-3.5" />} placeholder="Action, e.g. scim. or saml.login" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" />
      {logs.isPending ? (
        <SkeletonRows rows={5} />
      ) : logs.isError ? (
        <ErrorState error={logs.error} onRetry={() => logs.refetch()} />
      ) : !items.length ? (
        <Empty compact icon={<FileClock className="size-4" />} title="No entries" />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Time</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th className="hidden md:table-cell">Workspace</Th>
              </tr>
            </THead>
            <TBody>
              {items.map((e) => (
                <Tr key={e.id}>
                  <Td><span title={formatDateTime(e.createdAt)} className="whitespace-nowrap text-fg-muted"><RelativeTime value={e.createdAt} /></span></Td>
                  <Td><Badge mono tone={/delete|deactivate|failed|revoke/.test(e.action) ? 'danger' : /create|login/.test(e.action) ? 'success' : 'neutral'}>{e.action}</Badge></Td>
                  <Td>
                    <div className="truncate">{e.actorEmail ?? '—'}</div>
                    {e.actorKind && e.actorKind !== 'session' && <div className="text-[11px] text-fg-subtle">via {e.actorKind === 'api_key' ? 'API key' : e.actorKind.toUpperCase()}</div>}
                  </Td>
                  <Td className="hidden text-fg-muted md:table-cell">{e.workspaceName ?? '—'}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          {logs.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>Load more</Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

export function OrgSettingsPage() {
  const { orgId = '' } = useParams();
  const me = useMe();
  const org = useOrg(orgId);
  const { hash } = useLocation();
  const role = me.data?.orgs?.find((o) => o.id === orgId)?.role ?? org.data?.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';
  useTitle(org.data ? `${org.data.name} · Organization` : 'Organization');
  const sections = useMemo(() => SECTIONS.filter((s) => !s.admin || isAdmin), [isAdmin]);

  useEffect(() => {
    if (!hash || !org.data) return;
    const el = document.getElementById(hash.slice(1));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, [hash, org.data]);

  if (org.isPending) return <SkeletonRows rows={6} />;
  if (org.isError || !org.data) return <ErrorState error={org.error} title="Could not load this organization" onRetry={() => org.refetch()} />;

  return (
    <div>
      <div className="mb-10">
        <div className="flex flex-wrap items-center gap-3">
          <Building2 className="size-6 text-fg-muted" strokeWidth={1.5} aria-hidden />
          <h1 className="text-[26px] leading-tight font-normal tracking-[-0.02em] text-fg md:text-[30px]">{org.data.name}</h1>
          <Badge tone="accent" className="font-mono tracking-wider uppercase">{org.data.role}</Badge>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[13.5px] text-fg-muted">
          <ShieldCheck className="size-3.5" aria-hidden /> Organization settings
          <CopyButton value={org.data.id} label="Copy organization ID" size="xs" />
        </div>
      </div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_200px]">
        <div className="min-w-0 space-y-8">
          <GeneralSection org={org.data} isAdmin={isAdmin} />
          <MembersSection org={org.data} isAdmin={isAdmin} isOwner={isOwner} />
          <WorkspacesSection org={org.data} isAdmin={isAdmin} isOwner={isOwner} />
          {isAdmin && (
            <>
              <DomainsSection org={org.data} />
              <SamlSection org={org.data} />
              <ScimSection org={org.data} />
              <AuditSection org={org.data} />
            </>
          )}
        </div>
        <nav aria-label="Organization settings sections" className="hidden lg:block">
          <ul className="sticky top-[86px] space-y-1 border-l border-border-strong pl-4">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="block py-1 text-[14px] text-fg-muted transition-colors hover:text-fg">{s.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

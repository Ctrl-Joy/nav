import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { CheckCircle2, Mail, Pencil, Trash2, UserPlus } from 'lucide-react';
import { Github } from '@/components/GithubIcon';
import type { Role } from '@nav/shared';
import { GITHUB_LOGIN_URL } from '@/api/auth';
import { useAddMember, useMembers, useNotifications, useRemoveMember, useUpdateMember, useUpdateNotifications, useUpdateWorkspace } from '@/api/workspaces';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge,
  Button,
  buttonClass,
  CopyButton,
  CopyField,
  ErrorState,
  Field,
  IconButton,
  Input,
  Select,
  SkeletonRows,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { cn } from '@/lib/cn';
import { useTitle } from '@/lib/useTitle';

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'developer', label: 'Developer' },
  { value: 'viewer', label: 'Viewer' },
];

const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control, including deleting the workspace.',
  admin: 'Manage members, domains and delete resources.',
  developer: 'Create, deploy and configure services and databases.',
  viewer: 'Read-only access. Secrets are masked.',
};

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Team Members' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'integrations', label: 'Integrations' },
] as const;

/** Bordered settings section with an anchor id. */
function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 rounded-[3px] border border-border-strong px-5 py-6 md:px-7 md:py-7">
      <h2 id={`${id}-title`} className="text-[18px] font-semibold text-fg">
        {title}
      </h2>
      {description && <p className="mt-1.5 max-w-2xl text-[13.5px] text-fg-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Label column on the left, control on the right. */
function Row({ label, description, children, htmlFor }: { label: ReactNode; description?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-8">
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[14px] font-semibold text-fg">
            {label}
          </label>
        ) : (
          <div className="text-[14px] font-semibold text-fg">{label}</div>
        )}
        {description && <p className="mt-1 text-[13.5px] text-fg-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function EditLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <div className="mt-2.5 flex justify-end">
      <button type="button" onClick={onClick} aria-label={label} className="inline-flex items-center gap-1.5 text-[13px] text-fg hover:underline">
        <Pencil className="size-3.5" strokeWidth={1.75} aria-hidden /> Edit
      </button>
    </div>
  );
}

function EditActions({ onCancel, loading, disabled }: { onCancel: () => void; loading?: boolean; disabled?: boolean }) {
  return (
    <div className="mt-3 flex justify-end gap-2">
      <Button size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" type="submit" variant="primary" loading={loading} disabled={disabled}>
        Save changes
      </Button>
    </div>
  );
}

function GeneralSection() {
  const { ws, workspace, isAdmin } = useWorkspace();
  const update = useUpdateWorkspace(ws);
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [editing, setEditing] = useState(false);
  useEffect(() => setName(workspace.name), [workspace.name]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync(name.trim());
      toast.success('Workspace renamed');
      setEditing(false);
    } catch (err) {
      toast.fromError(err, 'Could not rename workspace');
    }
  };
  return (
    <Section id="general" title="General">
      <form onSubmit={submit}>
        <Row label="Name" description="Shown in the top bar and in notifications." htmlFor="ws-name">
          <Input id="ws-name" tall value={name} onChange={(e) => setName(e.target.value)} disabled={!editing} autoFocus={editing} />
          {editing ? (
            <EditActions
              onCancel={() => {
                setName(workspace.name);
                setEditing(false);
              }}
              loading={update.isPending}
              disabled={!name.trim() || name.trim() === workspace.name}
            />
          ) : (
            isAdmin && <EditLink onClick={() => setEditing(true)} label="Edit workspace name" />
          )}
        </Row>
      </form>
      <Row label="Slug" description="Used in URLs and by the CLI.">
        <CopyField value={workspace.slug} />
      </Row>
      <Row label="Your role">
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          <Badge tone="accent" className="capitalize">
            {workspace.role}
          </Badge>
          <span className="text-fg-muted">{ROLE_HELP[workspace.role]}</span>
        </div>
      </Row>
    </Section>
  );
}

function MembersSection() {
  const { ws, user, isAdmin, workspace } = useWorkspace();
  const members = useMembers(ws);
  const add = useAddMember(ws);
  const updateRole = useUpdateMember(ws);
  const remove = useRemoveMember(ws);
  const toast = useToast();
  const confirm = useConfirm();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const roleOptions = ROLE_OPTIONS.filter((r) => r.value !== 'owner' || workspace.role === 'owner');

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await add.mutateAsync({ email: email.trim(), role });
      if (res.invite) {
        setInviteToken(res.invite.token);
        toast.success('Invite created', `${email.trim()} will join when they sign up with this email.`);
      } else toast.success('Member added', email.trim());
      setEmail('');
    } catch (err) {
      toast.fromError(err, 'Could not invite member');
    }
  };

  return (
    <Section id="members" title="Team Members" description="Existing NAV users are added immediately; others get a pending invite.">
      {isAdmin && (
        <div className="mb-6">
          <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
            <Field label="Email" className="min-w-56 flex-1">
              {(id) => <Input id={id} type="email" leading={<Mail className="size-3.5" />} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />}
            </Field>
            <Field label="Role" className="w-40">
              {(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)} options={roleOptions} />}
            </Field>
            <Button type="submit" variant="primary" icon={<UserPlus className="size-4" />} loading={add.isPending} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}>
              Invite
            </Button>
          </form>
          {inviteToken && (
            <div className="mt-4 rounded-[3px] bg-panel p-3">
              <p className="mb-2 text-xs text-fg-muted">Invite token (shown once) — share it if your NAV instance requires tokens for sign-up:</p>
              <CopyField value={inviteToken} />
            </div>
          )}
        </div>
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
              <Th className="hidden sm:table-cell">Joined</Th>
              <Th className="w-10">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {members.data.items.map((m) => {
              const self = m.userId === user.id;
              return (
                <Tr key={m.userId}>
                  <Td>
                    <div className="font-medium">
                      {m.name || m.email} {self && <span className="text-xs font-normal text-fg-subtle">(you)</span>}
                    </div>
                    <div className="text-xs text-fg-subtle">{m.email}</div>
                  </Td>
                  <Td>
                    {isAdmin && !self && (m.role !== 'owner' || workspace.role === 'owner') ? (
                      <Select
                        size="sm"
                        className="w-32"
                        aria-label={`Role for ${m.email}`}
                        value={m.role}
                        options={roleOptions}
                        onChange={(e) =>
                          updateRole.mutate(
                            { userId: m.userId, role: e.target.value as Role },
                            { onSuccess: () => toast.success('Role updated'), onError: (err) => toast.fromError(err, 'Could not change role') },
                          )
                        }
                      />
                    ) : (
                      <span className="text-[13px] capitalize">{m.role}</span>
                    )}
                  </Td>
                  <Td className="hidden text-fg-muted sm:table-cell">
                    <RelativeTime value={m.createdAt} />
                  </Td>
                  <Td>
                    {isAdmin && !self && m.role !== 'owner' && (
                      <IconButton
                        label={`Remove ${m.email}`}
                        icon={<Trash2 className="size-3.5" />}
                        onClick={async () => {
                          if (!(await confirm({ title: `Remove ${m.name || m.email}?`, body: 'They lose access to this workspace immediately.', danger: true, confirmText: 'Remove' }))) return;
                          remove.mutate(m.userId, { onSuccess: () => toast.success('Member removed'), onError: (err) => toast.fromError(err, 'Could not remove member') });
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
      <div className="mt-5 grid gap-2 text-xs text-fg-subtle sm:grid-cols-2">
        {ROLE_OPTIONS.map((r) => (
          <p key={r.value}>
            <span className="font-medium text-fg-muted">{r.label}:</span> {ROLE_HELP[r.value]}
          </p>
        ))}
      </div>
    </Section>
  );
}

function NotificationsSection() {
  const { ws, isAdmin } = useWorkspace();
  const settings = useNotifications(ws);
  const update = useUpdateNotifications(ws);
  const toast = useToast();
  const [webhookUrl, setWebhookUrl] = useState('');
  const [notifyOn, setNotifyOn] = useState('failure');
  const [editing, setEditing] = useState(false);
  const reset = () => {
    if (settings.data) {
      setWebhookUrl(settings.data.webhookUrl ?? '');
      setNotifyOn(settings.data.notifyOn || 'failure');
    }
  };
  useEffect(reset, [settings.data]);
  const invalid = !!webhookUrl && !/^https?:\/\/\S+$/.test(webhookUrl);
  return (
    <Section id="notifications" title="Notifications" description="NAV POSTs a JSON payload to your webhook (Slack/Discord-compatible endpoints work) when events happen.">
      {settings.isPending ? (
        <SkeletonRows rows={2} />
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await update.mutateAsync({ webhookUrl: webhookUrl.trim() || null, notifyOn });
              toast.success('Notification settings saved');
              setEditing(false);
            } catch (err) {
              toast.fromError(err, 'Could not save notifications');
            }
          }}
        >
          <Row label="Webhook URL" description="Where notifications are delivered.">
            <Field error={invalid ? 'Enter an http(s) URL.' : null}>
              {(id) => (
                <Input id={id} tall mono value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" disabled={!editing} aria-label="Webhook URL" />
              )}
            </Field>
          </Row>
          <Row label="Notify on" description="Which deploy events trigger a notification.">
            <Select
              aria-label="Notify on"
              value={notifyOn}
              disabled={!editing}
              onChange={(e) => setNotifyOn(e.target.value)}
              options={[
                { value: 'all', label: 'All deploy events' },
                { value: 'failure', label: 'Failures only' },
                { value: 'none', label: 'Nothing (paused)' },
              ]}
            />
            {editing ? (
              <EditActions
                onCancel={() => {
                  reset();
                  setEditing(false);
                }}
                loading={update.isPending}
                disabled={invalid}
              />
            ) : (
              isAdmin && <EditLink onClick={() => setEditing(true)} label="Edit notification settings" />
            )}
          </Row>
        </form>
      )}
    </Section>
  );
}

function IntegrationsSection() {
  const { user, config } = useWorkspace();
  const enabled = !!config?.githubEnabled;
  return (
    <Section id="integrations" title="Integrations" description="Connect GitHub to pick repositories, auto-deploy on push and create PR previews.">
      <div className="flex flex-wrap items-center gap-4 py-2">
        <Github className="size-8 text-fg" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          {!enabled ? (
            <>
              <p className="text-[14px] font-semibold">GitHub is not configured on this NAV instance</p>
              <p className="text-[13px] text-fg-muted">An operator must set the GitHub App credentials on the control plane. You can still deploy any public Git URL.</p>
            </>
          ) : user.githubLogin ? (
            <>
              <p className="flex items-center gap-1.5 text-[14px] font-semibold">
                <CheckCircle2 className="size-4 text-success" /> Connected as @{user.githubLogin}
              </p>
              <p className="text-[13px] text-fg-muted">Repositories from your account and app installations are available in the new service wizard.</p>
            </>
          ) : (
            <>
              <p className="text-[14px] font-semibold">GitHub not connected</p>
              <p className="text-[13px] text-fg-muted">Authorize NAV to read your repositories.</p>
            </>
          )}
        </div>
        {enabled && (
          <div className="flex flex-wrap gap-2">
            {config?.githubAppSlug && (
              <a className={buttonClass('secondary', 'md')} href={`https://github.com/apps/${config.githubAppSlug}/installations/new`} target="_blank" rel="noreferrer">
                Configure app access
              </a>
            )}
            {!user.githubLogin && (
              <a className={buttonClass('primary', 'md')} href={GITHUB_LOGIN_URL}>
                <Github className="size-4" /> Connect GitHub
              </a>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

/** Highlights the section currently in view. */
function useActiveSection(): string {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-60px 0px -55% 0px' },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);
  return active;
}

export function WorkspaceSettingsPage() {
  useTitle('Settings');
  const { workspace } = useWorkspace();
  const { hash } = useLocation();
  const active = useActiveSection();

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, [hash]);

  return (
    <div>
      <div className="mb-10">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] leading-tight font-normal tracking-[-0.02em] text-fg md:text-[30px]">Workspace settings</h1>
          <Badge tone="accent" className="font-mono tracking-wider uppercase">
            {workspace.role}
          </Badge>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[13.5px] text-fg-muted">
          Workspace ID: <code className="font-mono text-[13px] text-fg">{workspace.id}</code>
          <CopyButton value={workspace.id} label="Copy workspace ID" size="xs" />
        </div>
      </div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_200px]">
        <div className="min-w-0 space-y-8">
          <GeneralSection />
          <MembersSection />
          <NotificationsSection />
          <IntegrationsSection />
        </div>
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-[86px] space-y-1 border-l border-border-strong pl-4">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={active === s.id ? 'location' : undefined}
                  className={cn('block py-1 text-[14px] transition-colors hover:text-fg', active === s.id ? 'text-fg' : 'text-fg-muted')}
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

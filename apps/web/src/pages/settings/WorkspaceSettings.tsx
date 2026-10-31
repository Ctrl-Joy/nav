import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Mail, Trash2, UserPlus } from 'lucide-react';
import { Github } from '@/components/GithubIcon';
import type { Role } from '@nav/shared';
import { GITHUB_LOGIN_URL } from '@/api/auth';
import { useAddMember, useMembers, useNotifications, useRemoveMember, useUpdateMember, useUpdateNotifications, useUpdateWorkspace } from '@/api/workspaces';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CopyField,
  ErrorState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  SettingRow,
  SkeletonRows,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tabs,
  Tr,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';

type Tab = 'general' | 'members' | 'notifications' | 'integrations';

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

function GeneralTab() {
  const { ws, workspace, isAdmin } = useWorkspace();
  const update = useUpdateWorkspace(ws);
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  useEffect(() => setName(workspace.name), [workspace.name]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync(name.trim());
      toast.success('Workspace renamed');
    } catch (err) {
      toast.fromError(err, 'Could not rename workspace');
    }
  };
  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader title="General" />
        <SettingRow title="Workspace name" description="Shown in the sidebar and in notifications.">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} aria-label="Workspace name" />
        </SettingRow>
        <SettingRow title="Workspace ID" description="Use with the CLI and API.">
          <CopyField value={workspace.id} />
        </SettingRow>
        <SettingRow title="Slug">
          <CopyField value={workspace.slug} />
        </SettingRow>
        <SettingRow title="Your role">
          <div className="flex items-center gap-2 text-[13px]">
            <Badge tone="accent" className="capitalize">
              {workspace.role}
            </Badge>
            <span className="text-fg-subtle">{ROLE_HELP[workspace.role]}</span>
          </div>
        </SettingRow>
        {isAdmin && (
          <CardFooter>
            <Button type="submit" variant="primary" loading={update.isPending} disabled={!name.trim() || name.trim() === workspace.name}>
              Save
            </Button>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}

function MembersTab() {
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
    <div className="space-y-5">
      {isAdmin && (
        <Card>
          <CardHeader title="Invite a teammate" description="Existing NAV users are added immediately; others get a pending invite." />
          <form onSubmit={invite} className="flex flex-wrap items-end gap-3 p-4">
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
            <div className="border-t border-border px-4 py-3">
              <p className="mb-2 text-xs text-fg-muted">Invite token (shown once) — share it if your NAV instance requires tokens for sign-up:</p>
              <CopyField value={inviteToken} />
            </div>
          )}
        </Card>
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
              <Th className="w-10" />
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
      <div className="grid gap-2 text-xs text-fg-subtle sm:grid-cols-2">
        {ROLE_OPTIONS.map((r) => (
          <p key={r.value}>
            <span className="font-medium text-fg-muted">{r.label}:</span> {ROLE_HELP[r.value]}
          </p>
        ))}
      </div>
    </div>
  );
}

function NotificationsTab() {
  const { ws, isAdmin } = useWorkspace();
  const settings = useNotifications(ws);
  const update = useUpdateNotifications(ws);
  const toast = useToast();
  const [webhookUrl, setWebhookUrl] = useState('');
  const [notifyOn, setNotifyOn] = useState('failure');
  useEffect(() => {
    if (settings.data) {
      setWebhookUrl(settings.data.webhookUrl ?? '');
      setNotifyOn(settings.data.notifyOn || 'failure');
    }
  }, [settings.data]);
  if (settings.isPending) return <SkeletonRows rows={2} />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const invalid = !!webhookUrl && !/^https?:\/\/\S+$/.test(webhookUrl);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await update.mutateAsync({ webhookUrl: webhookUrl.trim() || null, notifyOn });
          toast.success('Notification settings saved');
        } catch (err) {
          toast.fromError(err, 'Could not save notifications');
        }
      }}
    >
      <Card>
        <CardHeader title="Notifications" description="NAV POSTs a JSON payload to your webhook (Slack/Discord-compatible endpoints work) when events happen." />
        <SettingRow title="Webhook URL">
          <Field error={invalid ? 'Enter an http(s) URL.' : null}>
            {(id) => <Input id={id} mono value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" disabled={!isAdmin} />}
          </Field>
        </SettingRow>
        <SettingRow title="Notify on">
          <Select
            className="sm:w-64"
            aria-label="Notify on"
            value={notifyOn}
            disabled={!isAdmin}
            onChange={(e) => setNotifyOn(e.target.value)}
            options={[
              { value: 'all', label: 'All deploy events' },
              { value: 'failure', label: 'Failures only' },
              { value: 'none', label: 'Nothing (paused)' },
            ]}
          />
        </SettingRow>
        {isAdmin && (
          <CardFooter>
            <Button type="submit" variant="primary" loading={update.isPending} disabled={invalid}>
              Save
            </Button>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}

function IntegrationsTab() {
  const { user, config } = useWorkspace();
  const enabled = !!config?.githubEnabled;
  return (
    <Card>
      <CardHeader title="GitHub" description="Connect GitHub to pick repositories, auto-deploy on push and create PR previews." />
      <div className="flex flex-wrap items-center gap-4 p-4">
        <Github className="size-8 text-fg" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          {!enabled ? (
            <>
              <p className="text-[13px] font-medium">Not configured on this NAV instance</p>
              <p className="text-xs text-fg-subtle">An operator must set the GitHub App credentials on the control plane. You can still deploy any public Git URL.</p>
            </>
          ) : user.githubLogin ? (
            <>
              <p className="flex items-center gap-1.5 text-[13px] font-medium">
                <CheckCircle2 className="size-4 text-success" /> Connected as @{user.githubLogin}
              </p>
              <p className="text-xs text-fg-subtle">Repositories from your account and app installations are available in the new service wizard.</p>
            </>
          ) : (
            <>
              <p className="text-[13px] font-medium">Not connected</p>
              <p className="text-xs text-fg-subtle">Authorize NAV to read your repositories.</p>
            </>
          )}
        </div>
        {enabled && (
          <div className="flex flex-wrap gap-2">
            {config?.githubAppSlug && (
              <a className="inline-flex h-8 items-center rounded-lg border border-border bg-surface-2 px-3 text-[13px] font-medium hover:bg-surface-3" href={`https://github.com/apps/${config.githubAppSlug}/installations/new`} target="_blank" rel="noreferrer">
                Configure app access
              </a>
            )}
            {!user.githubLogin && (
              <a className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent-strong" href={GITHUB_LOGIN_URL}>
                <Github className="size-4" /> Connect GitHub
              </a>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function WorkspaceSettingsPage() {
  useTitle('Settings');
  const [tab, setTab] = useState<Tab>('general');
  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" description="Workspace, team and integrations." />
      <Tabs
        className="mb-6"
        label="Settings sections"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'general', label: 'General' },
          { value: 'members', label: 'Members' },
          { value: 'notifications', label: 'Notifications' },
          { value: 'integrations', label: 'Integrations' },
        ]}
      />
      {tab === 'general' && <GeneralTab />}
      {tab === 'members' && <MembersTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'integrations' && <IntegrationsTab />}
    </div>
  );
}

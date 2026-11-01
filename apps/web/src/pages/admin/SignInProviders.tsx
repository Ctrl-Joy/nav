import { useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, ExternalLink, LockKeyhole, ShieldCheck, XCircle } from 'lucide-react';
import { useMe } from '@/api/auth';
import {
  useAuthProviders,
  useDeleteAuthProvider,
  useSaveAuthProvider,
  useTestAuthProvider,
  type AuthProviderSettings,
  type ProviderCheck,
} from '@/api/admin';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CopyField,
  Empty,
  ErrorState,
  Field,
  Input,
  PageHeader,
  SkeletonRows,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useTitle } from '@/lib/useTitle';
import { ProviderIcon } from '../auth/providers';

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

const B = ({ children }: { children: ReactNode }) => <span className="font-medium text-fg">{children}</span>;

/** Where to create the OAuth app, and what to fill in. */
function guide(p: AuthProviderSettings): { consoleUrl: string; consoleLabel: string; steps: ReactNode[]; idLabel: string; secretLabel: string } {
  const callback = <B>{p.name === 'Google' ? 'Authorized redirect URIs' : p.name === 'GitLab' ? 'Redirect URI' : p.name === 'Bitbucket' ? 'Callback URL' : 'Authorization callback URL'}</B>;
  switch (p.provider) {
    case 'github':
      return {
        consoleUrl: 'https://github.com/settings/applications/new',
        consoleLabel: 'New OAuth App on GitHub',
        idLabel: 'Client ID',
        secretLabel: 'Client secret',
        steps: [
          <>Open <A href="https://github.com/settings/applications/new">GitHub → Settings → Developer settings → OAuth Apps → New OAuth App</A>. For an organization, use its Settings → Developer settings instead.</>,
          <>Name it (for example “NAV”), set <B>Homepage URL</B> to <code className="font-mono text-[12px]">{window.location.origin}</code> and paste the callback URL below into {callback}.</>,
          <>Click <B>Register application</B>, then <B>Generate a new client secret</B>.</>,
          <>Paste the Client ID and the secret here, then Save and Test.</>,
        ],
      };
    case 'gitlab': {
      const base = p.baseUrl ?? 'https://gitlab.com';
      const url = `${base}/-/user_settings/applications`;
      return {
        consoleUrl: url,
        consoleLabel: 'Applications on GitLab',
        idLabel: 'Application ID',
        secretLabel: 'Secret',
        steps: [
          <>Open <A href={url}>{base.replace(/^https?:\/\//, '')} → Preferences → Applications</A> and choose <B>Add new application</B> (a group or instance-wide application works too).</>,
          <>Name it “NAV”, paste the callback URL below into {callback}, keep <B>Confidential</B> checked and tick the <B>read_user</B> scope.</>,
          <>Click <B>Save application</B> and copy the <B>Application ID</B> and <B>Secret</B>.</>,
          <>For self-managed GitLab, enter its address below. Then Save and Test.</>,
        ],
      };
    }
    case 'bitbucket':
      return {
        consoleUrl: 'https://bitbucket.org/account/workspaces/',
        consoleLabel: 'Your Bitbucket workspaces',
        idLabel: 'Key',
        secretLabel: 'Secret',
        steps: [
          <>In Bitbucket, open <A href="https://bitbucket.org/account/workspaces/">your workspace</A> → <B>Settings</B> → <B>Apps and features → OAuth consumers</B> (the page is <code className="font-mono text-[12px]">bitbucket.org/&lt;workspace&gt;/workspace/settings/api</code>) and click <B>Add consumer</B>.</>,
          <>Name it “NAV”, paste the callback URL below into {callback} and tick <B>This is a private consumer</B>.</>,
          <>Under permissions tick <B>Account: Email</B> and <B>Account: Read</B>, then <B>Save</B>.</>,
          <>Click the consumer’s name to reveal its <B>Key</B> and <B>Secret</B>, paste them here, then Save and Test.</>,
        ],
      };
    case 'google':
      return {
        consoleUrl: 'https://console.cloud.google.com/apis/credentials',
        consoleLabel: 'Google Cloud credentials',
        idLabel: 'Client ID',
        secretLabel: 'Client secret',
        steps: [
          <>Open <A href="https://console.cloud.google.com/apis/credentials">Google Cloud console → APIs &amp; Services → Credentials</A> and pick (or create) a project. If asked, configure the <B>OAuth consent screen</B> first (External, your app name and support email).</>,
          <>Choose <B>Create credentials → OAuth client ID</B> with application type <B>Web application</B>.</>,
          <>Paste the callback URL below into {callback} and click <B>Create</B>.</>,
          <>Copy the Client ID (it ends in <code className="font-mono text-[12px]">.apps.googleusercontent.com</code>) and the secret here, then Save and Test.</>,
        ],
      };
  }
}

function StatusBadge({ p }: { p: AuthProviderSettings }) {
  if (p.source === 'environment') return <Badge tone={p.enabled ? 'success' : 'warning'}>{p.enabled ? 'On · environment' : 'Incomplete · environment'}</Badge>;
  if (p.enabled) return <Badge tone="success">On</Badge>;
  return <Badge>Off</Badge>;
}

const checkIcon: Record<ProviderCheck['status'], ReactNode> = {
  pass: <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passed" />,
  fail: <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />,
  warn: <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />,
  skip: <CircleSlash className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-label="Not checked" />,
};

function ProviderCard({ p }: { p: AuthProviderSettings }) {
  const g = guide(p);
  const save = useSaveAuthProvider(p.provider);
  const remove = useDeleteAuthProvider(p.provider);
  const test = useTestAuthProvider(p.provider);
  const toast = useToast();
  const confirm = useConfirm();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const savedBaseUrl = p.provider === 'gitlab' && p.source === 'database' && p.baseUrl !== 'https://gitlab.com' ? (p.baseUrl ?? '') : '';
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const configured = p.source === 'database';
  const unreadable = !!p.saved?.unreadable && p.source !== 'environment';
  // Blank fields keep what is saved, so a first save needs both values and later saves need any change.
  const canSave = !p.readOnly && (configured && !unreadable ? !!(clientId.trim() || clientSecret.trim() || baseUrl.trim() !== savedBaseUrl) : !!((clientId.trim() || configured) && clientSecret.trim()));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    try {
      await save.mutateAsync({
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret.trim() || undefined,
        ...(p.provider === 'gitlab' ? { baseUrl: baseUrl.trim() || null } : {}),
      });
      setClientId('');
      setClientSecret('');
      test.reset();
      toast.success(`${p.name} sign-in saved`, 'The button on the sign-in page is now active.');
    } catch (err) {
      toast.fromError(err, `Could not save ${p.name}`);
    }
  };

  const runTest = () =>
    test.mutate(
      p.readOnly ? {} : { clientId: clientId.trim() || undefined, clientSecret: clientSecret.trim() || undefined, ...(p.provider === 'gitlab' ? { baseUrl: baseUrl.trim() || null } : {}) },
      { onError: (e) => toast.fromError(e, 'Could not run the test') },
    );

  const disable = async () => {
    const ok = await confirm({
      title: `Turn off ${p.name} sign-in?`,
      body: `The saved client ID and secret are deleted. People who only sign in with ${p.name} will need a password reset or another connected account.`,
      danger: true,
      confirmText: 'Turn off',
    });
    if (ok) remove.mutate(undefined, { onSuccess: () => toast.success(`${p.name} sign-in turned off`), onError: (e) => toast.fromError(e, `Could not turn off ${p.name}`) });
  };

  const formId = `provider-${p.provider}`;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex size-5 [&>svg]:size-5">
              <ProviderIcon provider={p.provider} />
            </span>
            {p.name}
            <StatusBadge p={p} />
          </span>
        }
        description={
          p.source === 'database' && p.saved ? (
            <>
              Client ID {p.clientIdHint} · secret set · saved <RelativeTime value={p.saved.updatedAt} />
              {p.saved.updatedBy ? ` by ${p.saved.updatedBy}` : ''}
            </>
          ) : p.source === 'environment' ? (
            <>Client ID {p.clientIdHint ?? 'not set'} · secret {p.clientSecretSet ? 'set' : 'not set'}</>
          ) : (
            'Not set up. The button on the sign-in page stays disabled until you add credentials.'
          )
        }
        actions={
          <a href={g.consoleUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline">
            {g.consoleLabel}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        }
      />
      <CardBody className="space-y-5">
        {p.readOnly && (
          <div className="flex items-start gap-2 rounded-[3px] border border-border-strong bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">
            <LockKeyhole className="mt-0.5 size-4 shrink-0" />
            <div>
              Configured by environment, read-only. This server sets <code className="font-mono text-[12px]">{p.envVars.slice(0, 2).join(', ')}</code>, which take precedence over anything saved here. Change or remove them and restart NAV to manage {p.name} from this page.
              {p.saved && ' A saved configuration also exists and is used if the variables are removed.'}
            </div>
          </div>
        )}
        {unreadable && (
          <div className="flex items-start gap-2 rounded-[3px] border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            The saved secret can't be decrypted, probably because NAV_MASTER_KEY changed. Enter the client ID and secret again.
          </div>
        )}

        <details open={!p.enabled} className="group">
          <summary className="cursor-pointer text-[13px] font-medium text-fg select-none">Set up the OAuth app</summary>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] text-fg-muted marker:text-fg-subtle">
            {g.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>

        <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-fg">Callback URL</div>
            <CopyField value={p.callbackUrl} />
            <p className="mt-1.5 text-xs text-fg-subtle">Register exactly this URL. It comes from NAV_API_PUBLIC_URL.</p>
          </div>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-fg">Scopes</div>
            <div className="flex flex-wrap gap-1.5">
              {p.scopes.map((s) => (
                <Badge key={s} mono>
                  {s}
                </Badge>
              ))}
            </div>
            {p.provider === 'github' && <p className="mt-1.5 text-xs text-fg-subtle">repo lets people deploy their private repositories.</p>}
          </div>
        </div>

        {!p.readOnly && (
          <form id={formId} onSubmit={submit} className="grid gap-4 md:grid-cols-2">
            <Field label={g.idLabel} hint={configured ? `Saved (${p.clientIdHint}). Leave blank to keep it.` : undefined}>
              {(id) => <Input id={id} mono autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={configured ? `${p.clientIdHint ?? ''} (saved)` : ''} />}
            </Field>
            <Field label={g.secretLabel} hint={configured && !unreadable ? 'Set. Leave blank to keep it; it is never shown again.' : 'Stored encrypted; never shown again.'}>
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="password"
                  autoComplete="new-password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={configured && !unreadable ? '•••••••• (set)' : ''}
                />
              )}
            </Field>
            {p.provider === 'gitlab' && (
              <Field label="GitLab URL" optional hint="Only for self-managed GitLab, for example https://gitlab.example.com." className="md:col-span-2">
                {(id) => <Input id={id} mono value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://gitlab.com" />}
              </Field>
            )}
          </form>
        )}

        {test.data && (
          <div className="rounded-[3px] border border-border-strong px-3 py-2.5" role="status">
            <div className={`text-[13px] font-medium ${test.data.ok === true ? 'text-success' : test.data.ok === false ? 'text-danger' : 'text-fg'}`}>{test.data.summary}</div>
            <ul className="mt-2 space-y-1.5">
              {test.data.checks.map((c) => (
                <li key={c.label} className="flex items-start gap-2 text-[13px]">
                  {checkIcon[c.status]}
                  <span>
                    <span className="font-medium text-fg">{c.label}.</span> <span className="text-fg-muted">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
      <CardFooter className="justify-between">
        <div>
          {configured && (
            <Button variant="outline-danger" onClick={disable} loading={remove.isPending}>
              Disable
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={runTest} loading={test.isPending} disabled={!p.enabled && !(clientId.trim() && clientSecret.trim())} title="Checks the credentials with the provider without signing anyone in">
            Test
          </Button>
          {!p.readOnly && (
            <Button type="submit" form={formId} variant="primary" loading={save.isPending} disabled={!canSave}>
              Save
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}

export function SignInProvidersPage() {
  useTitle('Sign-in providers');
  const me = useMe();
  const isAdmin = !!me.data?.user.isPlatformAdmin;
  const providers = useAuthProviders(isAdmin);

  if (me.isPending) return <SkeletonRows rows={4} />;
  if (!isAdmin) {
    return (
      <div className="max-w-4xl">
        <Empty
          icon={<ShieldCheck className="size-4" />}
          title="Instance administrators only"
          description="Sign-in providers are set by the people who run this NAV server: the addresses in NAV_ADMIN_EMAILS, or the first account created."
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Sign-in providers"
        description="Let people sign in to this NAV server with GitHub, GitLab, Bitbucket or Google. Create an OAuth app with the provider, then paste its credentials here."
      />
      {providers.isPending ? (
        <SkeletonRows rows={4} />
      ) : providers.isError ? (
        <ErrorState error={providers.error} onRetry={() => providers.refetch()} />
      ) : (
        <div className="space-y-6">
          {providers.data.items.map((p) => (
            <ProviderCard key={p.provider} p={p} />
          ))}
          <p className="text-[13px] text-fg-subtle">
            Only instance administrators see this page. Environment variables (NAV_GITHUB_CLIENT_ID and friends) still work and always take precedence.
            Single sign-on (OpenID Connect) is configured with the NAV_SSO_* variables.
          </p>
        </div>
      )}
    </div>
  );
}

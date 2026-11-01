import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Laptop, Monitor, Moon, Pencil, Smartphone, Sun, X } from 'lucide-react';
import {
  providerUrl, useChangeEmail, useChangePassword, useDeleteAccount, useDisconnectIdentity, useIdentities, useMe,
  useRevokeSession, useSessions, useUpdateProfile,
} from '@/api/auth';
import { errorMessage } from '@/api/client';
import type { AuthProvider, SessionInfo } from '@/api/types';
import { RelativeTime } from '@/components/RelativeTime';
import { Button, Dialog, useConfirm, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { getTheme, setTheme, type Theme } from '@/lib/theme';
import { useTitle } from '@/lib/useTitle';
import { PROVIDER_NAMES, ProviderIcon, oauthErrorMessage } from '../auth/providers';

const SECTIONS = [
  ['profile', 'Profile'],
  ['appearance', 'Appearance'],
  ['security', 'Account Security'],
  ['connections', 'Connections'],
  ['api-keys', 'API Keys'],
  ['delete', 'Delete Account'],
] as const;

const CONNECTABLE: AuthProvider[] = ['github', 'gitlab', 'bitbucket', 'google'];

const inputCls =
  'h-11 w-full border border-border-strong bg-surface-2 px-3.5 text-[15px] text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-fg disabled:cursor-default disabled:text-fg-muted';

function Section({ id, title, children, danger }: { id: string; title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section id={id} className={cn('scroll-mt-24 border p-6 sm:p-10', danger ? 'border-danger/40' : 'border-border-strong')}>
      <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
      <div className="mt-8 space-y-10">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-8">
      <div>
        <div className="text-[16px] font-semibold text-fg">{label}</div>
        {hint && <p className="mt-1.5 max-w-[34ch] text-[13.5px] leading-relaxed text-fg-muted">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function EditLink({ onClick, label = 'Edit' }: { onClick: () => void; label?: string }) {
  return (
    <div className="mt-3 flex justify-end">
      <button type="button" onClick={onClick} className="inline-flex items-center gap-2 px-2 py-1 text-[14.5px] text-fg hover:text-accent">
        <Pencil className="size-4" aria-hidden="true" /> {label}
      </button>
    </div>
  );
}

function SaveBar({ busy, onCancel, label = 'Save' }: { busy: boolean; onCancel: () => void; label?: string }) {
  return (
    <div className="mt-3 flex justify-end gap-2">
      <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy}>{label}</Button>
    </div>
  );
}

/** "Mozilla/5.0 (Windows NT 10.0…) … Chrome/…" -> "Chrome on Windows". */
function describeAgent(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false };
  if (/^nav-cli|node/i.test(ua)) return { label: 'NAV CLI', mobile: false };
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return { label: `${browser} on ${os}`, mobile: /Mobile|Android|iPhone/.test(ua) };
}

function Avatar({ name, url, size = 80 }: { name: string; url: string | null; size?: number }) {
  if (url) return <img src={url} alt="" referrerPolicy="no-referrer" className="rounded-full object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="grid place-items-center rounded-full bg-[#fbeea4] font-normal text-[#2b2b2b]" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function ProfileSection() {
  const me = useMe();
  const user = me.data?.user;
  const identities = useIdentities();
  const update = useUpdateProfile();
  const changeEmail = useChangeEmail();
  const toast = useToast();
  const [editing, setEditing] = useState<'name' | 'email' | 'avatar' | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  if (!user) return null;

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    update.mutate({ name }, { onSuccess: () => { setEditing(null); toast.success('Name updated'); }, onError: (err) => toast.error('Could not update name', errorMessage(err)) });
  };
  const saveEmail = (e: FormEvent) => {
    e.preventDefault();
    changeEmail.mutate(
      { email, currentPassword: user.hasPassword ? pw : undefined },
      { onSuccess: () => { setEditing(null); setPw(''); toast.success('Email updated'); }, onError: (err) => toast.error('Could not change email', errorMessage(err)) },
    );
  };
  const avatars = (identities.data?.items ?? []).filter((i) => i.avatarUrl);

  return (
    <Section id="profile" title="Profile">
      <Row label="Full Name">
        {editing === 'name' ? (
          <form onSubmit={saveName}>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} aria-label="Full name" maxLength={100} autoFocus required />
            <SaveBar busy={update.isPending} onCancel={() => setEditing(null)} />
          </form>
        ) : (
          <>
            <input className={inputCls} value={user.name} disabled aria-label="Full name" />
            <EditLink onClick={() => { setName(user.name); setEditing('name'); }} />
          </>
        )}
      </Row>
      <Row label="Email" hint={user.emailVerified ? undefined : 'Not verified yet. Signing in with a provider that uses this address, or resetting your password, verifies it.'}>
        {editing === 'email' ? (
          <form onSubmit={saveEmail} className="space-y-3">
            <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" autoComplete="email" autoFocus required />
            {user.hasPassword && (
              <input className={inputCls} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Current password" aria-label="Current password" autoComplete="current-password" required />
            )}
            <SaveBar busy={changeEmail.isPending} onCancel={() => { setEditing(null); setPw(''); }} />
          </form>
        ) : (
          <>
            <input className={inputCls} value={user.email} disabled aria-label="Email" />
            <EditLink onClick={() => { setEmail(user.email); setEditing('email'); }} />
          </>
        )}
      </Row>
      <Row label="Avatar" hint={editing === 'avatar' ? 'Use your initial, or the picture from a connected account.' : undefined}>
        {editing === 'avatar' ? (
          <div>
            <div className="flex flex-wrap gap-3">
              {[null, ...avatars.map((a) => a.avatarUrl)].map((url) => (
                <button
                  key={url ?? 'initial'}
                  type="button"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ avatarUrl: url }, { onSuccess: () => setEditing(null), onError: (err) => toast.error('Could not update avatar', errorMessage(err)) })}
                  className={cn('rounded-full p-1 ring-2 transition', (user.avatarUrl ?? null) === url ? 'ring-accent' : 'ring-transparent hover:ring-border-strong')}
                  aria-label={url ? 'Use this picture' : 'Use my initial'}
                >
                  <Avatar name={user.name} url={url} size={64} />
                </button>
              ))}
            </div>
            {!avatars.length && <p className="mt-3 text-[13.5px] text-fg-muted">Connect GitHub, GitLab, Bitbucket or Google below to use its picture.</p>}
            <div className="mt-3 flex"><Button variant="ghost" onClick={() => setEditing(null)}>Done</Button></div>
          </div>
        ) : (
          <div className="inline-flex flex-col items-center">
            <Avatar name={user.name} url={user.avatarUrl} />
            <button type="button" onClick={() => setEditing('avatar')} className="mt-3 inline-flex items-center gap-2 px-2 py-1 text-[14.5px] text-fg hover:text-accent">
              <Pencil className="size-4" aria-hidden="true" /> Edit
            </button>
          </div>
        )}
      </Row>
    </Section>
  );
}

function AppearanceSection() {
  const [theme, setT] = useState<Theme>(getTheme());
  useEffect(() => {
    const on = (e: Event) => setT((e as CustomEvent<Theme>).detail);
    window.addEventListener('nav:theme', on);
    return () => window.removeEventListener('nav:theme', on);
  }, []);
  const options: [Theme, string, typeof Sun][] = [['dark', 'Dark', Moon], ['light', 'Light', Sun]];
  return (
    <Section id="appearance" title="Appearance">
      <Row label="Theme" hint="Applies to the dashboard on this device.">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3">
          {options.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => { setTheme(value); setT(value); }}
              className={cn('flex h-12 items-center gap-3 border px-4 text-[15px] transition-colors', theme === value ? 'border-accent bg-accent-soft text-fg' : 'border-border-strong text-fg-muted hover:text-fg')}
            >
              <Icon className="size-4" aria-hidden="true" /> {label}
              {theme === value && <Check className="ml-auto size-4" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

function SessionRow({ s, onRevoke, busy }: { s: SessionInfo; onRevoke: () => void; busy: boolean }) {
  const agent = describeAgent(s.userAgent);
  const Icon = agent.mobile ? Smartphone : agent.label === 'NAV CLI' ? Monitor : Laptop;
  return (
    <li className="flex items-center gap-4 py-3.5">
      <Icon className="size-5 shrink-0 text-fg-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[15px] text-fg">
          {agent.label}
          {s.current && <span className="bg-success-soft px-1.5 py-0.5 text-[11px] font-medium text-success">This device</span>}
        </div>
        <div className="mt-0.5 text-[13px] text-fg-muted">
          {s.ip ?? 'unknown IP'} · signed in <RelativeTime value={s.createdAt} />
        </div>
      </div>
      {!s.current && <Button size="sm" variant="ghost" onClick={onRevoke} disabled={busy} aria-label={`Sign out ${agent.label}`}><X className="size-4" /> Sign out</Button>}
    </li>
  );
}

function SecuritySection() {
  const me = useMe();
  const user = me.data?.user;
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const change = useChangePassword();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  if (!user) return null;
  const others = (sessions.data?.items ?? []).filter((s) => !s.current).length;

  const save = (e: FormEvent) => {
    e.preventDefault();
    change.mutate(
      { currentPassword: user.hasPassword ? current : undefined, newPassword: next },
      {
        onSuccess: () => { setEditing(false); setCurrent(''); setNext(''); toast.success(user.hasPassword ? 'Password changed' : 'Password set', 'Other sessions were signed out.'); },
        onError: (err) => toast.error('Could not change password', errorMessage(err)),
      },
    );
  };

  return (
    <Section id="security" title="Account Security">
      <Row label="Password" hint={user.hasPassword ? 'Changing it signs you out everywhere else.' : 'You sign in with a connected account. Set a password to sign in with your email too.'}>
        {editing ? (
          <form onSubmit={save} className="space-y-3">
            {user.hasPassword && <input className={inputCls} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" aria-label="Current password" autoComplete="current-password" autoFocus required />}
            <input className={inputCls} type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (at least 8 characters)" aria-label="New password" autoComplete="new-password" minLength={8} autoFocus={!user.hasPassword} required />
            <SaveBar busy={change.isPending} onCancel={() => { setEditing(false); setCurrent(''); setNext(''); }} label={user.hasPassword ? 'Change password' : 'Set password'} />
          </form>
        ) : (
          <>
            <input className={inputCls} value={user.hasPassword ? '••••••••••••' : 'No password set'} disabled aria-label="Password" />
            <EditLink onClick={() => setEditing(true)} label={user.hasPassword ? 'Change' : 'Set password'} />
          </>
        )}
      </Row>
      <Row label="Sessions" hint="Browsers and devices signed in to your account.">
        <ul className="divide-y divide-border border-y border-border">
          {(sessions.data?.items ?? []).map((s) => (
            <SessionRow key={s.id} s={s} busy={revoke.isPending} onRevoke={() => revoke.mutate(s.id, { onError: (err) => toast.error('Could not sign out session', errorMessage(err)) })} />
          ))}
          {sessions.isLoading && <li className="py-3.5 text-[14px] text-fg-muted">Loading sessions…</li>}
        </ul>
        {others > 0 && (
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" onClick={() => revoke.mutate('others', { onSuccess: () => toast.success('Signed out other sessions') })} loading={revoke.isPending}>
              Sign out {others} other {others === 1 ? 'session' : 'sessions'}
            </Button>
          </div>
        )}
      </Row>
    </Section>
  );
}

function ConnectionsSection() {
  const identities = useIdentities();
  const disconnect = useDisconnectIdentity();
  const confirm = useConfirm();
  const toast = useToast();
  const items = identities.data?.items ?? [];
  const available = identities.data?.available ?? {};
  const shown = CONNECTABLE.concat(available.sso || items.some((i) => i.provider === 'sso') ? ['sso'] : []);

  const remove = async (p: AuthProvider) => {
    const ok = await confirm({ title: `Disconnect ${PROVIDER_NAMES[p]}?`, body: `You won't be able to sign in with ${PROVIDER_NAMES[p]} until you connect it again.`, confirmText: 'Disconnect', danger: true });
    if (!ok) return;
    disconnect.mutate(p, { onSuccess: () => toast.success(`${PROVIDER_NAMES[p]} disconnected`), onError: (err) => toast.error('Could not disconnect', errorMessage(err)) });
  };

  return (
    <Section id="connections" title="Connections">
      <p className="-mt-4 max-w-[60ch] text-[14.5px] text-fg-muted">Accounts you can sign in with. Connecting GitHub also lets NAV list your repositories when you create a service.</p>
      <ul className="divide-y divide-border border-y border-border">
        {shown.map((p) => {
          const linked = items.find((i) => i.provider === p);
          return (
            <li key={p} className="flex flex-wrap items-center gap-4 py-4">
              <span className="grid size-9 place-items-center border border-border-strong [&_svg]:size-[18px]"><ProviderIcon provider={p} /></span>
              <div className="min-w-0 flex-1">
                <div className="text-[15.5px] text-fg">{PROVIDER_NAMES[p]}</div>
                <div className="text-[13px] text-fg-muted">
                  {linked ? <>Connected{linked.username ? ` as ${linked.username}` : linked.email ? ` as ${linked.email}` : ''} · last used {linked.lastUsedAt ? <RelativeTime value={linked.lastUsedAt} /> : 'never'}</> : available[p] ? 'Not connected' : 'Not available on this NAV server'}
                </div>
              </div>
              {linked ? (
                <Button variant="secondary" onClick={() => remove(p)} disabled={disconnect.isPending}>Disconnect</Button>
              ) : available[p] && p !== 'sso' ? (
                <a href={providerUrl(p, { mode: 'connect' })} className="inline-flex h-8 items-center border border-border-strong px-3 text-[13px] text-fg hover:bg-surface-2">Connect</a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function ApiKeysSection() {
  const { workspaceId } = useParams();
  return (
    <Section id="api-keys" title="API Keys">
      <Row label="Personal API keys" hint="Use them with the NAV CLI and the REST API. Each key acts as you.">
        <p className="text-[14.5px] text-fg-muted">Create, view and revoke keys on the API keys page.</p>
        <div className="mt-3 flex justify-end">
          <Link to={`/w/${workspaceId}/api-keys`} className="inline-flex h-9 items-center border border-border-strong px-3.5 text-[14px] text-fg hover:bg-surface-2">Manage API keys</Link>
        </div>
      </Row>
    </Section>
  );
}

function DeleteSection() {
  const me = useMe();
  const user = me.data?.user;
  const del = useDeleteAccount();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [pw, setPw] = useState('');
  if (!user) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    del.mutate({ confirm: confirmText, password: user.hasPassword ? pw : undefined }, { onSuccess: () => navigate('/', { replace: true }) });
  };
  return (
    <Section id="delete" title="Delete Account" danger>
      <Row label="Delete your account" hint="Permanently removes your account, sessions, API keys and connections. Workspaces you own alone are deleted too once they're empty.">
        <div className="flex justify-end">
          <Button variant="outline-danger" onClick={() => setOpen(true)}>Delete account</Button>
        </div>
      </Row>
      <Dialog open={open} onClose={() => { if (!del.isPending) { setOpen(false); del.reset(); } }} title="Delete your account?" description="This can't be undone." dismissable={!del.isPending}>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-[14px] text-fg-muted" htmlFor="del-confirm">Type <span className="font-mono text-fg">{user.email}</span> to confirm</label>
          <input id="del-confirm" className={inputCls} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" autoFocus />
          {user.hasPassword && <input className={inputCls} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Current password" aria-label="Current password" autoComplete="current-password" required />}
          {del.error && <p role="alert" className="text-[14px] text-danger">{errorMessage(del.error)}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={del.isPending}>Cancel</Button>
            <Button type="submit" variant="danger" loading={del.isPending} disabled={confirmText.trim().toLowerCase() !== user.email}>Delete account</Button>
          </div>
        </form>
      </Dialog>
    </Section>
  );
}

function SideNav() {
  const [active, setActive] = useState<string>(SECTIONS[0][0]);
  const lock = useRef(false);
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    const io = new IntersectionObserver((entries) => {
      if (lock.current) return;
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { rootMargin: '-20% 0px -60% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <nav aria-label="Account settings sections" className="sticky top-24 hidden self-start border-l border-border-strong lg:block">
      {SECTIONS.map(([id, label]) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={active === id ? 'location' : undefined}
          onClick={() => { setActive(id); lock.current = true; window.setTimeout(() => { lock.current = false; }, 800); }}
          className={cn('block py-2 pl-5 text-[16px] transition-colors', active === id ? 'text-fg' : 'text-fg-muted hover:text-fg')}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function AccountSettingsPage() {
  useTitle('Account settings');
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const error = oauthErrorMessage(params.get('error'), params.get('provider'));

  // Results from the OAuth "connect" round trip come back as query params.
  useEffect(() => {
    const connected = params.get('connected') as AuthProvider | null;
    if (connected && PROVIDER_NAMES[connected]) {
      toast.success(`${PROVIDER_NAMES[connected]} connected`);
      setParams((p) => { p.delete('connected'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }), 150);
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-10 sm:px-10">
      <h1 className="text-[34px] font-normal tracking-[-0.02em] text-fg">Account settings</h1>
      {error && (
        <div role="alert" className="mt-6 flex items-start gap-3 border border-danger/40 bg-danger-soft px-4 py-3 text-[14.5px] text-fg">
          <span className="flex-1">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setParams((p) => { p.delete('error'); p.delete('provider'); return p; }, { replace: true })}><X className="size-4" /></button>
        </div>
      )}
      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="space-y-10">
          <ProfileSection />
          <AppearanceSection />
          <SecuritySection />
          <ConnectionsSection />
          <ApiKeysSection />
          <DeleteSection />
        </div>
        <SideNav />
      </div>
    </div>
  );
}

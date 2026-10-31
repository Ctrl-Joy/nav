import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  Boxes,
  Check,
  ChevronsUpDown,
  Database,
  FileStack,
  FolderKanban,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { useConfig, useLogout, useMe } from '@/api/auth';
import { useWorkspaceLiveUpdates } from '@/api/live';
import { useCreateWorkspace } from '@/api/workspaces';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Logo } from '@/components/Logo';
import { Button, Dialog, Dropdown, DropdownItem, DropdownLabel, DropdownSeparator, Empty, Field, IconButton, Input, Kbd, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { LAST_WORKSPACE_KEY, writeLocal } from '@/lib/misc';
import { useTheme } from '@/lib/theme';
import { CommandPalette } from './CommandPalette';
import { NewMenu } from './NewMenu';
import { FullPageSpinner } from './RootLayout';
import { roleCaps, WorkspaceContext, type WorkspaceCtx } from './WorkspaceContext';

const NAV = [
  { to: '', label: 'Overview', icon: LayoutGrid, end: true },
  { to: 'projects', label: 'Projects', icon: FolderKanban },
  { to: 'databases', label: 'Postgres', icon: Database },
  { to: 'env-groups', label: 'Env Groups', icon: Boxes },
  { to: 'blueprints', label: 'Blueprints', icon: FileStack },
  { to: 'activity', label: 'Activity', icon: Activity },
  { to: 'settings', label: 'Settings', icon: Settings },
];

function initials(name: string): string {
  return (
    name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || 'N'
  );
}

function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const create = useCreateWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const ws = await create.mutateAsync(name.trim());
      toast.success('Workspace created', ws.name);
      onClose();
      setName('');
      navigate(`/w/${ws.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not create workspace');
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a workspace"
      description="Workspaces group services, databases and teammates. Billing and access are per workspace."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-ws" loading={create.isPending} disabled={!name.trim()}>
            Create workspace
          </Button>
        </>
      }
    >
      <form id="create-ws" onSubmit={submit}>
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." autoFocus />}</Field>
      </form>
    </Dialog>
  );
}

function Sidebar({ ctx, onNavigate, onCreateWorkspace }: { ctx: WorkspaceCtx; onNavigate?: () => void; onCreateWorkspace: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-4">
        <Link to={`/w/${ctx.ws}`} onClick={onNavigate} className="rounded-md">
          <Logo />
        </Link>
      </div>
      <div className="px-3 pb-3">
        <Dropdown
          className="w-full"
          width="w-64"
          trigger={(p) => (
            <button
              {...p}
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-left hover:border-border-strong"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft font-mono text-[11px] font-semibold text-accent">
                {initials(ctx.workspace.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{ctx.workspace.name}</span>
                <span className="block text-[11px] text-fg-subtle capitalize">{ctx.role}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-fg-subtle" />
            </button>
          )}
        >
          <DropdownLabel>Workspaces</DropdownLabel>
          {ctx.workspaces.map((w) => (
            <DropdownItem
              key={w.id}
              icon={w.id === ctx.ws ? <Check className="size-3.5 text-accent" /> : <span />}
              onSelect={() => {
                onNavigate?.();
                navigate(`/w/${w.id}`);
              }}
              hint={<span className="capitalize">{w.role}</span>}
            >
              {w.name}
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem icon={<Plus className="size-3.5" />} onSelect={onCreateWorkspace}>
            Create workspace
          </DropdownItem>
        </Dropdown>
      </div>
      <nav aria-label="Workspace" className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV.map((n) => (
          <NavLink
            key={n.label}
            to={`/w/${ctx.ws}${n.to ? `/${n.to}` : ''}`}
            end={n.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex h-8 items-center gap-2.5 rounded-[10px] border px-2.5 text-[13px] font-medium',
                isActive ? 'nv-active' : 'border-transparent text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg',
              )
            }
          >
            {({ isActive }) => (
              <>
                <n.icon className={cn('size-4', isActive ? 'text-white' : 'text-fg-subtle')} strokeWidth={1.75} />
                {n.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-border p-3 text-[11px] text-fg-subtle">
        <div className="flex items-center justify-between">
          <span>NAV {ctx.config?.version ? `v${ctx.config.version}` : ''}</span>
          {ctx.config?.driver && <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{ctx.config.driver}</span>}
        </div>
      </div>
    </div>
  );
}

function UserMenu({ ctx }: { ctx: WorkspaceCtx }) {
  const logout = useLogout();
  const navigate = useNavigate();
  const [theme, toggle] = useTheme();
  return (
    <Dropdown
      align="end"
      width="w-64"
      trigger={(p) => (
        <button {...p} type="button" aria-label="Account menu" className="flex size-8 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2 text-[11px] font-semibold text-fg">
          {ctx.user.avatarUrl ? <img src={ctx.user.avatarUrl} alt="" className="size-full object-cover" /> : initials(ctx.user.name || ctx.user.email)}
        </button>
      )}
    >
      <div className="px-2 py-1.5">
        <div className="truncate text-[13px] font-medium text-fg">{ctx.user.name}</div>
        <div className="truncate text-xs text-fg-subtle">{ctx.user.email}</div>
      </div>
      <DropdownSeparator />
      <DropdownItem icon={<KeyRound className="size-3.5" />} to={`/w/${ctx.ws}/api-keys`}>
        API keys
      </DropdownItem>
      <DropdownItem icon={<Settings className="size-3.5" />} to={`/w/${ctx.ws}/settings`}>
        Workspace settings
      </DropdownItem>
      <DropdownItem icon={theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />} onSelect={toggle}>
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem
        icon={<LogOut className="size-3.5" />}
        onSelect={async () => {
          await logout.mutateAsync().catch(() => undefined);
          navigate('/login');
        }}
      >
        Log out
      </DropdownItem>
    </Dropdown>
  );
}

export function WorkspaceLayout() {
  const { workspaceId = '' } = useParams();
  const me = useMe();
  const config = useConfig();
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [createWs, setCreateWs] = useState(false);
  const liveState = useWorkspaceLiveUpdates(workspaceId || undefined);

  const ctx = useMemo<WorkspaceCtx | null>(() => {
    const data = me.data;
    if (!data) return null;
    const workspace = data.workspaces.find((w) => w.id === workspaceId || w.slug === workspaceId);
    if (!workspace) return null;
    return { ws: workspace.id, workspace, workspaces: data.workspaces, user: data.user, role: workspace.role, ...roleCaps(workspace.role), config: config.data };
  }, [me.data, workspaceId, config.data]);

  useEffect(() => {
    if (ctx) writeLocal(LAST_WORKSPACE_KEY, ctx.ws);
  }, [ctx]);

  useEffect(() => setDrawer(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (me.isPending) return <FullPageSpinner />;
  if (!ctx) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <Empty
          className="w-full max-w-lg"
          title="Workspace not found"
          description="It may have been deleted, or you are not a member of it."
          action={
            <Link className="text-[13px] font-medium text-accent hover:underline" to="/app">
              Go to my workspaces
            </Link>
          }
        />
      </div>
    );
  }

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <WorkspaceContext.Provider value={ctx}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded-md focus:bg-accent focus:px-3 focus:py-1.5 focus:text-accent-fg">
        Skip to content
      </a>
      <div className="flex min-h-dvh bg-bg">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-border bg-bg-elevated md:block">
          <Sidebar ctx={ctx} onCreateWorkspace={() => setCreateWs(true)} />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 animate-fade-in bg-black/50" onClick={() => setDrawer(false)} />
            <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-slide-up border-r border-border bg-bg-elevated shadow-pop">
              <IconButton label="Close navigation" className="absolute top-3.5 right-3" icon={<X className="size-4" />} onClick={() => setDrawer(false)} />
              <Sidebar ctx={ctx} onNavigate={() => setDrawer(false)} onCreateWorkspace={() => setCreateWs(true)} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-4 backdrop-blur md:px-6">
            <IconButton label="Open navigation" className="md:hidden" icon={<Menu className="size-4" />} onClick={() => setDrawer(true)} />
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="flex h-8 w-full max-w-sm items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-fg-subtle transition-colors hover:border-border-strong"
            >
              <Search className="size-3.5" />
              <span className="flex-1 truncate text-left">Search or jump to…</span>
              <span className="hidden items-center gap-0.5 sm:flex">
                <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            <div className="ml-auto flex items-center gap-2">
              <span
                className="hidden items-center gap-1.5 text-[11px] text-fg-subtle lg:flex"
                title={liveState === 'open' ? 'Live updates connected' : 'Live updates reconnecting'}
              >
                <span className={cn('size-1.5 rounded-full', liveState === 'open' ? 'bg-success' : 'animate-pulse-dot bg-warning')} />
                {liveState === 'open' ? 'Live' : 'Reconnecting'}
              </span>
              {ctx.canWrite && (
                <div className="hidden sm:block">
                  <NewMenu ws={ctx.ws} size="sm" />
                </div>
              )}
              <UserMenu ctx={ctx} />
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 md:px-8 md:py-8">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <CommandPalette ws={ctx.ws} open={palette} onClose={() => setPalette(false)} canWrite={ctx.canWrite} />
      <CreateWorkspaceDialog open={createWs} onClose={() => setCreateWs(false)} />
    </WorkspaceContext.Provider>
  );
}

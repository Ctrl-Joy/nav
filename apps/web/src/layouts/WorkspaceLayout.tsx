import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Boxes,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Database,
  DatabaseZap,
  FileStack,
  FolderKanban,
  FileClock,
  Globe,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Search,
  Settings,
  ShieldAlert,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useConfig, useLogout, useMe } from '@/api/auth';
import { useDatabase } from '@/api/databases';
import { useKeyValue } from '@/api/keyvalue';
import { useWorkspaceLiveUpdates } from '@/api/live';
import { useService } from '@/api/services';
import { useCreateWorkspace } from '@/api/workspaces';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LogoMark } from '@/components/Logo';
import { Button, Dialog, Dropdown, DropdownItem, DropdownLabel, DropdownSeparator, Empty, Field, Input, Kbd, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { LAST_WORKSPACE_KEY, writeLocal } from '@/lib/misc';
import { setTheme, useTheme } from '@/lib/theme';
import { CommandPalette } from './CommandPalette';
import { NewMenu } from './NewMenu';
import { FullPageSpinner } from './RootLayout';
import { roleCaps, WorkspaceContext, type WorkspaceCtx } from './WorkspaceContext';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Only shown to workspace admins. */
  admin?: boolean;
}

const NAV_GROUPS: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '', label: 'Overview', icon: LayoutGrid, end: true },
      { to: 'projects', label: 'Projects', icon: FolderKanban },
      { to: 'blueprints', label: 'Blueprints', icon: FileStack },
      { to: 'env-groups', label: 'Environment Groups', icon: Boxes },
    ],
  },
  {
    label: 'Data',
    items: [
      { to: 'databases', label: 'Postgres', icon: Database },
      { to: 'key-value', label: 'Key Value', icon: DatabaseZap },
    ],
  },
  { label: 'Activity', items: [{ to: 'activity', label: 'Events', icon: Activity }] },
  {
    label: 'Workspace',
    items: [
      { to: 'api-keys', label: 'API Keys', icon: KeyRound },
      { to: 'audit-logs', label: 'Audit Logs', icon: FileClock, admin: true },
      { to: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

/** Breadcrumb label + icon for the first path segment under /w/:ws. */
const SECTIONS: Record<string, { label: string; icon: LucideIcon }> = {
  '': { label: 'Overview', icon: LayoutGrid },
  projects: { label: 'Projects', icon: FolderKanban },
  blueprints: { label: 'Blueprints', icon: FileStack },
  'env-groups': { label: 'Environment Groups', icon: Boxes },
  databases: { label: 'Postgres', icon: Database },
  'key-value': { label: 'Key Value', icon: DatabaseZap },
  'audit-logs': { label: 'Audit Logs', icon: FileClock },
  activity: { label: 'Events', icon: Activity },
  'api-keys': { label: 'API Keys', icon: KeyRound },
  settings: { label: 'Workspace settings', icon: Settings },
  account: { label: 'Account settings', icon: UserRound },
  services: { label: 'Services', icon: Globe },
  new: { label: 'New service', icon: Plus },
  'get-started': { label: 'Get started', icon: Rocket },
};

const COLLAPSE_KEY = 'nav.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function initials(name: string): string {
  return (
    name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 1)
      .map((p) => p[0]?.toUpperCase())
      .join('') || 'N'
  );
}

/** Stable pastel colour for an initial avatar. */
function pastel(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 80% 82%)`;
}

function InitialAvatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-semibold text-[#111]', className)}
      style={{ background: pastel(name) }}
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : initials(name)}
    </span>
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

function WorkspaceSwitcher({ ctx, onNavigate, onCreateWorkspace, className }: { ctx: WorkspaceCtx; onNavigate?: () => void; onCreateWorkspace: () => void; className?: string }) {
  const navigate = useNavigate();
  return (
    <Dropdown
      className={cn('h-full', className)}
      width="w-64"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label={`Workspace: ${ctx.workspace.name}. Switch workspace`}
          className={cn('flex h-full w-full min-w-0 items-center gap-2.5 px-3.5 text-left transition-colors hover:bg-surface-2', p.open && 'bg-surface-2')}
        >
          <InitialAvatar name={ctx.workspace.name} className="size-[22px]" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{ctx.workspace.name}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-fg-muted" />
        </button>
      )}
    >
      <DropdownLabel>Workspaces</DropdownLabel>
      {ctx.workspaces.map((w) => (
        <DropdownItem
          key={w.id}
          icon={w.id === ctx.ws ? <Check className="size-4 text-accent" /> : <span />}
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
      <DropdownItem icon={<Plus className="size-4" />} onSelect={onCreateWorkspace}>
        Create workspace
      </DropdownItem>
    </Dropdown>
  );
}

const rowClass = (collapsed: boolean) =>
  cn('flex h-[34px] w-full items-center gap-2.5 text-[14px] transition-colors', collapsed ? 'justify-center px-0' : 'px-3');

function Sidebar({
  ctx,
  collapsed = false,
  onToggleCollapse,
  onNavigate,
}: {
  ctx: WorkspaceCtx;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNavigate?: () => void;
}) {
  const bottomLink = cn(rowClass(collapsed), 'h-[31px] text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg');
  return (
    <div className="flex h-full flex-col">
      <nav aria-label="Workspace" className="flex-1 overflow-y-auto py-3">
        {NAV_GROUPS.map((g, gi) => (
          <div key={g.label ?? gi} className={cn(gi > 0 && (collapsed ? 'mt-3 border-t border-border pt-3' : 'mt-5'))}>
            {g.label && !collapsed && <div className="nv-label px-3 pb-2">{g.label}</div>}
            <ul>
              {g.items.filter((n) => !n.admin || ctx.isAdmin).map((n) => (
                <li key={n.label}>
                  <NavLink
                    to={`/w/${ctx.ws}${n.to ? `/${n.to}` : ''}`}
                    end={n.end}
                    onClick={onNavigate}
                    title={collapsed ? n.label : undefined}
                    aria-label={collapsed ? n.label : undefined}
                    className={({ isActive }) => cn(rowClass(collapsed), isActive ? 'nv-active' : 'text-fg hover:bg-surface-2')}
                  >
                    <n.icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
                    {!collapsed && <span className="truncate">{n.label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-border py-2">
        <Link to="/docs" onClick={onNavigate} className={bottomLink} title={collapsed ? 'Docs' : undefined} aria-label={collapsed ? 'Docs' : undefined}>
          <BookOpen className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          {!collapsed && 'Docs'}
        </Link>
        <a href="/#changelog" className={bottomLink} title={collapsed ? 'Changelog' : undefined} aria-label={collapsed ? 'Changelog' : undefined}>
          <Newspaper className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          {!collapsed && 'Changelog'}
        </a>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className={bottomLink}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand' : undefined}
          >
            {collapsed ? <PanelLeftOpen className="size-4 shrink-0" strokeWidth={1.75} /> : <PanelLeftClose className="size-4 shrink-0" strokeWidth={1.75} />}
            {!collapsed && 'Collapse'}
          </button>
        )}
        {!collapsed && (
          <div className="flex items-center justify-between px-3 pt-2 font-mono text-[10.5px] text-fg-subtle">
            <span>NAV {ctx.config?.version ? `v${ctx.config.version}` : ''}</span>
            {ctx.config?.driver && <span>{ctx.config.driver}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function UserMenu({ ctx }: { ctx: WorkspaceCtx }) {
  const logout = useLogout();
  const navigate = useNavigate();
  const [theme] = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const themeBtn = useRef<HTMLButtonElement>(null);
  const displayName = ctx.user.name || ctx.user.email;
  return (
    <Dropdown
      align="end"
      width="w-64"
      className="h-full"
      trigger={(p) => (
        <button
          {...p}
          onClick={() => {
            setThemeOpen(false);
            p.onClick();
          }}
          type="button"
          aria-label="Account menu"
          className={cn('flex h-full items-center px-3 transition-colors hover:bg-surface-2 min-[900px]:px-3.5', p.open && 'bg-surface-2')}
        >
          <InitialAvatar name={displayName} src={ctx.user.avatarUrl} className="size-[22px]" />
        </button>
      )}
    >
      <div className="flex items-start gap-2.5 px-2 pt-1.5 pb-2.5">
        <InitialAvatar name={displayName} src={ctx.user.avatarUrl} className="mt-0.5 size-5 text-[10px]" />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold text-fg">{ctx.user.name || 'Account'}</div>
          <div className="truncate text-xs text-fg-muted">{ctx.user.email}</div>
        </div>
      </div>
      <DropdownItem icon={<Settings className="size-4" strokeWidth={1.75} />} to={`/w/${ctx.ws}/account`}>
        Account settings
      </DropdownItem>
      <div
        className="relative"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' && themeOpen) {
            e.stopPropagation();
            setThemeOpen(false);
            themeBtn.current?.focus();
          }
        }}
      >
        <button
          ref={themeBtn}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-haspopup="menu"
          aria-expanded={themeOpen}
          onClick={() => setThemeOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setThemeOpen(true);
              requestAnimationFrame(() => (document.querySelector('[data-theme-option]') as HTMLElement | null)?.focus());
            }
          }}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-[3px] px-2 py-2 text-left text-[13.5px] text-fg outline-none hover:bg-surface-2 focus:bg-surface-2',
            themeOpen && 'bg-surface-2',
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted">
            <Monitor className="size-4" strokeWidth={1.75} />
          </span>
          <span className="flex-1">Theme</span>
          <ChevronRight className={cn('size-4 text-fg-muted transition-transform', themeOpen && 'rotate-90 sm:rotate-0')} />
        </button>
        {themeOpen && (
          <div
            role="menu"
            aria-label="Theme"
            className="py-1 pl-6 sm:absolute sm:top-0 sm:right-full sm:mr-2 sm:w-40 sm:rounded-[3px] sm:border sm:border-border-strong sm:bg-popover sm:p-1.5 sm:shadow-pop"
          >
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="menuitemradio"
                aria-checked={theme === t}
                data-theme-option
                onClick={() => setTheme(t)}
                className="flex w-full items-center gap-2.5 rounded-[3px] px-2 py-2 text-left text-[13.5px] text-fg outline-none hover:bg-surface-2 focus:bg-surface-2"
              >
                <span className="flex size-4 items-center justify-center">{theme === t && <Check className="size-4 text-accent" />}</span>
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        )}
      </div>
      <DropdownSeparator />
      <DropdownItem
        icon={<LogOut className="size-4" strokeWidth={1.75} />}
        onSelect={async () => {
          await logout.mutateAsync().catch(() => undefined);
          navigate('/login');
        }}
      >
        Sign out
      </DropdownItem>
    </Dropdown>
  );
}

function Breadcrumb({ ws }: { ws: string }) {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean); // ['w', ws, section, id?, ...]
  const section = parts[2] ?? '';
  const id = parts[3];
  const def = SECTIONS[section] ?? SECTIONS[''];
  const serviceId = section === 'services' && id ? id : undefined;
  const databaseId = section === 'databases' && id && id !== 'new' ? id : undefined;
  const keyValueId = section === 'key-value' && id && id !== 'new' ? id : undefined;
  const service = useService(serviceId);
  const database = useDatabase(databaseId);
  const keyValue = useKeyValue(keyValueId);
  const leaf = serviceId ? service.data?.name : databaseId ? database.data?.name : keyValueId ? keyValue.data?.name : undefined;
  const Icon = def.icon;
  const sectionHref = section === 'services' ? `/w/${ws}` : `/w/${ws}${section ? `/${section}` : ''}`;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 px-4 text-[13.5px] text-fg-muted min-[900px]:px-6">
      <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      {leaf ? (
        <>
          <Link to={sectionHref} className="hidden truncate hover:text-fg sm:inline">
            {def.label}
          </Link>
          <span aria-hidden className="hidden text-fg-subtle sm:inline">
            /
          </span>
          <span className="truncate text-fg" aria-current="page">
            {leaf}
          </span>
        </>
      ) : (
        <span className="truncate" aria-current="page">
          {section === 'new' && parts[3] ? `New ${parts[3]}` : def.label}
        </span>
      )}
    </nav>
  );
}

/** The workspace requires 2FA and the signed-in user has not turned it on: its APIs answer 403 mfa_required. */
function MfaRequiredBanner({ ws }: { ws: string }) {
  return (
    <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-[3px] border border-warning/40 bg-warning-soft px-4 py-3 text-[13.5px] text-fg">
      <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">This workspace requires two-factor authentication. Turn it on for your account to manage its resources.</span>
      <Link to={`/w/${ws}/account#security`} className="font-medium text-accent hover:underline">
        Set up 2FA
      </Link>
    </div>
  );
}

function BarCell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex h-full items-center border-l border-border', className)}>{children}</div>;
}

export function WorkspaceLayout() {
  const { workspaceId = '' } = useParams();
  const me = useMe();
  const config = useConfig();
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [createWs, setCreateWs] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
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

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  if (me.isPending) return <FullPageSpinner />;
  if (!ctx) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <Empty
          className="w-full max-w-lg"
          title="Workspace not found"
          description="It may have been deleted, or you are not a member of it."
          action={
            <Link className="text-[13px] font-medium text-link hover:underline" to="/app">
              Go to my workspaces
            </Link>
          }
        />
      </div>
    );
  }

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const toggleCollapse = () =>
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });

  return (
    <WorkspaceContext.Provider value={ctx}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-fg">
        Skip to content
      </a>
      <div className="flex min-h-dvh flex-col bg-bg">
        <header className="sticky top-0 z-40 flex h-[46px] shrink-0 items-stretch border-b border-border bg-bg">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
            className="flex w-[46px] shrink-0 items-center justify-center border-r border-border text-fg hover:bg-surface-2 min-[900px]:hidden"
          >
            <Menu className="size-4" />
          </button>
          <Link
            to={`/w/${ctx.ws}`}
            aria-label="NAV home"
            className="hidden w-[46px] shrink-0 items-center justify-center border-r border-border hover:bg-surface-2 min-[900px]:flex"
          >
            <LogoMark className="h-[15px]" />
          </Link>
          <div className="hidden w-[194px] shrink-0 border-r border-border min-[900px]:block">
            <WorkspaceSwitcher ctx={ctx} onCreateWorkspace={() => setCreateWs(true)} className="w-full" />
          </div>
          <Breadcrumb ws={ctx.ws} />
          <div className="ml-auto flex h-full items-stretch">
            <span
              className="hidden items-center px-3 lg:flex"
              title={liveState === 'open' ? 'Live updates connected' : 'Live updates reconnecting'}
            >
              <span className={cn('size-1.5 rounded-full', liveState === 'open' ? 'bg-success' : 'animate-pulse-dot bg-warning')} />
              <span className="sr-only">{liveState === 'open' ? 'Live updates connected' : 'Live updates reconnecting'}</span>
            </span>
            <BarCell className="border-l-0 min-[900px]:border-l-0">
              <button
                type="button"
                onClick={() => setPalette(true)}
                aria-label="Search"
                className="flex h-full items-center gap-2 px-3 text-[13.5px] text-fg transition-colors hover:bg-surface-2 min-[900px]:px-4"
              >
                <Search className="size-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Search</span>
                <span className="hidden items-center gap-0.5 sm:flex">
                  <Kbd>{isMac ? '⌘' : '⌃'}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </button>
            </BarCell>
            {ctx.canWrite && (
              <BarCell>
                <NewMenu ws={ctx.ws} bar />
              </BarCell>
            )}
            <BarCell className="hidden sm:flex">
              <Link to="/docs" aria-label="Help and documentation" title="Help and documentation" className="flex h-full items-center px-4 text-[14px] text-fg hover:bg-surface-2">
                ?
              </Link>
            </BarCell>
            <BarCell>
              <UserMenu ctx={ctx} />
            </BarCell>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              'sticky top-[46px] hidden h-[calc(100dvh-46px)] shrink-0 border-r border-border bg-bg min-[900px]:block',
              collapsed ? 'w-14' : 'w-60',
            )}
          >
            <Sidebar ctx={ctx} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
          </aside>

          {drawer && (
            <div className="fixed inset-0 z-50 min-[900px]:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
              <div className="absolute inset-0 animate-fade-in bg-black/60" onClick={() => setDrawer(false)} />
              <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] animate-fade-in flex-col border-r border-border bg-bg">
                <div className="flex h-[46px] shrink-0 items-stretch border-b border-border">
                  <div className="min-w-0 flex-1">
                    <WorkspaceSwitcher ctx={ctx} onNavigate={() => setDrawer(false)} onCreateWorkspace={() => setCreateWs(true)} className="w-full" />
                  </div>
                  <button
                    type="button"
                    aria-label="Close navigation"
                    onClick={() => setDrawer(false)}
                    className="flex w-[46px] shrink-0 items-center justify-center border-l border-border text-fg hover:bg-surface-2"
                    autoFocus
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <Sidebar ctx={ctx} onNavigate={() => setDrawer(false)} />
                </div>
              </aside>
            </div>
          )}

          <main id="main" className="min-w-0 flex-1 px-4 py-6 min-[900px]:px-10 min-[900px]:py-10">
            <div className="mx-auto w-full max-w-[1200px]">
              {ctx.workspace.requireTwoFactor && !ctx.user.mfaEnabled && !location.pathname.endsWith('/account') && <MfaRequiredBanner ws={ctx.ws} />}
              <ErrorBoundary resetKey={location.pathname}>
                <Outlet />
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
      <CommandPalette ws={ctx.ws} open={palette} onClose={() => setPalette(false)} canWrite={ctx.canWrite} />
      <CreateWorkspaceDialog open={createWs} onClose={() => setCreateWs(false)} />
    </WorkspaceContext.Provider>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, Boxes, FileStack, FolderKanban, KeyRound, LayoutGrid, Moon, Search, Settings } from 'lucide-react';
import { useDatabases } from '@/api/databases';
import { useEnvGroups } from '@/api/resources';
import { useServices } from '@/api/services';
import { ResourceIcon, RESOURCE_META, type ResourceKind } from '@/components/ResourceIcon';
import { Kbd, StatusDot, statusDef } from '@/components/ui';
import { cn } from '@/lib/cn';
import { toggleTheme } from '@/lib/theme';
import { newResourcePath } from './NewMenu';

interface PaletteItem {
  id: string;
  group: 'Actions' | 'Services' | 'Databases' | 'Env Groups' | 'Navigate';
  label: string;
  hint?: string;
  icon: ReactNode;
  status?: string;
  run: () => void;
  keywords?: string;
}

function score(item: PaletteItem, q: string): number {
  if (!q) return 1;
  const hay = `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  const needle = q.toLowerCase();
  if (item.label.toLowerCase().startsWith(needle)) return 3;
  if (hay.includes(needle)) return 2;
  // subsequence match
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length ? 1 : 0;
}

export function CommandPalette({ ws, open, onClose, canWrite }: { ws: string; open: boolean; onClose: () => void; canWrite: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const services = useServices(ws);
  const databases = useDatabases(ws);
  const groups = useEnvGroups(ws);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => () => navigate(to);
    const out: PaletteItem[] = [];
    if (canWrite) {
      const kinds: ResourceKind[] = ['web', 'private', 'worker', 'cron', 'static', 'postgres', 'blueprint'];
      for (const k of kinds) {
        const Icon = RESOURCE_META[k].icon;
        out.push({ id: `new-${k}`, group: 'Actions', label: `New ${RESOURCE_META[k].label}`, icon: <Icon className="size-4" />, run: go(newResourcePath(ws, k)), keywords: 'create add' });
      }
    }
    out.push({ id: 'theme', group: 'Actions', label: 'Toggle light / dark theme', icon: <Moon className="size-4" />, run: () => toggleTheme(), keywords: 'appearance mode' });
    out.push({ id: 'keys', group: 'Actions', label: 'Manage API keys', icon: <KeyRound className="size-4" />, run: go(`/w/${ws}/api-keys`), keywords: 'token cli' });
    for (const s of services.data?.items ?? []) {
      out.push({ id: `svc-${s.id}`, group: 'Services', label: s.name, hint: RESOURCE_META[s.type].label, status: s.status, icon: <ResourceIcon kind={s.type} boxed={false} />, run: go(`/w/${ws}/services/${s.id}`), keywords: `${s.slug} ${s.repoUrl ?? ''}` });
    }
    for (const d of databases.data?.items ?? []) {
      out.push({ id: `db-${d.id}`, group: 'Databases', label: d.name, hint: `PostgreSQL ${d.pgVersion}`, status: d.status, icon: <ResourceIcon kind="postgres" boxed={false} />, run: go(`/w/${ws}/databases/${d.id}`), keywords: d.slug });
    }
    for (const g of groups.data?.items ?? []) {
      out.push({ id: `eg-${g.id}`, group: 'Env Groups', label: g.name, hint: `${g.envVars.length} vars`, icon: <Boxes className="size-4" />, run: go(`/w/${ws}/env-groups/${g.id}`) });
    }
    const nav: [string, string, ReactNode][] = [
      ['Overview', '', <LayoutGrid className="size-4" />],
      ['Projects', 'projects', <FolderKanban className="size-4" />],
      ['Databases', 'databases', <ResourceIcon kind="postgres" boxed={false} />],
      ['Env Groups', 'env-groups', <Boxes className="size-4" />],
      ['Blueprints', 'blueprints', <FileStack className="size-4" />],
      ['Activity', 'activity', <Activity className="size-4" />],
      ['Workspace settings', 'settings', <Settings className="size-4" />],
    ];
    for (const [label, path, icon] of nav) out.push({ id: `nav-${path}`, group: 'Navigate', label, icon, run: go(`/w/${ws}${path ? `/${path}` : ''}`), keywords: 'go page' });
    return out;
  }, [ws, canWrite, services.data, databases.data, groups.data, navigate]);

  const filtered = useMemo(() => {
    const scored = items.map((i) => ({ i, s: score(i, q.trim()) })).filter((x) => x.s > 0);
    if (q.trim()) scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.i).slice(0, 60);
  }, [items, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = '';
  return (
    <dialog
      ref={ref}
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === ref.current && onClose()}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl rounded-xl border border-border bg-bg-elevated p-0 text-fg shadow-pop open:animate-slide-up"
    >
      {open && (
        <div>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-fg-subtle" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search services, databases, actions…"
              className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-subtle"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={filtered[active] ? `pal-${filtered[active].id}` : undefined}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(filtered.length - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  run(filtered[active]);
                }
              }}
            />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {filtered.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-fg-subtle">No matches for “{q}”.</p>}
            {filtered.map((item, idx) => {
              const header = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {header && <div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{header}</div>}
                  <div
                    id={`pal-${item.id}`}
                    data-index={idx}
                    role="option"
                    aria-selected={idx === active}
                    onMouseMove={() => setActive(idx)}
                    onClick={() => run(item)}
                    className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13px]', idx === active ? 'bg-surface-2 text-fg' : 'text-fg-muted')}
                  >
                    <span className="flex size-5 items-center justify-center text-fg-muted">{item.icon}</span>
                    <span className="flex-1 truncate text-fg">{item.label}</span>
                    {item.status && <StatusDot tone={statusDef(item.status).tone} />}
                    {item.hint && <span className="text-xs text-fg-subtle">{item.hint}</span>}
                    {idx === active && <ArrowRight className="size-3.5 text-fg-subtle" />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-fg-subtle">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
          </div>
        </div>
      )}
    </dialog>
  );
}

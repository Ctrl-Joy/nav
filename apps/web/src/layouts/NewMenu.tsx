import { ChevronDown, LayoutTemplate, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from '@/components/ui';
import { RESOURCE_META, type ResourceKind } from '@/components/ResourceIcon';
import { cn } from '@/lib/cn';

export const NEW_ITEMS: ResourceKind[] = ['web', 'private', 'worker', 'cron', 'static', 'workflow'];

export function newResourcePath(ws: string, kind: ResourceKind): string {
  if (kind === 'postgres') return `/w/${ws}/databases/new`;
  if (kind === 'keyvalue') return `/w/${ws}/key-value/new`;
  if (kind === 'blueprint') return `/w/${ws}/blueprints/new`;
  return `/w/${ws}/new/${kind}`;
}

/**
 * "+ New" resource menu. `bar` renders the trigger as a flat top-bar cell
 * (used by the workspace header); otherwise it is a primary button.
 */
export function NewMenu({
  ws,
  size = 'md',
  align = 'end',
  bar = false,
}: {
  ws: string;
  size?: 'sm' | 'md';
  align?: 'start' | 'end';
  bar?: boolean;
}) {
  const navigate = useNavigate();
  const item = (kind: ResourceKind) => {
    const meta = RESOURCE_META[kind];
    const Icon = meta.icon;
    return (
      <DropdownItem key={kind} icon={<Icon className="size-4" strokeWidth={1.75} />} onSelect={() => navigate(newResourcePath(ws, kind))}>
        {meta.label}
      </DropdownItem>
    );
  };
  return (
    <Dropdown
      align={align}
      width="w-60"
      className={bar ? 'h-full' : undefined}
      trigger={(p) =>
        bar ? (
          <button
            {...p}
            type="button"
            aria-label="New resource"
            className={cn(
              'flex h-full items-center gap-1.5 px-3 text-[13.5px] text-fg transition-colors hover:bg-surface-2 min-[900px]:px-4',
              p.open && 'bg-surface-2',
            )}
          >
            <Plus className="size-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">New</span>
          </button>
        ) : (
          <Button {...p} variant="primary" size={size} icon={<Plus className="size-4" />} iconRight={<ChevronDown className="size-3.5 opacity-70" />}>
            New
          </Button>
        )
      }
    >
      <DropdownLabel>Services</DropdownLabel>
      {NEW_ITEMS.map(item)}
      <DropdownSeparator />
      <DropdownLabel>Data & infrastructure</DropdownLabel>
      {item('postgres')}
      {item('keyvalue')}
      {item('blueprint')}
      <DropdownSeparator />
      <DropdownItem icon={<LayoutTemplate className="size-4" strokeWidth={1.75} />} onSelect={() => navigate(`/w/${ws}/templates`)}>
        From a template
      </DropdownItem>
    </Dropdown>
  );
}

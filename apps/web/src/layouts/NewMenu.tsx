import { ChevronDown, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from '@/components/ui';
import { RESOURCE_META, type ResourceKind } from '@/components/ResourceIcon';

export const NEW_ITEMS: ResourceKind[] = ['web', 'private', 'worker', 'cron', 'static'];

export function newResourcePath(ws: string, kind: ResourceKind): string {
  if (kind === 'postgres') return `/w/${ws}/databases/new`;
  if (kind === 'blueprint') return `/w/${ws}/blueprints/new`;
  return `/w/${ws}/new/${kind}`;
}

export function NewMenu({ ws, size = 'md', align = 'end' }: { ws: string; size?: 'sm' | 'md'; align?: 'start' | 'end' }) {
  const navigate = useNavigate();
  const item = (kind: ResourceKind) => {
    const meta = RESOURCE_META[kind];
    const Icon = meta.icon;
    return (
      <DropdownItem key={kind} icon={<Icon className="size-3.5" />} onSelect={() => navigate(newResourcePath(ws, kind))}>
        {meta.label}
      </DropdownItem>
    );
  };
  return (
    <Dropdown
      align={align}
      width="w-60"
      trigger={(p) => (
        <Button {...p} variant="primary" size={size} icon={<Plus className="size-4" />} iconRight={<ChevronDown className="size-3.5 opacity-70" />}>
          New
        </Button>
      )}
    >
      <DropdownLabel>Services</DropdownLabel>
      {NEW_ITEMS.map(item)}
      <DropdownSeparator />
      <DropdownLabel>Data & infrastructure</DropdownLabel>
      {item('postgres')}
      {item('blueprint')}
    </Dropdown>
  );
}

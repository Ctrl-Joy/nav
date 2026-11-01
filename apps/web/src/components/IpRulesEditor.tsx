import type { ReactNode } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, IconButton, Input } from '@/components/ui';

export interface IpRule {
  cidr: string;
  description: string;
}

const CIDR_V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const CIDR_V6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:.]*(\/(12[0-8]|1[01]\d|\d?\d))?$/;

export function isValidCidr(s: string): boolean {
  const v = s.trim();
  return CIDR_V4.test(v) || CIDR_V6.test(v);
}

/** The API wants a prefix length: a bare address becomes a single-host block. */
export function normalizeRules(rows: IpRule[]): IpRule[] {
  return rows.map((r) => {
    const cidr = r.cidr.trim();
    return { cidr: cidr.includes('/') ? cidr : `${cidr}/${cidr.includes(':') ? 128 : 32}`, description: r.description.trim() };
  });
}

/** Rows of CIDR + description, as on a database's access control tab. */
export function IpRulesEditor({
  rows,
  onChange,
  disabled,
  emptyText,
  footnote,
}: {
  rows: IpRule[];
  onChange: (rows: IpRule[]) => void;
  disabled: boolean;
  emptyText: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[13px] text-fg-subtle">{emptyText}</p>}
      {rows.map((r, i) => {
        const bad = !!r.cidr && !isValidCidr(r.cidr);
        return (
          <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-2">
            <div>
              <Input
                mono
                value={r.cidr}
                placeholder="203.0.113.0/24"
                aria-label={`Rule ${i + 1} CIDR`}
                aria-invalid={bad}
                readOnly={disabled}
                onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, cidr: e.target.value } : x)))}
              />
              {bad && <p className="mt-1 text-xs text-danger">Invalid IP or CIDR block</p>}
            </div>
            <Input
              value={r.description}
              placeholder="Description (e.g. office)"
              aria-label={`Rule ${i + 1} description`}
              readOnly={disabled}
              onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
            />
            {!disabled && <IconButton label="Remove rule" icon={<Trash2 className="size-3.5" />} onClick={() => onChange(rows.filter((_, j) => j !== i))} />}
          </div>
        );
      })}
      {!disabled && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { cidr: '', description: '' }])}>
            Add rule
          </Button>
          {!rows.some((r) => r.cidr === '0.0.0.0/0') && (
            <Button size="sm" variant="ghost" icon={<ShieldCheck className="size-3.5" />} onClick={() => onChange([...rows, { cidr: '0.0.0.0/0', description: 'Everywhere' }])}>
              Allow from anywhere
            </Button>
          )}
        </div>
      )}
      {footnote && <p className="text-xs text-fg-subtle">{footnote}</p>}
    </div>
  );
}

/** True when every rule has a valid (non-empty) CIDR. */
export function rulesValid(rows: IpRule[]): boolean {
  return rows.every((r) => isValidCidr(r.cidr));
}

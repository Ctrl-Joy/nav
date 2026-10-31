import type { Plan } from '@nav/shared';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatMemory } from '@/lib/format';

export function PlanPicker({ plans, value, onChange, disabled }: { plans: Plan[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Instance type" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {plans.map((p) => {
        const active = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(p.id)}
            className={cn(
              'relative flex flex-col items-start rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
              active ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-border bg-surface hover:border-border-strong',
            )}
          >
            {active && <Check className="absolute top-2.5 right-2.5 size-3.5 text-accent" />}
            <span className="text-[13px] font-semibold text-fg">{p.name}</span>
            <span className="mt-1 text-lg font-semibold tracking-tight text-fg">
              ${p.priceMonthly}
              <span className="text-xs font-normal text-fg-subtle">/mo</span>
            </span>
            <span className="mt-1 font-mono text-[11px] text-fg-muted">
              {p.cpu} vCPU · {formatMemory(p.memoryMB)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

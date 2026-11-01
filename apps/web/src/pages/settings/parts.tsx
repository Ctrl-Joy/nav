import type { ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui';

// Building blocks shared by the workspace settings sections.

/** Bordered settings section with an anchor id. */
export function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 rounded-[3px] border border-border-strong px-5 py-6 md:px-7 md:py-7">
      <h2 id={`${id}-title`} className="text-[18px] font-semibold text-fg">
        {title}
      </h2>
      {description && <p className="mt-1.5 max-w-2xl text-[13.5px] text-fg-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Label column on the left, control on the right. */
export function Row({ label, description, children, htmlFor }: { label: ReactNode; description?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-8">
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[14px] font-semibold text-fg">
            {label}
          </label>
        ) : (
          <div className="text-[14px] font-semibold text-fg">{label}</div>
        )}
        {description && <p className="mt-1 text-[13.5px] text-fg-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EditLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <div className="mt-2.5 flex justify-end">
      <button type="button" onClick={onClick} aria-label={label} className="inline-flex items-center gap-1.5 text-[13px] text-fg hover:underline">
        <Pencil className="size-3.5" strokeWidth={1.75} aria-hidden /> Edit
      </button>
    </div>
  );
}

export function EditActions({ onCancel, loading, disabled }: { onCancel: () => void; loading?: boolean; disabled?: boolean }) {
  return (
    <div className="mt-3 flex justify-end gap-2">
      <Button size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" type="submit" variant="primary" loading={loading} disabled={disabled}>
        Save changes
      </Button>
    </div>
  );
}

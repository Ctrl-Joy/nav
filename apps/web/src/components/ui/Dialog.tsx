import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, IconButton } from './Button';
import { Input } from './Input';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Disable closing via Esc / backdrop (e.g. while a request is in flight). */
  dismissable?: boolean;
}

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

/** Modal dialog built on native <dialog> (focus trap, Esc, inert background for free). */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissable = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (dismissable) onCloseRef.current();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current && dismissable) onCloseRef.current();
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] rounded-[4px] border border-border-strong bg-popover p-0 text-fg shadow-pop',
        // Phones: a bottom sheet, so the actions sit under the thumb and above the keyboard.
        'max-sm:mx-0 max-sm:mt-auto max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0',
        'open:animate-slide-up backdrop:animate-fade-in',
        widths[size],
      )}
    >
      {open && (
        <div className="nv-safe-b flex max-h-[85dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 id="dialog-title" className="text-[17px] font-semibold">
                {title}
              </h2>
              {description && <p className="mt-1 text-[13px] text-fg-muted">{description}</p>}
            </div>
            {dismissable && <IconButton label="Close" icon={<X className="size-4" />} onClick={onClose} />}
          </div>
          {children && <div className="overflow-y-auto overscroll-contain px-5 py-4">{children}</div>}
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3 max-sm:[&>*]:flex-1">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// Imperative confirm() --------------------------------------------------------------------------

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** Require typing this exact text to enable the confirm button. */
  typeToConfirm?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setState({ ...opts, resolve });
      }),
    [],
  );

  const finish = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };

  const blocked = !!state?.typeToConfirm && typed !== state.typeToConfirm;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => finish(false)}
        title={state?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button onClick={() => finish(false)}>{state?.cancelText ?? 'Cancel'}</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => finish(true)} autoFocus={!state?.typeToConfirm}>
              {state?.confirmText ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {(state?.body || state?.typeToConfirm) && (
          <div className="space-y-3 text-[13px] text-fg-muted">
            {state?.body}
            {state?.typeToConfirm && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!blocked) finish(true);
                }}
                className="space-y-1.5"
              >
                <label className="block text-[13px] text-fg" htmlFor="confirm-type">
                  Type <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{state.typeToConfirm}</code> to confirm
                </label>
                <Input id="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" mono />
              </form>
            )}
          </div>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}

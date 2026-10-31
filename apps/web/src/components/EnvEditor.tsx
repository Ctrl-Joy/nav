import { useState, type ClipboardEvent } from 'react';
import { Eye, EyeOff, FileText, Plus, Rows3, Trash2 } from 'lucide-react';
import type { EnvVar, SecretFile } from '@nav/shared';
import { ENV_KEY_RE, parseDotenv, serializeDotenv } from '@/lib/dotenv';
import { cn } from '@/lib/cn';
import { Button, CopyButton, IconButton, Input, Segmented, Textarea } from '@/components/ui';

export function envVarErrors(vars: EnvVar[]): string | null {
  const seen = new Set<string>();
  for (const v of vars) {
    if (!v.key && !v.value) continue;
    if (!v.key) return 'Every variable needs a key.';
    if (!ENV_KEY_RE.test(v.key)) return `"${v.key}" is not a valid key (letters, digits and _ ; must not start with a digit).`;
    if (seen.has(v.key)) return `Duplicate key "${v.key}".`;
    seen.add(v.key);
  }
  return null;
}

export function cleanEnvVars(vars: EnvVar[]): EnvVar[] {
  return vars.filter((v) => v.key.trim()).map((v) => ({ key: v.key.trim(), value: v.value }));
}

/** Merge parsed vars into a list (later wins), dropping trailing empty rows. */
function mergeVars(base: EnvVar[], add: EnvVar[]): EnvVar[] {
  const out = base.filter((v) => v.key || v.value);
  for (const a of add) {
    const i = out.findIndex((v) => v.key === a.key);
    if (i >= 0) out[i] = a;
    else out.push(a);
  }
  return out;
}

export function EnvVarEditor({
  value,
  onChange,
  readOnly,
  allowBulk = true,
  masked = true,
}: {
  value: EnvVar[];
  onChange: (v: EnvVar[]) => void;
  readOnly?: boolean;
  allowBulk?: boolean;
  masked?: boolean;
}) {
  const [mode, setMode] = useState<'rows' | 'bulk'>('rows');
  const [bulk, setBulk] = useState('');
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [revealAll, setRevealAll] = useState(!masked);

  const update = (i: number, patch: Partial<EnvVar>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = () => onChange([...value, { key: '', value: '' }]);

  const onPasteKey = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text.includes('=') || (!text.includes('\n') && !/^[A-Za-z_][\w.-]*=/.test(text))) return;
    const parsed = parseDotenv(text);
    if (!parsed.length) return;
    e.preventDefault();
    onChange(mergeVars(value.filter((_, j) => j !== i || value[j].key || value[j].value), parsed));
  };

  const switchMode = (m: 'rows' | 'bulk') => {
    if (m === 'bulk') setBulk(serializeDotenv(value));
    else onChange(parseDotenv(bulk));
    setMode(m);
  };

  const err = envVarErrors(value);
  const isShown = (i: number) => revealAll || revealed.has(i);

  return (
    <div className="space-y-3">
      {allowBulk && !readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            label="Editor mode"
            size="xs"
            value={mode}
            onChange={switchMode}
            options={[
              { value: 'rows', label: 'Rows' },
              { value: 'bulk', label: '.env' },
            ]}
          />
          {mode === 'rows' && value.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              icon={revealAll ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              onClick={() => {
                setRevealAll((r) => !r);
                setRevealed(new Set());
              }}
            >
              {revealAll ? 'Hide values' : 'Reveal values'}
            </Button>
          )}
        </div>
      )}

      {mode === 'bulk' && !readOnly ? (
        <div className="space-y-2">
          <Textarea
            mono
            rows={Math.min(18, Math.max(6, bulk.split('\n').length + 1))}
            value={bulk}
            onChange={(e) => {
              setBulk(e.target.value);
              onChange(parseDotenv(e.target.value));
            }}
            placeholder={'DATABASE_URL=postgres://…\nNODE_ENV=production'}
            aria-label="Environment variables in .env format"
          />
          <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <FileText className="size-3.5" /> One <code className="font-mono">KEY=value</code> per line. Comments (#) and quotes are supported.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {value.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[13px] text-fg-subtle">
              No environment variables{readOnly ? '.' : ' yet. Add one, or paste a .env file into a key field.'}
            </p>
          )}
          {value.map((v, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
              <Input
                mono
                value={v.key}
                placeholder="KEY"
                aria-label={`Key ${i + 1}`}
                readOnly={readOnly}
                aria-invalid={!!v.key && !ENV_KEY_RE.test(v.key)}
                onChange={(e) => update(i, { key: e.target.value.replace(/\s/g, '_') })}
                onPaste={(e) => onPasteKey(i, e)}
              />
              <Input
                mono
                value={v.value}
                placeholder="value"
                aria-label={`Value for ${v.key || `variable ${i + 1}`}`}
                readOnly={readOnly}
                type={isShown(i) ? 'text' : 'password'}
                autoComplete="off"
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <div className="flex items-center">
                <IconButton
                  label={isShown(i) ? 'Hide value' : 'Reveal value'}
                  icon={isShown(i) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  onClick={() =>
                    setRevealed((s) => {
                      const n = new Set(s);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    })
                  }
                />
                <CopyButton value={v.value} label="Copy value" />
                {!readOnly && <IconButton label="Remove variable" icon={<Trash2 className="size-3.5" />} onClick={() => remove(i)} />}
              </div>
            </div>
          ))}
          {!readOnly && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add}>
              Add variable
            </Button>
          )}
        </div>
      )}
      {err && <p className={cn('text-xs text-danger')}>{err}</p>}
    </div>
  );
}

export function SecretFilesEditor({ value, onChange, readOnly }: { value: SecretFile[]; onChange: (v: SecretFile[]) => void; readOnly?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const update = (i: number, patch: Partial<SecretFile>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[13px] text-fg-subtle">
          No secret files. They are mounted at <code className="font-mono">/etc/secrets/&lt;name&gt;</code> and in your app root.
        </p>
      )}
      {value.map((f, i) => (
        <div key={i} className="rounded-lg border border-border bg-bg-elevated">
          <div className="flex items-center gap-2 p-2">
            <Rows3 className="ml-1 size-3.5 text-fg-subtle" />
            <Input
              mono
              className="flex-1"
              value={f.filename}
              placeholder="filename (e.g. credentials.json)"
              aria-label={`Secret file ${i + 1} name`}
              readOnly={readOnly}
              onChange={(e) => update(i, { filename: e.target.value })}
            />
            <Button size="sm" variant="ghost" onClick={() => setOpen(open === i ? null : i)}>
              {open === i ? 'Hide contents' : 'Edit contents'}
            </Button>
            {!readOnly && (
              <IconButton label="Remove secret file" icon={<Trash2 className="size-3.5" />} onClick={() => onChange(value.filter((_, j) => j !== i))} />
            )}
          </div>
          {open === i && (
            <div className="border-t border-border p-2">
              <Textarea
                mono
                rows={8}
                value={f.content}
                readOnly={readOnly}
                aria-label={`Contents of ${f.filename || 'secret file'}`}
                onChange={(e) => update(i, { content: e.target.value })}
              />
            </div>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-3.5" />}
          onClick={() => {
            onChange([...value, { filename: '', content: '' }]);
            setOpen(value.length);
          }}
        >
          Add secret file
        </Button>
      )}
    </div>
  );
}

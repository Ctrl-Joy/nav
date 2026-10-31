import { useState } from 'react';
import { CheckCircle2, FileCheck2, XCircle } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { useValidateBlueprint } from '@/api/resources';
import type { BlueprintValidateResult, PlanItem } from '@/api/types';
import { Button, Card, CardBody, CardHeader, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';

const SAMPLE = `services:
  - type: web
    name: api
    runtime: node
    buildCommand: npm ci && npm run build
    startCommand: npm start
    healthCheckPath: /healthz
    plan: starter
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: main-db, property: connectionString }
databases:
  - name: main-db
    plan: basic-256mb
`;

function itemLabel(item: PlanItem): { type: string; name: string } {
  if (typeof item === 'string') return { type: '', name: item };
  return { type: item.type ?? item.kind ?? '', name: item.name ?? item.id ?? JSON.stringify(item) };
}

function errorText(e: BlueprintValidateResult['errors'][number]): string {
  return typeof e === 'string' ? e : e.path ? `${e.path}: ${e.message}` : e.message;
}

const GROUPS = [
  { key: 'create', marker: '+', label: 'Create', cls: 'text-success' },
  { key: 'update', marker: '~', label: 'Update', cls: 'text-warning' },
  { key: 'unchanged', marker: '=', label: 'Unchanged', cls: 'text-fg-subtle' },
] as const;

export function YamlValidator({ initial = SAMPLE }: { initial?: string }) {
  const [yaml, setYaml] = useState(initial);
  const validate = useValidateBlueprint();
  const [result, setResult] = useState<BlueprintValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    try {
      setResult(await validate.mutateAsync(yaml));
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    }
  };

  const total = result ? result.plan.create.length + result.plan.update.length + result.plan.unchanged.length : 0;

  return (
    <Card>
      <CardHeader
        title="Validate nav.yaml"
        description="Dry-run a blueprint: NAV checks the spec and shows what a sync would create, update or leave unchanged."
        actions={
          <Button size="sm" variant="primary" icon={<FileCheck2 className="size-3.5" />} loading={validate.isPending} disabled={!yaml.trim()} onClick={run}>
            Validate
          </Button>
        }
      />
      <CardBody className="grid gap-4 lg:grid-cols-2">
        <Textarea
          mono
          rows={16}
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
          aria-label="nav.yaml contents"
        />
        <div className="min-w-0 rounded-lg border border-border bg-[#0a0c0f] p-3 font-mono text-[12.5px] text-[#d6dde6]" aria-live="polite">
          {error ? (
            <p className="text-[#ff8a8a]">{error}</p>
          ) : !result ? (
            <p className="text-[#6b7584]"># Run validation to see the plan.</p>
          ) : (
            <div className="space-y-3">
              <p className={cn('flex items-center gap-1.5 font-sans text-[13px] font-medium', result.valid ? 'text-[#3ddc84]' : 'text-[#ff8a8a]')}>
                {result.valid ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                {result.valid ? `Valid · ${total} resource${total === 1 ? '' : 's'}` : `${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`}
              </p>
              {result.errors.length > 0 && (
                <ul className="space-y-1">
                  {result.errors.map((e, i) => (
                    <li key={i} className="text-[#ff8a8a]">
                      ✗ {errorText(e)}
                    </li>
                  ))}
                </ul>
              )}
              {GROUPS.map((g) =>
                result.plan[g.key].length ? (
                  <div key={g.key}>
                    <p className="mb-1 text-[11px] tracking-wide text-[#6b7584] uppercase">{g.label}</p>
                    <ul>
                      {result.plan[g.key].map((item, i) => {
                        const l = itemLabel(item);
                        return (
                          <li key={i} className={g.cls}>
                            {g.marker} {l.type && <span className="text-[#8b95a3]">{l.type}/</span>}
                            {l.name}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

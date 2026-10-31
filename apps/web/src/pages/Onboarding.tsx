import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { useDatabases } from '@/api/databases';
import { useBlueprints } from '@/api/resources';
import { useServices } from '@/api/services';
import { LogoMark } from '@/components/Logo';
import { RESOURCE_META, type ResourceKind } from '@/components/ResourceIcon';
import { buttonClass } from '@/components/ui/Button';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { newResourcePath } from '@/layouts/NewMenu';
import { cn } from '@/lib/cn';
import { useTitle } from '@/lib/useTitle';

interface Step {
  kind: ResourceKind;
  title: string;
  body: string;
  cta: string;
  done: boolean;
}

/** Friendly 3-step guide shown when a workspace has nothing in it yet. */
export function Onboarding({ welcome }: { welcome?: boolean }) {
  const { ws, user, workspace, canWrite } = useWorkspace();
  const services = useServices(ws);
  const databases = useDatabases(ws);
  const blueprints = useBlueprints(ws);

  const steps: Step[] = [
    {
      kind: 'web',
      title: 'Deploy your first service',
      body: 'Point NAV at a Git repository or a container image. We detect the runtime, build it, and give you a URL with TLS.',
      cta: 'New web service',
      done: (services.data?.items.length ?? 0) > 0,
    },
    {
      kind: 'postgres',
      title: 'Add a Postgres database',
      body: 'Managed PostgreSQL with backups and a query console. Link it to services with a single env var.',
      cta: 'New database',
      done: (databases.data?.items.length ?? 0) > 0,
    },
    {
      kind: 'blueprint',
      title: 'Describe it all in nav.yaml',
      body: 'Commit a Blueprint to your repo and NAV keeps services, databases and env groups in sync on every push.',
      cta: 'New blueprint',
      done: (blueprints.data?.items.length ?? 0) > 0,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface">
      <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_60%)]" />
      <div className="relative px-6 pt-8 pb-6 md:px-10 md:pt-10">
        <LogoMark className="size-10" />
        <h2 className="mt-5 text-2xl font-semibold tracking-tight">
          {welcome ? `Welcome to NAV, ${user.name.split(' ')[0] || 'there'}.` : `Let’s set up ${workspace.name}.`}
        </h2>
        <p className="mt-1.5 max-w-xl text-[14px] text-fg-muted">Three steps to a production-ready stack. You can do them in any order.</p>
        <div className="mt-5 flex items-center gap-3">
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={doneCount} aria-label="Setup progress">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / 3) * 100}%` }} />
          </div>
          <span className="font-mono text-xs text-fg-subtle">{doneCount}/3 complete</span>
        </div>
      </div>
      <ol className="relative grid gap-px border-t border-border bg-border md:grid-cols-3">
        {steps.map((s, i) => {
          const meta = RESOURCE_META[s.kind];
          return (
            <li key={s.kind} className="flex flex-col bg-surface p-6">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full border font-mono text-xs',
                    s.done ? 'border-success bg-success-soft text-success' : 'border-border-strong text-fg-muted',
                  )}
                >
                  {s.done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <meta.icon className="size-4 text-fg-subtle" />
              </div>
              <h3 className="mt-4 text-[14px] font-semibold">{s.title}</h3>
              <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-fg-muted">{s.body}</p>
              {canWrite ? (
                <Link to={newResourcePath(ws, s.kind)} className={buttonClass(i === doneCount ? 'primary' : 'secondary', 'md', 'mt-5 self-start')}>
                  {s.cta} <ArrowRight className="size-3.5" />
                </Link>
              ) : (
                <p className="mt-5 text-xs text-fg-subtle">Viewers can’t create resources — ask a developer or admin.</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function OnboardingPage() {
  useTitle('Get started');
  const { ws } = useWorkspace();
  return (
    <div className="space-y-6">
      <Onboarding welcome />
      <p className="text-center text-[13px] text-fg-muted">
        Prefer the terminal? Create an{' '}
        <Link to={`/w/${ws}/api-keys`} className="font-medium text-accent hover:underline">
          API key
        </Link>{' '}
        and use the <code className="rounded bg-surface-2 px-1 font-mono text-xs">nav</code> CLI. Or{' '}
        <Link to={`/w/${ws}`} className="font-medium text-accent hover:underline">
          skip to the dashboard
        </Link>
        .
      </p>
    </div>
  );
}

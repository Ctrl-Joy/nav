import { Link } from 'react-router-dom';
import { ArrowRight, LayoutTemplate } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';
import { buttonClass } from '@/components/ui/Button';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { TEMPLATES, deployPath, repoLabel } from '@/lib/templates';
import { useTitle } from '@/lib/useTitle';

/** Starter repositories deployed through the "Deploy to NAV" review screen. */
export function TemplatesPage() {
  useTitle('Templates');
  const { ws } = useWorkspace();
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<LayoutTemplate className="size-5 text-fg-muted" strokeWidth={1.75} />}
        title="Templates"
        description={
          <>
            Start from a working repository. Each template is a <span className="font-mono text-xs">nav.yaml</span> blueprint: review what it creates, pick a workspace and deploy.
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {TEMPLATES.map((t) => (
          <Card key={t.id} className="flex flex-col">
            <div className="flex flex-1 flex-col gap-3 p-4">
              <div className="flex items-center gap-3">
                <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg font-mono text-[13px] font-semibold text-white" style={{ backgroundColor: t.logo.color }}>
                  {t.logo.text}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-[14px] font-semibold text-fg">{t.name}</h2>
                  <p className="truncate font-mono text-xs text-fg-subtle" title={t.repoUrl}>{repoLabel(t.repoUrl)}</p>
                </div>
              </div>
              <p className="text-[13px] text-fg-muted">{t.description}</p>
              <div className="mt-auto flex flex-wrap gap-1.5">
                {t.tags.map((tag) => (
                  <span key={tag} className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-muted">{tag}</span>
                ))}
              </div>
            </div>
            <div className="border-t border-border p-3">
              <Link to={`${deployPath(t.repoUrl)}&workspace=${encodeURIComponent(ws)}`} className={buttonClass('primary', 'sm', 'w-full justify-center')}>
                Deploy <ArrowRight className="size-3.5" />
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

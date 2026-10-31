import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EnvVar, SecretFile } from '@nav/shared';
import { useEnvGroups } from '@/api/resources';
import { useEnvVars, useLinkEnvGroups, useReplaceEnvVars, useReplaceSecretFiles, useSecretFiles } from '@/api/services';
import { cleanEnvVars, EnvVarEditor, envVarErrors, SecretFilesEditor } from '@/components/EnvEditor';
import { Button, Card, CardBody, CardFooter, CardHeader, Checkbox, ErrorState, Skeleton, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useServiceCtx } from './context';
import { useDraft } from './useDraft';

const EMPTY_VARS: EnvVar[] = [];
const EMPTY_FILES: SecretFile[] = [];

function SaveBar({
  dirty,
  disabled,
  pending,
  onSave,
  onReset,
}: {
  dirty: boolean;
  disabled?: boolean;
  pending: boolean;
  onSave: (deploy: boolean) => void;
  onReset: () => void;
}) {
  return (
    <CardFooter>
      {dirty && <span className="mr-auto text-xs text-warning">Unsaved changes</span>}
      <Button variant="ghost" size="sm" onClick={onReset} disabled={!dirty || pending}>
        Discard
      </Button>
      <Button size="sm" onClick={() => onSave(false)} disabled={!dirty || disabled} loading={pending}>
        Save only
      </Button>
      <Button variant="primary" size="sm" onClick={() => onSave(true)} disabled={!dirty || disabled} loading={pending}>
        Save, rebuild & deploy
      </Button>
    </CardFooter>
  );
}

export function ServiceEnvironmentTab() {
  const { service } = useServiceCtx();
  const { ws, canWrite } = useWorkspace();
  const toast = useToast();

  const vars = useEnvVars(service.id);
  const varsDraft = useDraft(vars.data?.items, EMPTY_VARS);
  const saveVars = useReplaceEnvVars(service);

  const files = useSecretFiles(service.id);
  const filesDraft = useDraft(files.data?.items, EMPTY_FILES);
  const saveFiles = useReplaceSecretFiles(service);

  const groups = useEnvGroups(ws);
  const link = useLinkEnvGroups(service);
  const linkedServer = (groups.data?.items ?? []).filter((g) => g.serviceIds.includes(service.id)).map((g) => g.id);
  const [linked, setLinked] = useState<string[] | null>(null);
  useEffect(() => setLinked(null), [groups.data]);
  const linkedNow = linked ?? linkedServer;
  const linkDirty = linked !== null && [...linked].sort().join() !== [...linkedServer].sort().join();

  const varError = envVarErrors(varsDraft.draft);

  const onSaveVars = async (deploy: boolean) => {
    try {
      await saveVars.mutateAsync({ envVars: cleanEnvVars(varsDraft.draft), deploy });
      varsDraft.markSaved();
      toast.success(deploy ? 'Environment saved — deploy queued' : 'Environment saved', deploy ? undefined : 'Changes apply on the next deploy.');
    } catch (e) {
      toast.fromError(e, 'Could not save environment');
    }
  };

  const onSaveFiles = async (deploy: boolean) => {
    const bad = filesDraft.draft.find((f) => !f.filename.trim() || /[/\\]/.test(f.filename));
    if (bad) {
      toast.error('Invalid secret file', 'Each file needs a name without slashes.');
      return;
    }
    try {
      await saveFiles.mutateAsync({ secretFiles: filesDraft.draft.map((f) => ({ ...f, filename: f.filename.trim() })), deploy });
      filesDraft.markSaved();
      toast.success(deploy ? 'Secret files saved — deploy queued' : 'Secret files saved');
    } catch (e) {
      toast.fromError(e, 'Could not save secret files');
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Environment variables"
          description={
            <>
              Available to builds and at runtime. NAV also injects <code className="font-mono text-xs">PORT</code>,{' '}
              <code className="font-mono text-xs">NAV_SERVICE_NAME</code>, <code className="font-mono text-xs">NAV_GIT_COMMIT</code> and more.
            </>
          }
        />
        <CardBody>
          {vars.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : vars.isError ? (
            <ErrorState error={vars.error} onRetry={() => vars.refetch()} />
          ) : (
            <EnvVarEditor value={varsDraft.draft} onChange={varsDraft.setDraft} readOnly={!canWrite} />
          )}
        </CardBody>
        {canWrite && <SaveBar dirty={varsDraft.dirty} disabled={!!varError} pending={saveVars.isPending} onSave={onSaveVars} onReset={varsDraft.reset} />}
      </Card>

      <Card>
        <CardHeader title="Secret files" description="Files such as credentials or certificates, mounted read-only into every instance." />
        <CardBody>
          {files.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : files.isError ? (
            <ErrorState error={files.error} onRetry={() => files.refetch()} />
          ) : (
            <SecretFilesEditor value={filesDraft.draft} onChange={filesDraft.setDraft} readOnly={!canWrite} />
          )}
        </CardBody>
        {canWrite && <SaveBar dirty={filesDraft.dirty} pending={saveFiles.isPending} onSave={onSaveFiles} onReset={filesDraft.reset} />}
      </Card>

      <Card>
        <CardHeader
          title="Linked environment groups"
          description="Variables from linked groups are merged in; service-level variables win on conflicts."
          actions={
            <Link to={`/w/${ws}/env-groups`} className="text-xs font-medium text-accent hover:underline">
              Manage groups
            </Link>
          }
        />
        <CardBody>
          {groups.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : groups.isError ? (
            <ErrorState error={groups.error} onRetry={() => groups.refetch()} />
          ) : !groups.data.items.length ? (
            <p className="text-[13px] text-fg-subtle">No env groups in this workspace yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {groups.data.items.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3 py-2">
                  <Checkbox
                    checked={linkedNow.includes(g.id)}
                    disabled={!canWrite}
                    onChange={(v) => setLinked(v ? [...linkedNow, g.id] : linkedNow.filter((x) => x !== g.id))}
                    label={g.name}
                  />
                  <span className="flex items-center gap-3 text-xs text-fg-subtle">
                    {g.envVars.length} vars · {g.secretFiles.length} files
                    <Link to={`/w/${ws}/env-groups/${g.id}`} className="text-accent hover:underline">
                      Open
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
        {canWrite && (
          <CardFooter>
            <Button variant="ghost" size="sm" disabled={!linkDirty} onClick={() => setLinked(null)}>
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!linkDirty}
              loading={link.isPending}
              onClick={async () => {
                try {
                  await link.mutateAsync(linkedNow);
                  setLinked(null);
                  toast.success('Linked groups updated');
                } catch (e) {
                  toast.fromError(e, 'Could not update linked groups');
                }
              }}
            >
              Save links
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Trash2 } from 'lucide-react';
import type { EnvVar, SecretFile } from '@nav/shared';
import { isApiError } from '@/api/client';
import { useDeleteEnvGroup, useEnvGroup, useUpdateEnvGroup } from '@/api/resources';
import { useServices } from '@/api/services';
import { cleanEnvVars, envVarErrors, EnvVarEditor, SecretFilesEditor } from '@/components/EnvEditor';
import { ResourceIcon } from '@/components/ResourceIcon';
import { RelativeTime } from '@/components/RelativeTime';
import { Button, Card, CardBody, CardFooter, CardHeader, Empty, ErrorState, Input, PageHeader, Skeleton, StatusPill, useConfirm, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { serviceStatus } from '@/lib/misc';
import { useTitle } from '@/lib/useTitle';

function sameVars(a: EnvVar[], b: EnvVar[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function EnvGroupDetailPage() {
  const { groupId = '' } = useParams();
  const { ws, canWrite, isAdmin } = useWorkspace();
  const group = useEnvGroup(groupId);
  const services = useServices(ws, { includePreviews: true });
  const update = useUpdateEnvGroup(ws, groupId);
  const del = useDeleteEnvGroup(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  useTitle(group.data?.name ?? 'Env Group');

  const [name, setName] = useState('');
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [files, setFiles] = useState<SecretFile[]>([]);
  const [initialized, setInitialized] = useState<string | null>(null);

  useEffect(() => {
    if (group.data && initialized !== group.data.id) {
      setName(group.data.name);
      setVars(group.data.envVars);
      setFiles(group.data.secretFiles);
      setInitialized(group.data.id);
    }
  }, [group.data, initialized]);

  const linked = useMemo(() => {
    const ids = new Set(group.data?.serviceIds ?? []);
    return (services.data?.items ?? []).filter((s) => ids.has(s.id));
  }, [group.data, services.data]);

  if (group.isPending) return <Skeleton className="h-64 w-full" />;
  if (group.isError) {
    if (isApiError(group.error) && group.error.isNotFound) {
      return <Empty title="Env group not found" action={<Link to={`/w/${ws}/env-groups`} className="text-[13px] text-accent hover:underline">Back to Env Groups</Link>} />;
    }
    return <ErrorState error={group.error} onRetry={() => group.refetch()} />;
  }
  const g = group.data;

  const varsDirty = !sameVars(cleanEnvVars(vars), g.envVars);
  const filesDirty = JSON.stringify(files) !== JSON.stringify(g.secretFiles);
  const varsErr = envVarErrors(vars);
  const filesErr = files.some((f) => !f.filename.trim()) ? 'Every secret file needs a filename.' : null;

  const save = async () => {
    if (g.serviceIds.length) {
      const ok = await confirm({
        title: 'Save and redeploy linked services?',
        body: `${g.serviceIds.length} linked service${g.serviceIds.length === 1 ? '' : 's'} will redeploy with the new values.`,
        confirmText: 'Save & redeploy',
      });
      if (!ok) return;
    }
    try {
      const updated = await update.mutateAsync({
        ...(varsDirty ? { envVars: cleanEnvVars(vars) } : {}),
        ...(filesDirty ? { secretFiles: files.map((f) => ({ filename: f.filename.trim(), content: f.content })) } : {}),
      });
      setVars(updated.envVars);
      setFiles(updated.secretFiles);
      toast.success('Env group saved');
    } catch (e) {
      toast.fromError(e, 'Could not save env group');
    }
  };

  const rename = async () => {
    try {
      await update.mutateAsync({ name: name.trim() });
      toast.success('Env group renamed');
    } catch (e) {
      toast.fromError(e, 'Could not rename');
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete ${g.name}?`,
      body: linked.length ? `It is linked to ${linked.length} service(s); they will lose these variables on their next deploy.` : 'This cannot be undone.',
      typeToConfirm: g.name,
      confirmText: 'Delete group',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(g.id);
      toast.success('Env group deleted');
      navigate(`/w/${ws}/env-groups`);
    } catch (e) {
      toast.fromError(e, 'Could not delete env group');
    }
  };

  return (
    <div className="space-y-5">
      <Link to={`/w/${ws}/env-groups`} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Env Groups
      </Link>
      <PageHeader
        icon={<Boxes className="size-4" />}
        title={g.name}
        description={
          <>
            {g.envVars.length} variables · {g.secretFiles.length} secret files · updated <RelativeTime value={g.updatedAt} />
          </>
        }
      />

      <Card>
        <CardHeader title="Name" />
        <CardBody className="flex max-w-lg gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} aria-label="Group name" />
          {canWrite && (
            <Button onClick={rename} disabled={!name.trim() || name === g.name}>
              Rename
            </Button>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Environment variables" description="Service-level variables override group values with the same key." />
        <CardBody>
          <EnvVarEditor value={vars} onChange={setVars} readOnly={!canWrite} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Secret files" />
        <CardBody>
          <SecretFilesEditor value={files} onChange={setFiles} readOnly={!canWrite} />
          {filesErr && <p className="mt-2 text-xs text-danger">{filesErr}</p>}
        </CardBody>
        {canWrite && (
          <CardFooter className="justify-between">
            <span className="text-xs text-fg-subtle">{varsDirty || filesDirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
            <div className="flex gap-2">
              {(varsDirty || filesDirty) && (
                <Button
                  onClick={() => {
                    setVars(g.envVars);
                    setFiles(g.secretFiles);
                  }}
                >
                  Discard
                </Button>
              )}
              <Button variant="primary" disabled={(!varsDirty && !filesDirty) || !!varsErr || !!filesErr} loading={update.isPending} onClick={save}>
                {g.serviceIds.length ? 'Save & redeploy linked' : 'Save changes'}
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader title="Linked services" description="Link a group from a service's Environment tab." />
        {g.serviceIds.length === 0 ? (
          <CardBody className="text-[13px] text-fg-subtle">No services use this group yet.</CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {linked.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <ResourceIcon kind={s.type} />
                <Link to={`/w/${ws}/services/${s.id}`} className="flex-1 truncate text-[13px] font-medium text-fg hover:underline">
                  {s.name}
                </Link>
                <StatusPill status={serviceStatus(s)} />
              </li>
            ))}
            {g.serviceIds.length > linked.length && !services.isPending && (
              <li className="px-4 py-2.5 text-xs text-fg-subtle">{g.serviceIds.length - linked.length} service(s) not visible in this list.</li>
            )}
          </ul>
        )}
      </Card>

      {isAdmin && (
        <Card className="border-danger/40">
          <CardHeader title={<span className="text-danger">Danger zone</span>} />
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-fg-muted">Delete this environment group permanently.</p>
            <Button variant="outline-danger" icon={<Trash2 className="size-3.5" />} loading={del.isPending} onClick={onDelete}>
              Delete group
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

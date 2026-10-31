import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { Database, Project, Service } from '@nav/shared';
import { useDatabases } from '@/api/databases';
import { useServices } from '@/api/services';
import { useAddEnvironment, useCreateProject, useDeleteEnvironment, useDeleteProject, useProjects, useRenameProject } from '@/api/workspaces';
import { ResourceIcon } from '@/components/ResourceIcon';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  Empty,
  ErrorState,
  Field,
  IconButton,
  Input,
  PageHeader,
  SkeletonCard,
  StatusPill,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';

type Resource = { kind: 'service'; item: Service } | { kind: 'database'; item: Database };

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ws } = useWorkspace();
  const create = useCreateProject(ws);
  const toast = useToast();
  const [name, setName] = useState('');
  const [envs, setEnvs] = useState('production, staging');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const environments = envs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await create.mutateAsync({ name: name.trim(), environments: environments.length ? environments : undefined });
      toast.success('Project created', name.trim());
      setName('');
      onClose();
    } catch (err) {
      toast.fromError(err, 'Could not create project');
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="Projects group related services and databases into environments like production and staging."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="new-project" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            Create project
          </Button>
        </>
      }
    >
      <form id="new-project" onSubmit={submit} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Storefront" autoFocus />}</Field>
        <Field label="Environments" hint="Comma-separated. Defaults to production.">
          {(id) => <Input id={id} value={envs} onChange={(e) => setEnvs(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

function AddEnvironmentDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const { ws } = useWorkspace();
  const add = useAddEnvironment(ws);
  const toast = useToast();
  const [name, setName] = useState('');
  const [prot, setProt] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    try {
      await add.mutateAsync({ projectId: project.id, name: name.trim(), protected: prot });
      toast.success('Environment added', name.trim());
      setName('');
      setProt(false);
      onClose();
    } catch (err) {
      toast.fromError(err, 'Could not add environment');
    }
  };
  return (
    <Dialog
      open={!!project}
      onClose={onClose}
      title={`Add environment to ${project?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="add-env" variant="primary" loading={add.isPending} disabled={!name.trim()}>
            Add environment
          </Button>
        </>
      }
    >
      <form id="add-env" onSubmit={submit} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="staging" autoFocus />}</Field>
        <Checkbox checked={prot} onChange={setProt} label="Protected — only admins can modify resources in this environment" />
      </form>
    </Dialog>
  );
}

function RenameDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const { ws } = useWorkspace();
  const rename = useRenameProject(ws);
  const toast = useToast();
  const [name, setName] = useState('');
  const current = project?.name ?? '';
  return (
    <Dialog
      open={!!project}
      onClose={onClose}
      title="Rename project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="rename-project" variant="primary" loading={rename.isPending} disabled={!name.trim() || name.trim() === current}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="rename-project"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!project) return;
          try {
            await rename.mutateAsync({ id: project.id, name: name.trim() });
            toast.success('Project renamed');
            onClose();
          } catch (err) {
            toast.fromError(err, 'Could not rename project');
          }
        }}
      >
        <Field label="Name">{(id) => <Input id={id} defaultValue={current} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
      </form>
    </Dialog>
  );
}

function ResourceLine({ r, ws }: { r: Resource; ws: string }) {
  const href = r.kind === 'service' ? `/w/${ws}/services/${r.item.id}` : `/w/${ws}/databases/${r.item.id}`;
  return (
    <li>
      <Link to={href} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2">
        <ResourceIcon kind={r.kind === 'service' ? r.item.type : 'postgres'} className="size-6" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.item.name}</span>
        <StatusPill status={r.item.status} />
      </Link>
    </li>
  );
}

export function ProjectsPage() {
  useTitle('Projects');
  const { ws, canWrite, isAdmin } = useWorkspace();
  const projects = useProjects(ws);
  const services = useServices(ws);
  const databases = useDatabases(ws);
  const del = useDeleteProject(ws);
  const delEnv = useDeleteEnvironment(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [addEnvTo, setAddEnvTo] = useState<Project | null>(null);
  const [renaming, setRenaming] = useState<Project | null>(null);

  const byEnv = useMemo(() => {
    const m = new Map<string, Resource[]>();
    const push = (envId: string | null, r: Resource) => {
      if (!envId) return;
      m.set(envId, [...(m.get(envId) ?? []), r]);
    };
    for (const s of services.data?.items ?? []) push(s.environmentId, { kind: 'service', item: s });
    for (const d of databases.data?.items ?? []) push(d.environmentId, { kind: 'database', item: d });
    return m;
  }, [services.data, databases.data]);

  const unassigned = (services.data?.items.filter((s) => !s.environmentId).length ?? 0) + (databases.data?.items.filter((d) => !d.environmentId).length ?? 0);

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Organise resources by project and environment."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New project
            </Button>
          )
        }
      />
      {projects.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : projects.data.items.length === 0 ? (
        <Empty
          icon={<FolderKanban className="size-4" />}
          title="No projects yet"
          description="Create a project to group services and databases into environments like production and staging."
          action={
            canWrite && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New project
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-5">
          {projects.data.items.map((p) => (
            <Card key={p.id}>
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <FolderKanban className="size-4 text-accent" />
                <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{p.name}</h2>
                <span className="text-xs text-fg-subtle">{p.environments.length} environments</span>
                {canWrite && (
                  <Dropdown align="end" trigger={(t) => <IconButton {...t} label={`Actions for ${p.name}`} icon={<MoreHorizontal className="size-4" />} />}>
                    <DropdownItem icon={<Plus className="size-3.5" />} onSelect={() => setAddEnvTo(p)}>
                      Add environment
                    </DropdownItem>
                    <DropdownItem icon={<Pencil className="size-3.5" />} onSelect={() => setRenaming(p)}>
                      Rename
                    </DropdownItem>
                    {isAdmin && (
                      <>
                        <DropdownSeparator />
                        <DropdownItem
                          danger
                          icon={<Trash2 className="size-3.5" />}
                          onSelect={async () => {
                            const ok = await confirm({
                              title: `Delete project ${p.name}?`,
                              body: 'Services and databases are detached from the project, not deleted.',
                              danger: true,
                              confirmText: 'Delete project',
                            });
                            if (!ok) return;
                            del.mutate(p.id, { onSuccess: () => toast.success('Project deleted'), onError: (e) => toast.fromError(e, 'Could not delete project') });
                          }}
                        >
                          Delete project
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                )}
              </div>
              <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
                {p.environments.map((env) => {
                  const items = byEnv.get(env.id) ?? [];
                  return (
                    <div key={env.id} className="bg-surface p-3">
                      <div className="mb-2 flex items-center gap-2 px-2">
                        <span className="text-[13px] font-medium">{env.name}</span>
                        {env.protected && (
                          <Badge tone="warning">
                            <ShieldCheck className="size-3" /> protected
                          </Badge>
                        )}
                        <span className="ml-auto text-xs text-fg-subtle">{items.length}</span>
                        {isAdmin && (
                          <IconButton
                            size="xs"
                            label={`Delete environment ${env.name}`}
                            icon={<Trash2 className="size-3" />}
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Delete environment ${env.name}?`,
                                body: 'Resources in it are detached, not deleted.',
                                danger: true,
                                confirmText: 'Delete environment',
                              });
                              if (ok) delEnv.mutate(env.id, { onError: (e) => toast.fromError(e, 'Could not delete environment') });
                            }}
                          />
                        )}
                      </div>
                      {items.length ? (
                        <ul className="space-y-0.5">
                          {items.map((r) => (
                            <ResourceLine key={`${r.kind}-${r.item.id}`} r={r} ws={ws} />
                          ))}
                        </ul>
                      ) : (
                        <p className="px-2 py-3 text-xs text-fg-subtle">No resources. Choose this environment when creating a service or database.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
          {unassigned > 0 && (
            <p className="text-[13px] text-fg-subtle">
              {unassigned} resource{unassigned === 1 ? ' is' : 's are'} not assigned to any project.{' '}
              <Link to={`/w/${ws}`} className="text-accent hover:underline">
                View all
              </Link>
            </p>
          )}
        </div>
      )}
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
      <AddEnvironmentDialog project={addEnvTo} onClose={() => setAddEnvTo(null)} />
      <RenameDialog key={renaming?.id} project={renaming} onClose={() => setRenaming(null)} />
    </div>
  );
}

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useCreateBlueprint } from '@/api/resources';
import { useBranches, useRepos } from '@/api/workspaces';
import { ResourceIcon } from '@/components/ResourceIcon';
import { Button, Card, CardBody, CardHeader, Empty, Field, Input, PageHeader, Select, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { repoSlug } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';
import { YamlValidator } from './YamlValidator';

const REPO_RE = /^(https?:\/\/|git@|ssh:\/\/).+/;

export function NewBlueprintPage() {
  useTitle('New Blueprint');
  const { ws, canWrite, config } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateBlueprint(ws);
  const repos = useRepos(ws, !!config?.githubEnabled);

  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [filePath, setFilePath] = useState('nav.yaml');
  const branches = useBranches(repoUrl);

  const repoOptions = useMemo(() => (repos.data?.items ?? []).map((r) => ({ value: r.cloneUrl, label: `${r.fullName}${r.private ? ' (private)' : ''}` })), [repos.data]);

  useEffect(() => {
    const items = branches.data?.items;
    if (!items?.length) return;
    if (!branch || !items.includes(branch)) {
      const def = repos.data?.items.find((r) => r.cloneUrl === repoUrl)?.defaultBranch;
      setBranch(def && items.includes(def) ? def : items.includes('main') ? 'main' : items[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches.data]);

  const repoErr = repoUrl && !REPO_RE.test(repoUrl) ? 'Enter an https:// or git@ URL.' : null;
  const invalid = !name.trim() || !repoUrl || !!repoErr || !branch.trim() || !filePath.trim();

  if (!canWrite) return <Empty title="Read-only access" description="Viewers cannot create blueprints." />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const bp = await create.mutateAsync({ name: name.trim(), repoUrl: repoUrl.trim(), branch: branch.trim(), filePath: filePath.trim() });
      toast.success('Blueprint created', 'The first sync has started.');
      navigate(`/w/${ws}/blueprints/${bp.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not create blueprint');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link to={`/w/${ws}/blueprints`} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Blueprints
      </Link>
      <PageHeader icon={<ResourceIcon kind="blueprint" boxed={false} />} title="New Blueprint Instance" description="Connect a repository containing a nav.yaml file." />
      <form onSubmit={submit}>
        <Card>
          <CardHeader title="Source" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Blueprint name" className="sm:col-span-2">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="production-stack" autoFocus />}
            </Field>
            {config?.githubEnabled && repoOptions.length > 0 && (
              <Field label="Connected repository" optional className="sm:col-span-2" hint="Pick one of your GitHub repositories, or paste any Git URL below.">
                {(id) => (
                  <Select
                    id={id}
                    value={repoOptions.some((o) => o.value === repoUrl) ? repoUrl : ''}
                    onChange={(e) => {
                      setRepoUrl(e.target.value);
                      setBranch('');
                      if (!name && e.target.value) setName(repoSlug(e.target.value).split('/').pop() ?? '');
                    }}
                    placeholder="Select a repository"
                    options={repoOptions}
                  />
                )}
              </Field>
            )}
            <Field label="Repository URL" error={repoErr} className="sm:col-span-2">
              {(id) => (
                <Input
                  id={id}
                  mono
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/acme/infra"
                  aria-invalid={!!repoErr}
                />
              )}
            </Field>
            <Field label="Branch" hint={branches.isFetching ? 'Loading branches…' : branches.isError ? 'Could not list branches; type one.' : undefined}>
              {(id) =>
                branches.data?.items.length ? (
                  <Select id={id} value={branch} onChange={(e) => setBranch(e.target.value)} options={branches.data.items.map((b) => ({ value: b, label: b }))} />
                ) : (
                  <Input id={id} mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
                )
              }
            </Field>
            <Field label="Blueprint file path">{(id) => <Input id={id} mono value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="nav.yaml" />}</Field>
          </CardBody>
          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <Button onClick={() => navigate(`/w/${ws}/blueprints`)}>Cancel</Button>
            <Button variant="primary" type="submit" loading={create.isPending} disabled={invalid}>
              Create & sync
            </Button>
          </div>
        </Card>
      </form>
      <YamlValidator />
    </div>
  );
}

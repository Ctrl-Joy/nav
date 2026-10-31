import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DATABASE_PLANS, slugify } from '@nav/shared';
import { useCreateDatabase } from '@/api/databases';
import { useProjects } from '@/api/workspaces';
import { PlanPicker } from '@/components/PlanPicker';
import { ResourceIcon } from '@/components/ResourceIcon';
import { Button, Card, CardBody, CardHeader, Empty, Field, Input, PageHeader, Segmented, Select, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9 _-]{0,62}$/;
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function NewDatabasePage() {
  useTitle('New Postgres');
  const { ws, canWrite } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateDatabase(ws);
  const projects = useProjects(ws);

  const [name, setName] = useState('');
  const [dbName, setDbName] = useState('');
  const [user, setUser] = useState('');
  const [version, setVersion] = useState<'15' | '16' | '17'>('17');
  const [environmentId, setEnvironmentId] = useState('');
  const [plan, setPlan] = useState('free');
  const [disk, setDisk] = useState(1);

  const derived = slugify(name || 'app').replace(/-/g, '_');
  const envOptions = useMemo(
    () => (projects.data?.items ?? []).flatMap((p) => p.environments.map((e) => ({ value: e.id, label: `${p.name} / ${e.name}` }))),
    [projects.data],
  );

  const nameErr = name && !NAME_RE.test(name) ? 'Start with a letter; letters, digits, spaces, - and _ only.' : null;
  const dbErr = dbName && !IDENT_RE.test(dbName) ? 'Lowercase letters, digits and _ only.' : null;
  const userErr = user && !IDENT_RE.test(user) ? 'Lowercase letters, digits and _ only.' : null;
  const diskErr = !Number.isInteger(disk) || disk < 1 || disk > 1024 ? 'Between 1 and 1024 GB.' : null;
  const invalid = !name.trim() || !!nameErr || !!dbErr || !!userErr || !!diskErr;

  if (!canWrite) {
    return <Empty title="Read-only access" description="Viewers cannot create databases. Ask a workspace admin for developer access." />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    try {
      const db = await create.mutateAsync({
        name: name.trim(),
        databaseName: dbName || undefined,
        user: user || undefined,
        pgVersion: Number(version),
        environmentId: environmentId || null,
        plan,
        diskGB: disk,
      });
      toast.success('Database is being created', db.name);
      navigate(`/w/${ws}/databases/${db.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not create database');
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to={`/w/${ws}/databases`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Postgres
      </Link>
      <PageHeader icon={<ResourceIcon kind="postgres" boxed={false} />} title="New Postgres" description="A dedicated PostgreSQL cluster with daily backups." />
      <form onSubmit={submit} className="space-y-5">
        <Card>
          <CardHeader title="Database" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={nameErr} hint="Shown in the dashboard." className="sm:col-span-2">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="main-db" autoFocus aria-invalid={!!nameErr} />}
            </Field>
            <Field label="Database name" optional error={dbErr}>
              {(id) => <Input id={id} mono value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder={derived} aria-invalid={!!dbErr} />}
            </Field>
            <Field label="User" optional error={userErr}>
              {(id) => <Input id={id} mono value={user} onChange={(e) => setUser(e.target.value)} placeholder={derived} aria-invalid={!!userErr} />}
            </Field>
            <Field label="PostgreSQL version">
              {() => (
                <Segmented
                  label="PostgreSQL version"
                  value={version}
                  onChange={setVersion}
                  options={[
                    { value: '15', label: '15' },
                    { value: '16', label: '16' },
                    { value: '17', label: '17' },
                  ]}
                />
              )}
            </Field>
            <Field label="Project / environment" optional>
              {(id) => <Select id={id} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} placeholder="None" options={envOptions} />}
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Instance type" description="CPU and memory reserved for this database." />
          <CardBody>
            <PlanPicker plans={DATABASE_PLANS} value={plan} onChange={setPlan} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Storage" />
          <CardBody>
            <Field label="Disk size (GB)" error={diskErr} hint="Disks can be grown later, never shrunk." className="max-w-48">
              {(id) => <Input id={id} type="number" min={1} max={1024} value={disk} onChange={(e) => setDisk(Number(e.target.value))} aria-invalid={!!diskErr} />}
            </Field>
          </CardBody>
        </Card>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(`/w/${ws}/databases`)}>Cancel</Button>
          <Button variant="primary" type="submit" loading={create.isPending} disabled={invalid}>
            Create database
          </Button>
        </div>
      </form>
    </div>
  );
}

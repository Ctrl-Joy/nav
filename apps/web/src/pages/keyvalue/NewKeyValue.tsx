import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { KEY_VALUE_PLANS, KEY_VALUE_POLICIES } from '@nav/shared';
import { useCreateKeyValue, useKeyValuePlans } from '@/api/keyvalue';
import { useProjects } from '@/api/workspaces';
import { IpRulesEditor, normalizeRules, rulesValid, type IpRule } from '@/components/IpRulesEditor';
import { PlanPicker } from '@/components/PlanPicker';
import { ResourceIcon } from '@/components/ResourceIcon';
import { Button, Card, CardBody, CardHeader, Empty, Field, Input, PageHeader, Select, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9 _-]{0,63}$/;

/** What each maxmemory policy evicts once the instance is full. */
export const POLICY_HELP: Record<string, string> = {
  'allkeys-lru': 'Evict the least recently used keys. Best for caches.',
  noeviction: 'Never evict; writes fail when memory is full. Best for queues and persistent data.',
  'allkeys-lfu': 'Evict the least frequently used keys.',
  'volatile-lru': 'Evict the least recently used keys that have a TTL.',
  'volatile-lfu': 'Evict the least frequently used keys that have a TTL.',
  'allkeys-random': 'Evict random keys.',
  'volatile-random': 'Evict random keys that have a TTL.',
  'volatile-ttl': 'Evict keys with the shortest remaining TTL first.',
};

export function NewKeyValuePage() {
  useTitle('New Key Value');
  const { ws, canWrite } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateKeyValue(ws);
  const projects = useProjects(ws);
  const meta = useKeyValuePlans();
  const plans = meta.data?.plans ?? KEY_VALUE_PLANS;
  const policies = meta.data?.policies ?? [...KEY_VALUE_POLICIES];

  const [name, setName] = useState('');
  const [plan, setPlan] = useState('free');
  const [policy, setPolicy] = useState('allkeys-lru');
  const [environmentId, setEnvironmentId] = useState('');
  const [rules, setRules] = useState<IpRule[]>([]);

  const envOptions = useMemo(
    () => (projects.data?.items ?? []).flatMap((p) => p.environments.map((e) => ({ value: e.id, label: `${p.name} / ${e.name}` }))),
    [projects.data],
  );

  const nameErr = name && !NAME_RE.test(name) ? 'Start with a letter; letters, digits, spaces, - and _ only.' : null;
  const invalid = !name.trim() || !!nameErr || !rulesValid(rules);

  if (!canWrite) {
    return <Empty title="Read-only access" description="Viewers cannot create Key Value instances. Ask a workspace admin for developer access." />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    try {
      const kv = await create.mutateAsync({
        name: name.trim(),
        plan,
        maxmemoryPolicy: policy,
        ipAllowList: normalizeRules(rules),
        environmentId: environmentId || null,
      });
      toast.success('Key Value is being created', kv.name);
      navigate(`/w/${ws}/key-value/${kv.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not create Key Value');
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to={`/w/${ws}/key-value`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Key Value
      </Link>
      <PageHeader icon={<ResourceIcon kind="keyvalue" boxed={false} />} title="New Key Value" description="A Redis-compatible instance, reachable from your services over the private network." />
      <form onSubmit={submit} className="space-y-5">
        <Card>
          <CardHeader title="Key Value" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={nameErr} hint="Shown in the dashboard." className="sm:col-span-2">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="cache" autoFocus aria-invalid={!!nameErr} />}
            </Field>
            <Field label="Maxmemory policy" hint={POLICY_HELP[policy]}>
              {(id) => <Select id={id} value={policy} onChange={(e) => setPolicy(e.target.value)} options={policies.map((p) => ({ value: p, label: p }))} />}
            </Field>
            <Field label="Project / environment" optional>
              {(id) => <Select id={id} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} placeholder="None" options={envOptions} />}
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Instance type" description="Memory is the instance's maxmemory limit." />
          <CardBody>
            <PlanPicker plans={plans} value={plan} onChange={setPlan} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Inbound IP rules" description="Sources allowed to connect through the external URL. Services in this workspace always connect over the private network." />
          <CardBody>
            <IpRulesEditor rows={rules} onChange={setRules} disabled={false} emptyText="No rules. External connections are blocked." footnote="Add 0.0.0.0/0 to allow connections from anywhere." />
          </CardBody>
        </Card>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(`/w/${ws}/key-value`)}>Cancel</Button>
          <Button variant="primary" type="submit" loading={create.isPending} disabled={invalid}>
            Create Key Value
          </Button>
        </div>
      </form>
    </div>
  );
}

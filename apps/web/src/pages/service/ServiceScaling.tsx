import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { SERVICE_PLANS, type Autoscaling } from '@nav/shared';
import { useInstances, useScaleService, useUpdateService } from '@/api/services';
import { PlanPicker } from '@/components/PlanPicker';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Empty,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  StatusPill,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatMemory } from '@/lib/format';
import { useServiceCtx } from './context';

const MAX = 10;

export function ServiceScalingTab() {
  const { service } = useServiceCtx();
  const { canWrite } = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();
  const scale = useScaleService(service);
  const update = useUpdateService(service);
  const instances = useInstances(service.id);

  const [count, setCount] = useState(service.instanceCount);
  const [auto, setAuto] = useState<Autoscaling>(service.autoscaling);
  const [plan, setPlan] = useState(service.plan);
  useEffect(() => setCount(service.instanceCount), [service.instanceCount]);
  useEffect(() => setAuto(service.autoscaling), [service.autoscaling]);
  useEffect(() => setPlan(service.plan), [service.plan]);

  if (service.type === 'static') {
    return <Empty icon={<Server className="size-5" />} title="Static sites scale automatically" description="Static sites are served directly by the NAV edge — there are no instances to scale." />;
  }

  const autoDirty = JSON.stringify(auto) !== JSON.stringify(service.autoscaling);
  const autoInvalid = auto.enabled && (auto.min < 1 || auto.max < auto.min || (!auto.targetCpuPercent && !auto.targetMemoryPercent));

  const saveCount = async () => {
    try {
      await scale.mutateAsync(count);
      toast.success(`Scaling to ${count} instance${count === 1 ? '' : 's'}`);
    } catch (e) {
      toast.fromError(e, 'Could not scale');
    }
  };

  const saveAuto = async () => {
    try {
      await update.mutateAsync({ autoscaling: auto });
      toast.success(auto.enabled ? 'Autoscaling enabled' : 'Autoscaling disabled');
    } catch (e) {
      toast.fromError(e, 'Could not update autoscaling');
    }
  };

  const savePlan = async () => {
    const p = SERVICE_PLANS.find((x) => x.id === plan);
    if (!p) return;
    const ok = await confirm({
      title: `Change instance type to ${p.name}?`,
      body: `${p.cpu} vCPU · ${formatMemory(p.memoryMB)} · $${p.priceMonthly}/month per instance. The new size applies on the next deploy.`,
      confirmText: 'Change instance type',
    });
    if (!ok) return;
    try {
      await update.mutateAsync({ plan });
      toast.success('Instance type updated');
    } catch (e) {
      toast.fromError(e, 'Could not change instance type');
    }
  };

  const numberField = (label: string, value: number | null, onChange: (v: number | null) => void, opts: { min: number; max: number; suffix?: string; optional?: boolean }) => (
    <Field label={label} optional={opts.optional}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={opts.min}
          max={opts.max}
          value={value ?? ''}
          disabled={!canWrite || !auto.enabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Math.max(opts.min, Math.min(opts.max, Number(e.target.value))))}
          trailing={opts.suffix ? <span className="pr-1.5 text-xs text-fg-subtle">{opts.suffix}</span> : undefined}
        />
      )}
    </Field>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Manual scaling" description="Number of instances running the live deploy. Traffic is load-balanced across healthy instances." />
        <CardBody>
          {service.autoscaling.enabled ? (
            <p className="text-[13px] text-fg-muted">Autoscaling is on — NAV manages the instance count between {service.autoscaling.min} and {service.autoscaling.max}.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <input
                type="range"
                min={1}
                max={MAX}
                value={count}
                disabled={!canWrite}
                onChange={(e) => setCount(Number(e.target.value))}
                aria-label="Instance count"
                className="w-full max-w-md accent-[var(--accent)]"
              />
              <Input
                type="number"
                min={1}
                max={MAX}
                value={count}
                disabled={!canWrite}
                onChange={(e) => setCount(Math.max(1, Math.min(MAX, Number(e.target.value) || 1)))}
                aria-label="Instance count value"
                className="w-20"
              />
              <span className="text-[13px] text-fg-muted">instance{count === 1 ? '' : 's'}</span>
            </div>
          )}
        </CardBody>
        {canWrite && !service.autoscaling.enabled && (
          <CardFooter>
            <Button variant="primary" size="sm" disabled={count === service.instanceCount} loading={scale.isPending} onClick={saveCount}>
              Save
            </Button>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader title="Autoscaling" description="Add or remove instances automatically based on average CPU or memory utilisation." />
        <CardBody className="space-y-4">
          <Switch checked={auto.enabled} disabled={!canWrite} onChange={(v) => setAuto({ ...auto, enabled: v, targetCpuPercent: auto.targetCpuPercent ?? (v ? 70 : null) })} label="Enable autoscaling" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {numberField('Minimum instances', auto.min, (v) => setAuto({ ...auto, min: v ?? 1 }), { min: 1, max: 100 })}
            {numberField('Maximum instances', auto.max, (v) => setAuto({ ...auto, max: v ?? 1 }), { min: 1, max: 100 })}
            {numberField('Target CPU', auto.targetCpuPercent, (v) => setAuto({ ...auto, targetCpuPercent: v }), { min: 1, max: 100, suffix: '%', optional: true })}
            {numberField('Target memory', auto.targetMemoryPercent, (v) => setAuto({ ...auto, targetMemoryPercent: v }), { min: 1, max: 100, suffix: '%', optional: true })}
          </div>
          {autoInvalid && <p className="text-xs text-danger">Max must be ≥ min, and set at least one target.</p>}
        </CardBody>
        {canWrite && (
          <CardFooter>
            <Button variant="ghost" size="sm" disabled={!autoDirty} onClick={() => setAuto(service.autoscaling)}>
              Discard
            </Button>
            <Button variant="primary" size="sm" disabled={!autoDirty || autoInvalid} loading={update.isPending} onClick={saveAuto}>
              Save autoscaling
            </Button>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader title="Instance type" description="CPU and memory allocated to each instance." />
        <CardBody>
          <PlanPicker plans={SERVICE_PLANS} value={plan} onChange={setPlan} disabled={!canWrite} />
        </CardBody>
        {canWrite && (
          <CardFooter>
            <Button variant="primary" size="sm" disabled={plan === service.plan} loading={update.isPending} onClick={savePlan}>
              Change instance type
            </Button>
          </CardFooter>
        )}
      </Card>

      <div>
        <h3 className="mb-2 text-[14px] font-semibold">Instances</h3>
        {instances.isPending ? (
          <SkeletonRows rows={2} />
        ) : instances.isError ? (
          <ErrorState error={instances.error} onRetry={() => instances.refetch()} />
        ) : !instances.data.items.length ? (
          <Empty compact title="No running instances" description={service.suspended ? 'The service is suspended.' : 'Instances appear once a deploy goes live.'} />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Instance</Th>
                <Th>Status</Th>
                <Th>Deploy</Th>
                <Th>Node</Th>
                <Th>Restarts</Th>
                <Th>Last exit</Th>
                <Th>Started</Th>
              </tr>
            </THead>
            <TBody>
              {instances.data.items.map((i) => (
                <Tr key={i.id}>
                  <Td className="font-mono text-xs">{i.id.slice(-12)}</Td>
                  <Td>
                    <StatusPill status={i.status} />
                  </Td>
                  <Td className="font-mono text-xs text-fg-muted">{i.deployId.slice(-8)}</Td>
                  <Td className="font-mono text-xs text-fg-muted">{i.nodeId}</Td>
                  <Td className={i.restartCount > 0 ? 'text-warning' : 'text-fg-muted'}>{i.restartCount}</Td>
                  <Td className="font-mono text-xs text-fg-muted">{i.lastExitCode ?? '—'}</Td>
                  <Td className="text-xs text-fg-muted">
                    <RelativeTime value={i.startedAt} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}

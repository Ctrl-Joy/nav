import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Boxes, Plus } from 'lucide-react';
import { useCreateEnvGroup, useEnvGroups } from '@/api/resources';
import { RelativeTime } from '@/components/RelativeTime';
import { Button, Dialog, Empty, ErrorState, Field, Input, PageHeader, SkeletonRows, Table, TBody, Td, Th, THead, Tr, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';

export function EnvGroupsPage() {
  useTitle('Env Groups');
  const { ws, canWrite } = useWorkspace();
  const groups = useEnvGroups(ws);
  const create = useCreateEnvGroup(ws);
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const g = await create.mutateAsync({ name: name.trim(), envVars: [], secretFiles: [] });
      toast.success('Environment group created', g.name);
      setOpen(false);
      setName('');
      navigate(`/w/${ws}/env-groups/${g.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not create group');
    }
  };

  const newBtn = canWrite && (
    <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
      New Env Group
    </Button>
  );

  return (
    <div>
      <PageHeader icon={<Boxes className="size-4" />} title="Env Groups" description="Share environment variables and secret files across services. Linked services redeploy when a group changes." actions={newBtn} />
      {groups.isPending ? (
        <SkeletonRows rows={4} />
      ) : groups.isError ? (
        <ErrorState error={groups.error} onRetry={() => groups.refetch()} />
      ) : !groups.data.items.length ? (
        <Empty icon={<Boxes className="size-4" />} title="No environment groups" description="Create a group for settings shared by several services, like API keys or feature flags." action={newBtn} />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Variables</Th>
              <Th className="hidden sm:table-cell">Secret files</Th>
              <Th>Linked services</Th>
              <Th className="hidden md:table-cell">Updated</Th>
            </tr>
          </THead>
          <TBody>
            {groups.data.items.map((g) => (
              <Tr key={g.id} interactive onClick={() => navigate(`/w/${ws}/env-groups/${g.id}`)}>
                <Td>
                  <Link to={`/w/${ws}/env-groups/${g.id}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                    {g.name}
                  </Link>
                </Td>
                <Td className="font-mono text-xs text-fg-muted">{g.envVars.length}</Td>
                <Td className="hidden font-mono text-xs text-fg-muted sm:table-cell">{g.secretFiles.length}</Td>
                <Td className="font-mono text-xs text-fg-muted">{g.serviceIds.length}</Td>
                <Td className="hidden text-fg-muted md:table-cell">
                  <RelativeTime value={g.updatedAt} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New environment group"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="new-env-group" loading={create.isPending} disabled={!name.trim()}>
              Create group
            </Button>
          </>
        }
      >
        <form id="new-env-group" onSubmit={submit}>
          <Field label="Name" hint="You can add variables after creating the group.">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="shared-settings" autoFocus />}
          </Field>
        </form>
      </Dialog>
    </div>
  );
}

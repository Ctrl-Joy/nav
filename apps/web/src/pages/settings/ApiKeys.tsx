import { useState, type FormEvent } from 'react';
import { AlertTriangle, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/api/auth';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Button,
  CodeBlock,
  CopyField,
  Dialog,
  Empty,
  ErrorState,
  Field,
  IconButton,
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useTitle } from '@/lib/useTitle';

function CreateKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateApiKey();
  const toast = useToast();
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);

  const close = () => {
    setToken(null);
    setName('');
    create.reset();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await create.mutateAsync(name.trim());
      setToken(res.token);
    } catch (err) {
      toast.fromError(err, 'Could not create API key');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissable={!create.isPending}
      title={token ? 'Copy your new API key' : 'Create API key'}
      description={token ? undefined : 'API keys authenticate the nav CLI and REST API with your permissions.'}
      footer={
        token ? (
          <Button variant="primary" onClick={close}>
            I’ve saved it
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" form="create-key" variant="primary" loading={create.isPending} disabled={!name.trim()}>
              Create key
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            This is the only time the key is shown. Store it in a password manager or secret store.
          </div>
          <CopyField value={token} />
          <div>
            <p className="mb-1.5 text-xs text-fg-subtle">Use it with the CLI:</p>
            <CodeBlock code={`export NAV_API_KEY=${token.slice(0, 8)}…\nnav services list`} />
          </div>
        </div>
      ) : (
        <form id="create-key" onSubmit={submit}>
          <Field label="Name" hint="Something to recognise it by, e.g. “CI deploys” or “laptop”.">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="CI deploys" />}
          </Field>
        </form>
      )}
    </Dialog>
  );
}

export function ApiKeysPage() {
  useTitle('API keys');
  const keys = useApiKeys();
  const revoke = useRevokeApiKey();
  const confirm = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="API keys"
        description="Personal tokens for the NAV CLI and REST API. They act with your role in each workspace."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Create API key
          </Button>
        }
      />
      {keys.isPending ? (
        <SkeletonRows rows={3} />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
      ) : keys.data.items.length === 0 ? (
        <Empty
          icon={<KeyRound className="size-4" />}
          title="No API keys"
          description="Create a key to use the nav CLI or automate deploys from CI."
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Create API key
            </Button>
          }
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Key</Th>
              <Th className="hidden sm:table-cell">Last used</Th>
              <Th className="hidden md:table-cell">Created</Th>
              <Th className="w-10" />
            </tr>
          </THead>
          <TBody>
            {keys.data.items.map((k) => (
              <Tr key={k.id}>
                <Td className="font-medium">{k.name}</Td>
                <Td>
                  <code className="font-mono text-xs text-fg-muted">{k.prefix}…</code>
                </Td>
                <Td className="hidden text-fg-muted sm:table-cell">{k.lastUsedAt ? <RelativeTime value={k.lastUsedAt} /> : 'Never'}</Td>
                <Td className="hidden text-fg-muted md:table-cell">
                  <RelativeTime value={k.createdAt} />
                </Td>
                <Td>
                  <IconButton
                    label={`Revoke ${k.name}`}
                    icon={<Trash2 className="size-3.5" />}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Revoke “${k.name}”?`,
                        body: 'Anything using this key stops working immediately. This cannot be undone.',
                        danger: true,
                        confirmText: 'Revoke key',
                      });
                      if (ok) revoke.mutate(k.id, { onSuccess: () => toast.success('API key revoked'), onError: (e) => toast.fromError(e, 'Could not revoke key') });
                    }}
                  />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <CreateKeyDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

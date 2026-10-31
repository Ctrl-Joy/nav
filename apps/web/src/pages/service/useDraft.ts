import { useEffect, useState } from 'react';

/**
 * Local editable copy of server data. Re-syncs from the server only while the draft is clean,
 * so live refetches never clobber in-progress edits.
 */
export function useDraft<T>(server: T | undefined, fallback: T) {
  const [draft, setDraftState] = useState<T>(server ?? fallback);
  const [dirty, setDirty] = useState(false);
  const serialized = JSON.stringify(server ?? null);

  useEffect(() => {
    if (!dirty && server !== undefined) setDraftState(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  const setDraft = (v: T) => {
    setDraftState(v);
    setDirty(JSON.stringify(v) !== serialized);
  };
  const reset = () => {
    setDraftState(server ?? fallback);
    setDirty(false);
  };
  const markSaved = () => setDirty(false);
  return { draft, setDraft, dirty, reset, markSaved };
}

import { useOutletContext } from 'react-router-dom';
import { KEY_VALUE_PLANS } from '@nav/shared';
import type { KeyValue } from '@/api/types';

export interface KeyValueOutletCtx {
  keyValue: KeyValue;
}

export function useKeyValueCtx(): KeyValueOutletCtx {
  return useOutletContext<KeyValueOutletCtx>();
}

export function kvPlanName(id: string): string {
  return KEY_VALUE_PLANS.find((p) => p.id === id)?.name ?? id;
}

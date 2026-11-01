import { useOutletContext } from 'react-router-dom';
import type { Service } from '@nav/shared';

export interface ServiceOutletCtx {
  service: Service;
}

export function useServiceCtx(): ServiceOutletCtx {
  return useOutletContext<ServiceOutletCtx>();
}

export const HAS_URL = (s: Service) => s.type === 'web' || s.type === 'static';

/** Service types with long-running instances you can open a shell in. */
export const SHELL_TYPES: Service['type'][] = ['web', 'private', 'worker'];

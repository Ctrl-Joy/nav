import { useOutletContext } from 'react-router-dom';
import type { Database } from '@nav/shared';

export interface DatabaseOutletCtx {
  database: Database;
}

export function useDatabaseCtx(): DatabaseOutletCtx {
  return useOutletContext<DatabaseOutletCtx>();
}

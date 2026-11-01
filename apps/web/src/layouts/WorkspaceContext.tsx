import { createContext, useContext } from 'react';
import type { Role } from '@nav/shared';
import type { AppConfig, MeUser, OrgInfo, WorkspaceInfo } from '@/api/types';

export interface WorkspaceCtx {
  ws: string;
  workspace: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  /** Organizations the user belongs to. */
  orgs: OrgInfo[];
  user: MeUser;
  role: Role;
  /** developer+ can create/modify resources */
  canWrite: boolean;
  /** admin+ manages members, domains, deletes */
  isAdmin: boolean;
  config: AppConfig | undefined;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside a workspace route');
  return ctx;
}

export function roleCaps(role: Role) {
  return { canWrite: role !== 'viewer', isAdmin: role === 'owner' || role === 'admin' };
}

import type { CommandDef } from '../command.ts';
import { authCommands } from './auth.ts';
import { blueprintCommands } from './blueprint.ts';
import { dbCommands } from './db.ts';
import { deployCommands } from './deploys.ts';
import { domainCommands } from './domains.ts';
import { envCommands } from './env.ts';
import { jobCommands } from './jobs.ts';
import { logCommands } from './logs.ts';
import { metricsCommands } from './metrics.ts';
import { openCommands } from './open.ts';
import { serviceCommands } from './services.ts';
import { workspaceCommands } from './workspaces.ts';

export const commands: CommandDef[] = [
  ...authCommands,
  ...workspaceCommands,
  ...serviceCommands,
  ...deployCommands,
  ...logCommands,
  ...envCommands,
  ...domainCommands,
  ...dbCommands,
  ...jobCommands,
  ...blueprintCommands,
  ...metricsCommands,
  ...openCommands,
];

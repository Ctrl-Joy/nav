// Enumerations mirrored from @nav/shared. Kept as local constants so the CLI has no runtime
// dependency on the shared package (only type imports are used from it).

export const SERVICE_TYPES: readonly string[] = ['web', 'private', 'worker', 'cron', 'static'];
export const RUNTIMES: readonly string[] = ['auto', 'node', 'python', 'go', 'ruby', 'bun', 'docker', 'image', 'static'];
export const LOG_STREAMS: readonly string[] = ['build', 'deploy', 'runtime', 'cron', 'job', 'system'];
export const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];
export const METRIC_RANGES: readonly string[] = ['1h', '6h', '24h', '7d'];

export const DEPLOY_ACTIVE: readonly string[] = [
  'queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress',
];
export const DEPLOY_FAILED: readonly string[] = ['build_failed', 'pre_deploy_failed', 'update_failed'];
export const DEPLOY_SUCCEEDED: readonly string[] = ['live', 'deactivated'];

export const RUN_TERMINAL: readonly string[] = ['succeeded', 'failed', 'canceled'];

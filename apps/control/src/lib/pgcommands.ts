// Pure builders for the commands / container specs NAV uses to run PostgreSQL features: PgBouncer configuration,
// docker containers for primaries, replicas, poolers and upgrades. Kept side-effect free so they can be unit-tested
// on machines without Docker or PgBouncer.
import type { ContainerCreateOptions } from 'dockerode';

/** Where PostgreSQL keeps its data inside NAV's containers (set explicitly: postgres:18 moved the image default). */
export const DOCKER_PGDATA = '/var/lib/postgresql/data';
export const PGBOUNCER_IMAGE = process.env.NAV_PGBOUNCER_IMAGE ?? 'edoburu/pgbouncer:latest';
export const PGBOUNCER_MISSING = 'Connection pooling needs PgBouncer on the database\'s node: install pgbouncer (on PATH) or set NAV_PGBOUNCER to its path, then restart the NAV agent. NAV does not ship its own pooler.';

export interface DbIdent { id: string; slug: string; workspace_id: string; db_name: string; db_user: string; pg_version: number }

/** Quotes a libpq connection-string value. */
export const connValue = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** primary_conninfo for a standby streaming from host:port; application_name identifies it in pg_stat_replication. */
export function standbyConninfo(o: { host: string; port: number; user: string; password: string; applicationName: string }): string {
  return `host=${o.host} port=${o.port} user=${connValue(o.user)} password=${connValue(o.password)} application_name=${o.applicationName}`;
}

/** Replication slot names: lowercase letters, digits and underscores. */
export const slotName = (replicaId: string) => `nav_${replicaId.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 63);

/** Pool size per plan memory: roughly what the server can serve without thrashing. */
export function poolSizeFor(memoryMB: number): number {
  return Math.max(10, Math.min(100, Math.floor(memoryMB / 32)));
}

/** pgbouncer.ini + auth files for transaction pooling in front of one database. */
export function pgbouncerConfig(o: {
  dbName: string; user: string; password: string; serverHost: string; serverPort: number;
  listenAddr: string; listenPort: number; poolSize: number; dir: string; allowList: string[]; isWindows?: boolean;
}): { ini: string; userlist: string; hba: string } {
  const p = (f: string) => (o.isWindows ? `${o.dir}\\${f}` : `${o.dir}/${f}`);
  const ini = [
    '[databases]',
    `${o.dbName} = host=${o.serverHost} port=${o.serverPort} dbname=${o.dbName}`,
    `* = host=${o.serverHost} port=${o.serverPort}`,
    '',
    '[pgbouncer]',
    `listen_addr = ${o.listenAddr}`,
    `listen_port = ${o.listenPort}`,
    "unix_socket_dir =",
    'auth_type = hba',
    `auth_file = ${p('userlist.txt')}`,
    `auth_hba_file = ${p('pgbouncer_hba.conf')}`,
    'pool_mode = transaction',
    'max_client_conn = 1000',
    `default_pool_size = ${o.poolSize}`,
    'reserve_pool_size = 5',
    'server_reset_query = DISCARD ALL',
    'ignore_startup_parameters = extra_float_digits,options,search_path',
    `admin_users = ${o.user}`,
    `stats_users = ${o.user}`,
    `pidfile = ${p('pgbouncer.pid')}`,
    'log_connections = 0',
    'log_disconnections = 0',
    '',
  ].join('\n');
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const userlist = `${q(o.user)} ${q(o.password)}\n`;
  const remote = o.allowList.filter((c) => c && c !== '127.0.0.1/32');
  const hba = [
    'host all all 127.0.0.1/32 scram-sha-256',
    'host all all ::1/128 scram-sha-256',
    ...remote.map((c) => `host all all ${c} scram-sha-256`),
    '',
  ].join('\n');
  return { ini, userlist, hba };
}

/** The primary container (also used to recreate it after an upgrade or rollback). */
export function dockerPostgresContainer(db: DbIdent, o: { password: string; port: number; volume: string; version: number; memoryMB: number; cpu: number; name?: string; bindIp?: string }): ContainerCreateOptions {
  const network = `nav-${db.workspace_id}`;
  return {
    name: o.name ?? `nav-db-${db.id}`,
    Image: `postgres:${o.version}`,
    Env: [`POSTGRES_USER=${db.db_user}`, `POSTGRES_PASSWORD=${o.password}`, `POSTGRES_DB=${db.db_name}`, 'POSTGRES_INITDB_ARGS=--auth=scram-sha-256', `PGDATA=${DOCKER_PGDATA}`],
    Labels: { 'nav.database': db.id },
    HostConfig: {
      NetworkMode: network,
      PortBindings: { '5432/tcp': [{ HostIp: o.bindIp ?? '0.0.0.0', HostPort: String(o.port) }] },
      Mounts: [{ Type: 'volume', Source: o.volume, Target: DOCKER_PGDATA }],
      Memory: o.memoryMB * 1048576,
      NanoCpus: Math.round(o.cpu * 1e9),
      RestartPolicy: { Name: 'unless-stopped' },
      SecurityOpt: ['no-new-privileges:true'],
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: o.name ? [] : [db.slug] } } },
  };
}

/** Shell run (as root, then gosu postgres) by a replica container: clone the primary once, then run as a hot standby. */
export function dockerReplicaScript(o: { primaryHost: string; user: string; slot: string; applicationName: string }): string {
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    'set -e',
    `mkdir -p "$PGDATA" && chown -R postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"`,
    'if [ ! -s "$PGDATA/PG_VERSION" ]; then',
    `  until gosu postgres pg_basebackup -h ${sh(o.primaryHost)} -p 5432 -U ${sh(o.user)} -D "$PGDATA" -X stream -S ${sh(o.slot)} -R -c fast; do echo "waiting for primary"; rm -rf "$PGDATA"/*; sleep 2; done`,
    'fi',
    `exec gosu postgres postgres -c hot_standby=on -c hot_standby_feedback=on -c primary_slot_name=${o.slot} -c ${sh(`cluster_name=${o.applicationName}`)}`,
  ].join('\n');
}

/** A streaming replica (or HA standby) container of a docker primary. */
export function dockerReplicaContainer(db: DbIdent, r: { id: string; slot_name: string }, o: { password: string; port: number; memoryMB: number; cpu: number; bindIp?: string }): ContainerCreateOptions {
  const network = `nav-${db.workspace_id}`;
  return {
    name: `nav-dbr-${r.id}`,
    Image: `postgres:${db.pg_version}`,
    Entrypoint: ['bash', '-c'],
    Cmd: [dockerReplicaScript({ primaryHost: db.slug, user: db.db_user, slot: r.slot_name, applicationName: r.id })],
    Env: [`PGPASSWORD=${o.password}`, `PGDATA=${DOCKER_PGDATA}`],
    Labels: { 'nav.database': db.id, 'nav.replica': r.id },
    HostConfig: {
      NetworkMode: network,
      PortBindings: { '5432/tcp': [{ HostIp: o.bindIp ?? '0.0.0.0', HostPort: String(o.port) }] },
      Mounts: [{ Type: 'volume', Source: `nav-dbr-${r.id}`, Target: DOCKER_PGDATA }],
      Memory: o.memoryMB * 1048576,
      NanoCpus: Math.round(o.cpu * 1e9),
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [`${db.slug}-${r.id}`] } } },
  };
}

/** Run inside the docker primary: allow replication connections from the workspace network. */
export function dockerEnableReplicationCmd(): string[] {
  return ['bash', '-c', `grep -q '^host replication all all' "$PGDATA/pg_hba.conf" || echo 'host replication all all scram-sha-256' >> "$PGDATA/pg_hba.conf"`];
}

/** PgBouncer container in front of a docker database (transaction pooling, scram auth). */
export function dockerPoolerContainer(db: DbIdent, o: { password: string; port: number; poolSize: number; bindIp?: string }): ContainerCreateOptions {
  const network = `nav-${db.workspace_id}`;
  return {
    name: `nav-pgb-${db.id}`,
    Image: PGBOUNCER_IMAGE,
    Env: [
      `DB_HOST=${db.slug}`, 'DB_PORT=5432', `DB_USER=${db.db_user}`, `DB_PASSWORD=${o.password}`, `DB_NAME=${db.db_name}`,
      'POOL_MODE=transaction', 'AUTH_TYPE=scram-sha-256', 'LISTEN_PORT=6432', 'MAX_CLIENT_CONN=1000', `DEFAULT_POOL_SIZE=${o.poolSize}`,
      'IGNORE_STARTUP_PARAMETERS=extra_float_digits,options,search_path',
    ],
    Labels: { 'nav.database': db.id, 'nav.pooler': db.id },
    HostConfig: {
      NetworkMode: network,
      PortBindings: { '6432/tcp': [{ HostIp: o.bindIp ?? '0.0.0.0', HostPort: String(o.port) }] },
      Memory: 64 * 1048576,
      RestartPolicy: { Name: 'unless-stopped' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [`${db.slug}-pooler`] } } },
  };
}

/** Dump (old container) → restore (new container) commands for a docker major version upgrade. */
export function dockerUpgradeCommands(user: string): { dump: string[]; restore: string[] } {
  return {
    dump: ['pg_dumpall', '-U', user],
    restore: ['psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-q'],
  };
}

/** Splits pg_dumpall --globals-only output into executable statements (skips psql meta-commands and comments). */
export function globalsStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of sql.split(/\r?\n/)) {
    if (!cur && (!line.trim() || line.startsWith('--') || line.startsWith('\\'))) continue;
    cur += (cur ? '\n' : '') + line;
    if (line.trimEnd().endsWith(';')) {
      out.push(cur);
      cur = '';
    }
  }
  return out;
}

// Command / container-spec construction for the Postgres features (docker driver, PgBouncer, WAL archiving).
// Docker and PgBouncer are not needed: these are pure builders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveCommand, configLines, confStr, restoreCommand } from '../src/lib/pgcluster.ts';
import {
  dockerEnableReplicationCmd, dockerPoolerContainer, dockerPostgresContainer, dockerReplicaContainer, dockerReplicaScript, dockerUpgradeCommands,
  globalsStatements, pgbouncerConfig, poolSizeFor, slotName, standbyConninfo, DOCKER_PGDATA,
} from '../src/lib/pgcommands.ts';

const db = { id: 'dpg_abc', slug: 'shop-db', workspace_id: 'ws_1', db_name: 'shop', db_user: 'shop_user', pg_version: 16 };

test('WAL archive / restore commands per platform', () => {
  assert.equal(archiveCommand('C:/nav/wal-archive/dpg_abc', 'win32'), 'copy /Y "%p" "C:\\nav\\wal-archive\\dpg_abc\\%f" >NUL');
  assert.equal(archiveCommand('/var/nav/wal/dpg_abc', 'linux'), "test ! -f '/var/nav/wal/dpg_abc/%f' && cp '%p' '/var/nav/wal/dpg_abc/%f'");
  assert.equal(restoreCommand('/var/nav/wal/dpg_abc', 'linux'), "cp '/var/nav/wal/dpg_abc/%f' '%p'");
  assert.match(restoreCommand('C:\\a', 'win32'), /^copy \/Y "C:\\a\\%f" "%p"/);
  // postgresql.conf treats backslash as an escape: it must be doubled, quotes doubled.
  assert.equal(confStr("C:\\x 'y'"), "'C:\\\\x ''y'''");
});

test('cluster config: archiving, preload, standby and recovery settings', () => {
  const base = { dataDir: '/d', port: 5500, superuser: 'u', password: 'p' };
  const plain = configLines(base);
  assert.ok(plain.includes('archive_mode = off'));
  assert.ok(plain.includes('wal_level = replica'));
  const full = configLines({ ...base, archiveDir: '/a', preload: ['pg_stat_statements'], standby: { conninfo: "host=h password='x'", slot: 'nav_r1' }, recovery: { restoreDir: '/a', targetTime: '2026-11-01T10:00:00.000Z' }, maxSlotWalKeepMB: 2048 });
  for (const want of ['archive_mode = on', 'archive_timeout = 60', "shared_preload_libraries = 'pg_stat_statements'", "primary_slot_name = 'nav_r1'", "recovery_target_time = '2026-11-01 10:00:00.000+00'", "recovery_target_action = 'promote'", 'max_slot_wal_keep_size = 2048MB', 'hot_standby_feedback = on']) {
    assert.ok(full.includes(want), `missing ${want}`);
  }
  assert.ok(full.some((l) => l.startsWith('primary_conninfo = ') && l.includes("password=''x''")));
});

test('replication identifiers and conninfo quoting', () => {
  assert.equal(slotName('dbr_AbC-12'), 'nav_dbr_abc_12');
  assert.ok(slotName('x'.repeat(100)).length <= 63);
  assert.equal(standbyConninfo({ host: '127.0.0.1', port: 5432, user: "o'neil", password: 'a\\b', applicationName: 'dbr_1' }), "host=127.0.0.1 port=5432 user='o\\'neil' password='a\\\\b' application_name=dbr_1");
});

test('PgBouncer: transaction pooling config, auth files, allow list', () => {
  const c = pgbouncerConfig({ dbName: 'shop', user: 'shop_user', password: 'p"w', serverHost: '127.0.0.1', serverPort: 5500, listenAddr: '*', listenPort: 6500, poolSize: 20, dir: '/nav/pooler', allowList: ['127.0.0.1/32', '203.0.113.0/24'] });
  assert.match(c.ini, /^pool_mode = transaction$/m);
  assert.match(c.ini, /^shop = host=127\.0\.0\.1 port=5500 dbname=shop$/m);
  assert.match(c.ini, /^listen_port = 6500$/m);
  assert.match(c.ini, /^auth_type = hba$/m);
  assert.match(c.ini, /^auth_file = \/nav\/pooler\/userlist\.txt$/m);
  assert.match(c.ini, /^default_pool_size = 20$/m);
  assert.equal(c.userlist, '"shop_user" "p""w"\n');
  assert.match(c.hba, /host all all 203\.0\.113\.0\/24 scram-sha-256/);
  assert.equal(c.hba.match(/127\.0\.0\.1\/32/g)?.length, 1);
  const win = pgbouncerConfig({ dbName: 'd', user: 'u', password: 'p', serverHost: 'h', serverPort: 1, listenAddr: '*', listenPort: 2, poolSize: 10, dir: 'C:\\nav\\pooler', allowList: [], isWindows: true });
  assert.match(win.ini, /auth_file = C:\\nav\\pooler\\userlist\.txt/);
  assert.equal(poolSizeFor(256), 10);
  assert.equal(poolSizeFor(4096), 100);
});

test('docker: primary, replica, pooler and upgrade specs', () => {
  const p = dockerPostgresContainer(db, { password: 'pw', port: 5501, volume: 'nav-db-dpg_abc-v17', version: 17, memoryMB: 1024, cpu: 0.5 });
  assert.equal(p.name, 'nav-db-dpg_abc');
  assert.equal(p.Image, 'postgres:17');
  assert.ok(p.Env!.includes(`PGDATA=${DOCKER_PGDATA}`));
  assert.deepEqual(p.HostConfig!.Mounts, [{ Type: 'volume', Source: 'nav-db-dpg_abc-v17', Target: DOCKER_PGDATA }]);
  assert.deepEqual(p.NetworkingConfig!.EndpointsConfig!['nav-ws_1'].Aliases, ['shop-db']);
  // Temporary upgrade containers must not steal the alias.
  const tmp = dockerPostgresContainer(db, { password: 'pw', port: 1, volume: 'v', version: 18, memoryMB: 256, cpu: 0.1, name: 'nav-dbu-dpg_abc', bindIp: '127.0.0.1' });
  assert.deepEqual(tmp.NetworkingConfig!.EndpointsConfig!['nav-ws_1'].Aliases, []);
  assert.equal(tmp.HostConfig!.PortBindings!['5432/tcp'][0].HostIp, '127.0.0.1');

  const r = dockerReplicaContainer(db, { id: 'dbr_1', slot_name: 'nav_dbr_1' }, { password: 'pw', port: 5502, memoryMB: 256, cpu: 0.1 });
  assert.equal(r.name, 'nav-dbr-dbr_1');
  assert.equal(r.Image, 'postgres:16');
  assert.deepEqual(r.Entrypoint, ['bash', '-c']);
  assert.ok(r.Env!.includes('PGPASSWORD=pw'));
  assert.deepEqual(r.Labels, { 'nav.database': 'dpg_abc', 'nav.replica': 'dbr_1' });
  const script = r.Cmd![0];
  assert.match(script, /pg_basebackup -h 'shop-db' -p 5432 -U 'shop_user' -D "\$PGDATA" -X stream -S 'nav_dbr_1' -R -c fast/);
  assert.match(script, /exec gosu postgres postgres -c hot_standby=on .* -c primary_slot_name=nav_dbr_1/);
  assert.match(script, /if \[ ! -s "\$PGDATA\/PG_VERSION" \]/);
  assert.match(dockerReplicaScript({ primaryHost: "it's", user: 'u', slot: 's', applicationName: 'a' }), /-h 'it'\\''s'/);
  assert.match(dockerEnableReplicationCmd()[2], /host replication all all scram-sha-256/);

  const pool = dockerPoolerContainer(db, { password: 'pw', port: 6400, poolSize: 25 });
  assert.equal(pool.name, 'nav-pgb-dpg_abc');
  for (const e of ['DB_HOST=shop-db', 'POOL_MODE=transaction', 'AUTH_TYPE=scram-sha-256', 'DEFAULT_POOL_SIZE=25', 'LISTEN_PORT=6432']) assert.ok(pool.Env!.includes(e), e);
  assert.equal(pool.HostConfig!.PortBindings!['6432/tcp'][0].HostPort, '6400');
  assert.deepEqual(pool.NetworkingConfig!.EndpointsConfig!['nav-ws_1'].Aliases, ['shop-db-pooler']);

  const up = dockerUpgradeCommands('shop_user');
  assert.deepEqual(up.dump, ['pg_dumpall', '-U', 'shop_user']);
  assert.deepEqual(up.restore, ['psql', '-U', 'shop_user', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-q']);
});

test('globals from pg_dumpall are split into statements, psql meta-commands skipped', () => {
  const sql = [
    '--', '-- PostgreSQL database cluster dump', '--', '\\restrict abc', '', 'SET default_transaction_read_only = off;',
    'CREATE ROLE app;', "ALTER ROLE app WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:x$y:z';", 'COMMENT ON ROLE app IS', "'multi line';", '\\unrestrict abc',
  ].join('\n');
  assert.deepEqual(globalsStatements(sql), [
    'SET default_transaction_read_only = off;', 'CREATE ROLE app;', "ALTER ROLE app WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:x$y:z';", "COMMENT ON ROLE app IS\n'multi line';",
  ]);
});

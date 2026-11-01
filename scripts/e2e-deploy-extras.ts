// End-to-end checks for the deploy extras that run without GitHub or Docker: the CI-gated auto-deploy setting,
// blueprint inspection for the Deploy to NAV flow, blueprint preview settings and listing, and the new example
// apps deploying from the template repos. Usage: node scripts/e2e-deploy-extras.ts  (against npm run dev + git-serve)

const API = process.env.NAV_API ?? 'http://localhost:4000/api/v1';
const GIT = process.env.NAV_GIT ?? 'http://localhost:9420';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: boolean[] = [];
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

let token = '';
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let data: any = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { status: res.status, data };
}
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); } catch (e) { results.push(false); console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const r = await fetch(`${API}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ email: `extras-${Date.now()}@nav.test`, password: 'correct-horse-battery' }) });
const cookie = r.headers.get('set-cookie')!.split(';')[0];
const ws = (await r.json()).workspaces[0].id;
token = (await fetch(`${API}/api-keys`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ name: 'extras' }) }).then((x) => x.json())).token;
const cleanup: string[] = [];

await step('auto-deploy accepts "after checks pass" and rejects unknown values', async () => {
  const s = await api('POST', `/workspaces/${ws}/services`, { name: `chk-${Date.now().toString(36)}`, type: 'web', repoUrl: `${GIT}/node-web.git`, healthCheckPath: '/healthz', plan: 'starter', autoDeploy: 'checks' });
  assert(s.status === 201, `create ${s.status} ${JSON.stringify(s.data)}`);
  cleanup.push(s.data.service.id);
  assert(s.data.service.autoDeploy === 'checks', `saved: ${s.data.service.autoDeploy}`);
  assert((await api('PATCH', `/services/${s.data.service.id}`, { autoDeploy: 'sometimes' })).status === 400, 'bad value refused');
  assert((await api('PATCH', `/services/${s.data.service.id}`, { autoDeploy: 'commit' })).data.autoDeploy === 'commit', 'switch back');
});

await step('Deploy to NAV: a repo with nav.yaml is inspected and its resources listed', async () => {
  const i = await api('POST', '/blueprints/inspect', { repoUrl: `${GIT}/examples.git` });
  assert(i.status === 200, `inspect ${i.status} ${JSON.stringify(i.data)}`);
  const text = JSON.stringify(i.data);
  assert(/service|database|resources/i.test(text), `inspection lists resources: ${text.slice(0, 200)}`);
  const bad = await api('POST', '/blueprints/inspect', { repoUrl: `${GIT}/does-not-exist.git` });
  assert(bad.status >= 400 && bad.status < 500, `missing repo gives a clear error, got ${bad.status}`);
});

await step('templates: example repos are published and the Node template deploys live (Python and Go need their runtimes on the node)', async () => {
  for (const name of ['python-flask', 'go-api']) {
    const probe = await fetch(`${GIT}/${name}.git/info/refs?service=git-upload-pack`);
    if (probe.status !== 200) throw new Error(`${name} is not published by git-serve`);
  }
  const s = await api('POST', `/workspaces/${ws}/services`, { name: `tpl-node-${Date.now().toString(36)}`, type: 'web', repoUrl: `${GIT}/node-web.git`, healthCheckPath: '/healthz', plan: 'starter' });
  cleanup.push(s.data.service.id);
  let st = '';
  for (let k = 0; k < 90; k++) { st = (await api('GET', `/deploys/${s.data.deploy.id}`)).data.status; if (st === 'live' || /failed/.test(st)) break; await sleep(2000); }
  assert(st === 'live', `node template deploy: ${st}`);
});

await step('blueprint preview settings save and the previews list answers', async () => {
  const bp = await api('POST', `/workspaces/${ws}/blueprints`, { name: `bp-${Date.now().toString(36)}`, repoUrl: `${GIT}/examples.git`, branch: 'main' });
  assert(bp.status === 201 || bp.status === 200, `blueprint ${bp.status} ${JSON.stringify(bp.data).slice(0, 200)}`);
  const id = bp.data.id ?? bp.data.blueprint?.id;
  const p = await api('PATCH', `/blueprints/${id}`, { previews: { generation: 'automatic', expireAfterDays: 3 } });
  assert(p.status === 200, `patch previews ${p.status} ${JSON.stringify(p.data).slice(0, 200)}`);
  const list = await api('GET', `/blueprints/${id}/previews`);
  assert(list.status === 200 && Array.isArray(list.data.items ?? list.data), `previews list ${list.status}`);
  await api('DELETE', `/blueprints/${id}`);
});

for (const id of cleanup) await api('DELETE', `/services/${id}`);
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

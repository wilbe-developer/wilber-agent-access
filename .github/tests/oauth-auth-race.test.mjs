import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {access, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {withCredentialLock} from '../../plugins/wilber-agent-access/bin/scoped-renewal.mjs';

// Independent code review regressions. Only synthetic tokens and an isolated
// local credential store are used by the actual CLI subprocesses.
const cli = path.resolve('plugins/wilber-agent-access/bin/wilber.mjs');
const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function barrier() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('OAuth test operation timed out')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wilber-oauth-review-'));
  const file = path.join(directory, 'credentials.json');
  const children = [], gates = [], failures = [], requests = [];
  let handler;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({path: req.url, authorization: req.headers.authorization, body});
      res.setHeader('Content-Type', 'application/json');
      await handler(req, res, body);
    } catch (error) {
      failures.push(error);
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/wilber/mcp`;
  const make = extra => ({kind: 'oauth', accessToken: 'synthetic_access_A',
    refreshToken: 'synthetic_refresh_A', expiresAt: Date.now() + 3600000,
    clientId: 'shared-client', tokenEndpoint: new URL('/token', endpoint).href, endpoint, ...extra});
  const save = async value => {
    const temporary = `${file}.fixture-tmp`;
    await writeFile(temporary, JSON.stringify(value), {mode: 0o600});
    await rename(temporary, file);
  };
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const start = args => {
    const child = spawn(process.execPath, [cli, ...args], {env: {...process.env,
      WILBER_CONFIG_DIR: directory, WILBER_API_URL: endpoint,
      WILBER_DISABLE_KEYCHAIN: '1', WILBER_ACCESS_TOKEN: ''}, stdio: ['pipe', 'pipe', 'pipe']});
    children.push(child);
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', exit => resolve({exit, out, err}));
    });
    if (args[0] === 'mcp-proxy') child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    else child.stdin.end();
    return {child, done};
  };
  const gate = () => { const value = barrier(); gates.push(value); return value; };
  const ok = (res, raw) => res.end(JSON.stringify({jsonrpc: '2.0', id: JSON.parse(raw).id,
    result: {content: [{type: 'text', text: JSON.stringify({identity: {
      displayName: 'Synthetic A', email: 'a@example.invalid', role: 'team'}})}]}}));
  try {
    await run({directory, file, endpoint, make, save, read, start, gate, requests, ok,
      setHandler: value => { handler = value; }});
    assert.deepEqual(failures, []);
  } finally {
    for (const value of gates) value.resolve();
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null ? null :
      new Promise(resolve => child.once('close', resolve))));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
}

test('legacy OAuth gets one durable session identity without changing tokens', {timeout: 20000}, () => fixture(async f => {
  await f.save(f.make());
  f.setHandler((req, res, raw) => f.ok(res, raw));
  assert.equal((await within(f.start(['whoami', '--json']).done)).exit, 0);
  const first = await f.read();
  assert.match(first.authSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(first.accessToken, 'synthetic_access_A');
  assert.equal((await within(f.start(['whoami', '--json']).done)).exit, 0);
  assert.equal((await f.read()).authSessionId, first.authSessionId);
  assert.equal(f.requests.length, 2);
}));

for (const transport of ['rpc', 'proxy']) {
  for (const mode of ['same-session', 'different-session']) {
    test(`${transport} OAuth 401 handles ${mode} token replacement`, {timeout: 20000}, () => fixture(async f => {
      await f.save(f.make({authSessionId: sessionA}));
      f.setHandler(async (req, res, raw) => {
        if (f.requests.length === 1) {
          await f.save(f.make({authSessionId: mode === 'same-session' ? sessionA : sessionB,
            accessToken: 'synthetic_access_B', refreshToken: 'synthetic_refresh_B'}));
          res.writeHead(401);
          res.end('{}');
        } else f.ok(res, raw);
      });
      const result = await within(f.start(transport === 'rpc' ? ['whoami', '--json'] : ['mcp-proxy']).done);
      assert.equal(f.requests.length, mode === 'same-session' ? 2 : 1);
      if (mode === 'same-session') {
        assert.equal(result.exit, 0, result.err);
        assert.equal(f.requests[1].authorization, 'Bearer synthetic_access_B');
        if (transport === 'proxy') assert.equal(f.requests[0].body, f.requests[1].body);
        else {
          const first = JSON.parse(f.requests[0].body), second = JSON.parse(f.requests[1].body);
          // RPC uses a fresh correlation ID, while operation arguments stay exact.
          delete first.id;
          delete second.id;
          assert.deepEqual(first, second);
        }
      } else assert.match(result.out + result.err, /connection changed/);
      assert.equal((await f.read()).accessToken, 'synthetic_access_B');
    }));
  }
}

test('OAuth refresh completing after successful logout cannot restore the credential', {timeout: 20000}, () => fixture(async f => {
  await f.save(f.make({authSessionId: sessionA, expiresAt: 0}));
  const entered = f.gate(), release = f.gate();
  f.setHandler(async (req, res, raw) => {
    assert.equal(req.url, '/token');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(raw)), {grant_type: 'refresh_token',
      refresh_token: 'synthetic_refresh_A', client_id: 'shared-client'});
    entered.resolve();
    await release.promise;
    res.end(JSON.stringify({access_token: 'synthetic_refreshed_A',
      refresh_token: 'synthetic_new_refresh_A', expires_in: 3600}));
  });
  const refresh = f.start(['whoami', '--json']);
  await within(entered.promise);
  assert.equal((await within(f.start(['auth', 'logout']).done)).exit, 0);
  await assert.rejects(access(f.file));
  release.resolve();
  const result = await within(refresh.done);
  assert.equal(result.exit, 1);
  assert.match(result.err, /connection changed/);
  await assert.rejects(access(f.file));
  assert.equal(f.requests.length, 1);
}));

test('OAuth refresh compare-and-save preserves a replacement session with identical tokens', {timeout: 20000}, () => fixture(async f => {
  await f.save(f.make({authSessionId: sessionA, expiresAt: 0}));
  f.setHandler(async (req, res) => {
    await f.save(f.make({authSessionId: sessionB}));
    res.end(JSON.stringify({access_token: 'synthetic_refreshed_A',
      refresh_token: 'synthetic_new_refresh_A', expires_in: 3600}));
  });
  const result = await within(f.start(['whoami', '--json']).done);
  assert.equal(result.exit, 1);
  assert.match(result.err, /connection changed/);
  const saved = await f.read();
  assert.equal(saved.authSessionId, sessionB);
  assert.equal(saved.accessToken, 'synthetic_access_A');
  assert.equal(f.requests.length, 1);
}));

test('simultaneous first OAuth use shares the backfilled session', {timeout: 20000}, () => fixture(async f => {
  await f.save(f.make());
  f.setHandler((req, res, raw) => f.ok(res, raw));
  const entered = f.gate(), release = f.gate();
  const owner = withCredentialLock(f.directory, async () => { entered.resolve(); await release.promise; });
  await within(entered.promise);
  const first = f.start(['whoami', '--json']), second = f.start(['whoami', '--json']);
  await pause(250);
  release.resolve();
  await within(owner);
  const results = await within(Promise.all([first.done, second.done]));
  assert.deepEqual(results.map(value => value.exit), [0, 0], JSON.stringify(results));
  assert.equal(f.requests.length, 2);
}));

test('queued legacy OAuth backfill rejects a changed account before any request', {timeout: 20000}, () => fixture(async f => {
  await f.save(f.make());
  f.setHandler((req, res, raw) => f.ok(res, raw));
  const entered = f.gate(), release = f.gate();
  const owner = withCredentialLock(f.directory, async () => { entered.resolve(); await release.promise; });
  await within(entered.promise);
  const waiting = f.start(['whoami', '--json']);
  await pause(250);
  const changed = f.make({accessToken: 'synthetic_account_B', refreshToken: 'synthetic_refresh_B'});
  await f.save(changed);
  release.resolve();
  await within(owner);
  const result = await within(waiting.done);
  assert.equal(result.exit, 1);
  assert.match(result.err, /connection changed/);
  assert.deepEqual(await f.read(), changed);
  assert.equal(f.requests.length, 0);
}));

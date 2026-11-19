import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Real CLI processes share only an isolated store and a synthetic loopback API.
const cli = path.resolve('plugins/wilber-agent-access/bin/wilber.mjs');
const oldId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222';
const oldToken = `wb_agent_${'a'.repeat(64)}`;
const founderToken = `wb_agent_${'b'.repeat(64)}`;
const later = ms => new Promise(resolve => setTimeout(resolve, ms));
function barrier() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wilber-auth-race-'));
  const file = path.join(directory, 'credentials.json');
  const children = [];
  const releases = [];
  const failures = [];
  let handler;
  const server = createServer(async (req, res) => {
    try {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      res.setHeader('Content-Type', 'application/json');
      await handler(JSON.parse(bytes), req, res);
    } catch (error) {
      failures.push(error);
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/wilber/mcp`;
  const env = {...process.env, WILBER_CONFIG_DIR: directory, WILBER_API_URL: endpoint,
    WILBER_ACCESS_TOKEN: '', WILBER_DISABLE_KEYCHAIN: '1', WILBER_DISABLE_BROWSER_OPEN: '1',
    WILBER_OAUTH_TIMEOUT_MS: '10000'};
  const read = async () => {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const save = value => writeFile(file, JSON.stringify(value), {mode: 0o600});
  const initial = extra => ({kind: 'scoped', connectionId: oldId, audience: 'captain', endpoint,
    accessToken: oldToken, expiresAt: new Date(Date.now() + 86400000).toISOString(), ...extra});
  const renewable = () => initial({refreshToken: `wb_refresh_${'c'.repeat(64)}`,
    refreshExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString()});
  const start = (args, input) => {
    const child = spawn(process.execPath, [cli, ...args], {env, stdio: ['pipe', 'pipe', 'pipe']});
    children.push(child);
    let stdout = '', stderr = '', finished = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { finished = true; resolve({code, stdout, stderr}); });
    });
    child.stdin.end(input || '');
    return {child, done, get finished() { return finished; }};
  };
  const hold = () => { const gate = barrier(); releases.push(gate.resolve); return gate; };
  const okRenewal = res => res.end(JSON.stringify({connection_id: oldId, audience: 'captain',
    permissions: ['access.get'], expires_at: new Date(Date.now() + 3600000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86400000).toISOString()}));
  const okMcp = (body, req, res) => {
    const founder = req.headers.authorization === `Bearer ${founderToken}`;
    const value = {audience: founder ? 'founder' : 'captain', permissions: ['access.get'],
      identity: {displayName: founder ? 'Synthetic Founder' : 'Synthetic Captain', role: founder ? 'founder' : 'captain'}};
    res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result: {
      content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value}}));
  };
  const login = (body, res) => {
    if (body.action === 'start') {
      assert.equal(body.audience, 'founder');
      res.end(JSON.stringify({request_id: newId, expires_at: new Date(Date.now() + 600000).toISOString()}));
      return true;
    }
    if (body.action === 'exchange') {
      res.end(JSON.stringify({status: 'approved', connection_id: newId, audience: 'founder',
        permissions: ['access.get'], access_token: founderToken,
        expires_at: new Date(Date.now() + 86400000).toISOString()}));
      return true;
    }
    return false;
  };
  try {
    await operation({directory, file, read, save, initial, renewable, start, hold, login,
      okRenewal, okMcp, setHandler: value => { handler = value; }});
    assert.deepEqual(failures, []);
  } finally {
    for (const release of releases) release();
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null ? null :
      new Promise(resolve => child.once('close', resolve))));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
}

for (const mutation of ['logout', 'login']) {
  test(`in-flight renewal finishes before concurrent ${mutation}; the completed auth choice wins`,
    {timeout: 20000}, () => fixture(async f => {
      const entered = barrier(), exchanged = barrier(), release = f.hold();
      let proposedToken;
      f.setHandler(async (body, req, res) => {
        if (body.action === 'renew') {
          proposedToken = body.access_token;
          entered.resolve();
          await release.promise;
          f.okRenewal(res);
          return;
        }
        if (f.login(body, res)) {
          if (body.action === 'exchange') exchanged.resolve();
          return;
        }
        f.okMcp(body, req, res);
      });
      await f.save(f.initial());
      const renewing = f.start(['whoami', '--json']);
      await within(entered.promise, 'renewal request');
      assert.ok((await f.read()).pendingRenewal);
      const auth = f.start(mutation === 'logout' ? ['auth', 'logout'] :
        ['auth', 'login', '--audience', 'founder', '--force']);
      if (mutation === 'login') await within(exchanged.promise, 'founder approval exchange');
      // Before releasing the server response, old code completes this mutation
      // and then resurrects/replaces it. The repaired command must still wait.
      await later(300);
      assert.equal(auth.finished, false, `${mutation} must wait for in-flight renewal`);
      assert.equal((await f.read())?.connectionId, oldId);
      release.resolve();
      const changed = await within(auth.done, 'auth mutation completion');
      assert.equal(changed.code, 0, changed.stderr);
      const renewed = await within(renewing.done, 'renewal completion');
      assert.equal(renewed.code, 0, renewed.stderr);
      const after = await f.read();
      if (mutation === 'logout') assert.equal(after, null, 'completed logout must leave no credential');
      else {
        assert.equal(after.connectionId, newId);
        assert.equal(after.audience, 'founder');
        assert.equal(after.accessToken, founderToken);
        assert.notEqual(after.accessToken, proposedToken);
      }
    }));
}

for (const transport of ['cli', 'mcp-proxy']) {
  for (const change of ['different-account', 'same-connection']) {
    test(`${transport} 401 retry ${change === 'different-account' ? 'rejects a changed account' : 'uses a concurrent same-connection rotation'}`,
      {timeout: 20000}, () => fixture(async f => {
        const entered = barrier(), release = f.hold();
        let calls = 0, renewals = 0, rotatedToken;
        const seen = [];
        f.setHandler(async (body, req, res) => {
          if (f.login(body, res)) return;
          if (body.action === 'renew') {
            renewals++;
            rotatedToken = body.access_token;
            f.okRenewal(res);
            return;
          }
          calls++;
          seen.push(req.headers.authorization);
          if (calls === 1) {
            entered.resolve();
            await release.promise;
            res.statusCode = 401;
            res.end(JSON.stringify({error: 'PRIVATE_RESPONSE_SENTINEL'}));
            return;
          }
          f.okMcp(body, req, res);
        });
        await f.save(f.renewable());
        const request = transport === 'cli' ? f.start(['whoami', '--json']) :
          f.start(['mcp-proxy'], JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: {name: 'wilber_access_get', arguments: {}}}) + '\n');
        await within(entered.promise, 'initial MCP request');
        if (change === 'different-account') {
          const login = await within(f.start(['auth', 'login', '--audience', 'founder', '--force']).done, 'new account login');
          assert.equal(login.code, 0, login.stderr);
          assert.equal((await f.read()).connectionId, newId);
        } else {
          const current = await f.read();
          await f.save({...current, expiresAt: new Date(Date.now() - 1000).toISOString()});
          const concurrent = await within(f.start(['whoami', '--json']).done, 'concurrent rotation');
          assert.equal(concurrent.code, 0, concurrent.stderr);
          assert.equal((await f.read()).accessToken, rotatedToken);
        }
        const callsBeforeRelease = [...seen];
        release.resolve();
        const result = await within(request.done, 'initial request recovery');
        assert.ok(!`${result.stdout}${result.stderr}`.includes('PRIVATE_RESPONSE_SENTINEL'));
        if (change === 'different-account') {
          const output = transport === 'cli' ? result.stderr : result.stdout;
          assert.match(output, /connection changed/i);
          if (transport === 'cli') assert.notEqual(result.code, 0);
          else assert.ok(JSON.parse(result.stdout.trim()).error);
          assert.deepEqual(callsBeforeRelease, [`Bearer ${oldToken}`, `Bearer ${founderToken}`], 'login validates its own new credential before saving');
          assert.deepEqual(seen, callsBeforeRelease, 'never replay the old operation as the new account');
          assert.equal(renewals, 0);
          assert.equal((await f.read()).connectionId, newId);
        } else {
          assert.equal(result.code, 0, result.stderr);
          if (transport === 'mcp-proxy') assert.ok(JSON.parse(result.stdout.trim()).result);
          else assert.equal(JSON.parse(result.stdout).audience, 'captain');
          assert.deepEqual(seen, [`Bearer ${oldToken}`, `Bearer ${rotatedToken}`, `Bearer ${rotatedToken}`]);
          assert.equal(renewals, 1, '401 waiter adopts the completed rotation without rotating again');
          assert.equal((await f.read()).connectionId, oldId);
        }
      }));
  }
}

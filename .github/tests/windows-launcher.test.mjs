import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const marketplace = path.resolve(process.env.WILBER_TEST_MARKETPLACE || 'distribution/wilber-agent-access-marketplace');

function launch(command, args, cwd, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Plugin process timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('packaged Claude launcher works without a shell, including spaces and Unicode', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'wilber Windows test '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const pluginRoot = path.join(temp, 'installed plugin é', 'wilber-agent-access');
  await cp(path.join(marketplace, 'plugins/wilber-agent-access'), pluginRoot, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'));
  // Claude loads the default configuration first, then this explicitly declared file.
  const defaults = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const declared = JSON.parse(await readFile(path.resolve(pluginRoot, manifest.mcpServers), 'utf8'));
  const config = { ...defaults.mcpServers, ...declared.mcpServers }.wilber;
  assert.equal(config.command, 'node');
  assert.deepEqual(config.args, ['${CLAUDE_PLUGIN_ROOT}/bin/wilber.mjs', 'mcp-proxy']);
  const args = config.args.map(value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
  const env = {
    ...process.env,
    WILBER_CONFIG_DIR: path.join(temp, 'private config'),
    WILBER_DISABLE_KEYCHAIN: '1',
    WILBER_DISABLE_BROWSER_OPEN: '1',
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  };
  delete env.WILBER_ACCESS_TOKEN;
  delete env.WILBER_DEBUG;

  await t.test('version command starts using the configured executable and script', async () => {
    const result = await launch(config.command, [args[0], 'version'], temp, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), manifest.version);
    assert.equal(result.stderr, '');
  });

  await t.test('importing the helper with a non-file argument does not start it', async () => {
    const result = await launch(config.command, ['--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(args[0]).href)})`, 'not-a-script'], temp, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  const observed = [];
  const token = 'local-launcher-fixture-only';
  const profile = {
    identity: { userId: 'fixture-captain', displayName: 'Fixture Captain', email: 'captain@example.invalid', role: 'captain' },
    audience: 'captain', permissions: ['captain.contacts.read'], projectIds: [], authority: {},
  };
  const tools = [{ name: 'wilber_access_get', inputSchema: { type: 'object' } },
    { name: 'wilber_captain_contacts_list', inputSchema: { type: 'object' } }];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    observed.push({ message, authorization: req.headers.authorization, version: req.headers['x-wilber-client-version'] });
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Local fixture', version: manifest.version } };
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call' && message.params.name === 'wilber_access_get') result = { content: [{ type: 'text', text: JSON.stringify(profile) }] };
    else if (message.method === 'tools/call' && message.params.name === 'wilber_captain_contacts_list') result = { content: [{ type: 'text', text: JSON.stringify({ contacts: [{ name: 'Fictional Contact' }], has_more: false }) }] };
    else if (message.method.startsWith('notifications/')) { res.writeHead(204); res.end(); return; }
    else { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Wilber-Latest-Client-Version': manifest.version });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  env.WILBER_API_URL = endpoint;

  await t.test('MCP initialize, discovery, identity and contact read use the same credential', async () => {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Launcher fixture', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wilber_access_get', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wilber_captain_contacts_list', arguments: {} } },
    ];
    const result = await launch(config.command, args, temp, { ...env, WILBER_ACCESS_TOKEN: token }, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3, 4]);
    assert.equal(replies[0].result.serverInfo.name, 'Local fixture');
    assert.deepEqual(replies[1].result.tools, tools);
    assert.equal(JSON.parse(replies[2].result.content[0].text).identity.role, 'captain');
    assert.equal(JSON.parse(replies[3].result.content[0].text).contacts[0].name, 'Fictional Contact');
    assert(observed.length >= 4);
    for (const request of observed) {
      assert.equal(request.authorization, `Bearer ${token}`);
      assert.equal(request.version, manifest.version);
    }
    assert(!result.stdout.includes(token));
  });

  await t.test('CLI doctor reaches the same fixture as the configured connector', async () => {
    const result = await launch(config.command, [args[0], 'doctor', '--json'], temp, { ...env, WILBER_ACCESS_TOKEN: token });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.identity.role, 'captain');
    assert.equal(report.availableTools, tools.length);
    assert.equal(report.version, manifest.version);
  });

  await t.test('missing credentials return a clear MCP error without opening a browser', async () => {
    const before = observed.length;
    const result = await launch(config.command, args, temp, env, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }) + '\n');
    assert.equal(result.code, 0, result.stderr);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.id, 5);
    assert.equal(reply.error.code, -32000);
    assert.match(reply.error.message, /not connected|auth login/i);
    assert.equal(observed.length, before);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Script, createContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

// Execute the actual single-file Worker. Its socket import is the only runtime
// substitution; every unmocked network/socket call fails the test.
const filename = new URL('../SRC/CF-DNS-Clone-Vless-Sub.js', import.meta.url);
const source = readFileSync(filename, 'utf8')
  .replace(/^import \{ connect \} from "cloudflare:sockets";\r?\n/, '')
  .replace('export default {', 'const worker = {');

function loadWorker(fetch = async () => { throw new Error('Unexpected network request'); }) {
  const context = createContext({
    URL, Request, Response, Headers, TextEncoder, TextDecoder, crypto: webcrypto,
    atob, btoa, fetch, console: { log() {}, warn() {}, error() {} },
    connect() { throw new Error('Unexpected socket connection'); },
  });
  new Script(source, { filename: filename.pathname }).runInContext(context);
  return new Proxy({}, {
    get: (_, key) => new Script(String(key)).runInContext(context),
  });
}

function localD1(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first(column) {
          const row = statement.get(...values);
          return row ? (column ? row[column] : row) : null;
        },
        async all() { return { results: statement.all(...values) }; },
        async run() { statement.run(...values); return { success: true }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}

// Documentation-only identity and IP ranges; these are not live credentials or
// reachable service endpoints.
const settings = {
  enableWsReverseProxy: true,
  wsReverseProxyUrl: 'https://upstream.example.net',
  useProxyUrlForSni: true,
  nodeTlsHost: 'snippet.customer.example',
  wsReverseProxyUseRandomUuid: false,
  wsReverseProxySpecificUuid: '00000000-0000-4000-8000-000000000001',
  wsReverseProxyPath: '/tunnel?ed=2560&label=a%20b',
};
const request = new Request('https://subscription.example.org/Example');
const domain = {
  target_domain: 'preferred.example.net', notes: '移动优选', is_single_resolve: 1,
  single_resolve_limit: 1, single_resolve_node_names: '["单 IP"]',
  last_synced_records: '[{"type":"A","content":"192.0.2.1"}]',
};

function expectNode(link, address, port = '443', path = settings.wsReverseProxyPath) {
  const node = new URL(link);
  assert.equal(node.protocol, 'vless:');
  assert.equal(node.hostname, address);
  assert.equal(node.port, port);
  assert.equal(node.searchParams.get('sni'), settings.nodeTlsHost);
  assert.equal(node.searchParams.get('host'), settings.nodeTlsHost);
  assert.equal(node.searchParams.get('path'), path);
  assert.equal(node.username, settings.wsReverseProxySpecificUuid);
  return node;
}

test('cloned domains and single-IP domains retain the SaaS TLS hostname', () => {
  const nodes = loadWorker().generateInternalNodes([domain], settings, request);
  assert.equal(nodes.length, 2);
  expectNode(nodes[0], 'preferred.example.net');
  expectNode(nodes[1], 'preferred.1.example.net');
});

test('custom preferred addresses support IPv4, IPv6, ports, remarks and path overrides', () => {
  const nodes = loadWorker().parseCustomNodes([
    '192.0.2.1#默认端口',
    '[2001:db8::1]:8443#IPv6@/custom?x=1&y=two@home',
    '2001:db8::2#裸 IPv6',
    'preferred.example.net:2053#域名',
  ].join('\n'), settings, request);
  assert.equal(nodes.length, 4);
  expectNode(nodes[0], '192.0.2.1');
  const node = expectNode(nodes[1], '[2001:db8::1]', '8443', '/custom?x=1&y=two@home');
  assert.equal(decodeURIComponent(node.hash.slice(1)), 'IPv6');
  expectNode(nodes[2], '[2001:db8::2]');
  expectNode(nodes[3], 'preferred.example.net', '2053');
});

test('invalid input and comment lines do not become subscription nodes', () => {
  const nodes = loadWorker().parseCustomNodes([
    '# comment', '// comment', 'https://wrong.example.net/path',
    '192.0.2.1:0', '192.0.2.1:65536', '192.0.2.1:abc',
    '999.1.1.1:443', '[2001:db8::oops]:443',
    'user:pass@private.example', 'bad host:443',
    'preferred.example.net:443?security=none',
    '192.0.2.1:443#valid',
  ].join('\n'), settings, request);
  assert.equal(nodes.length, 1);
  expectNode(nodes[0], '192.0.2.1');
});

test('GitHub IP source nodes support IPv6 and preserve custom names and ports', async () => {
  const calls = [];
  const worker = loadWorker(async (url, options) => {
    calls.push({ url, options });
    return new Response('#comment\n192.0.2.1\ninvalid:0\n2001:db8::1\n[2001:db8::2]:8443#source-name');
  });
  const nodes = await worker.generateIpSourceNodes(
    [{ github_path: 'preferred.txt', node_names: '电信\n移动' }],
    { token: 'test-only-placeholder', owner: 'example', repo: 'example' }, settings, request,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, undefined);
  assert.equal(nodes.length, 3);
  const node = expectNode(nodes[0], '192.0.2.1');
  assert.equal(decodeURIComponent(node.hash.slice(1)), '电信');
  expectNode(nodes[1], '[2001:db8::1]');
  expectNode(nodes[2], '[2001:db8::2]', '8443');
});

test('external source normalization preserves IPv6 endpoints through node generation', () => {
  const worker = loadWorker();
  const normalized = worker.processSubscriptionContent([
    '[2001:db8::1]:8443#HK',
    'vless://00000000-0000-4000-8000-000000000001@[2001:db8::2]:2053?type=ws#JP',
    'preferred.example.net:443#US',
  ]);
  const nodes = worker.parseExternalNodes(normalized, settings, request);
  assert.equal(nodes.length, 3);
  expectNode(nodes[0], '[2001:db8::1]', '8443');
  expectNode(nodes[1], '[2001:db8::2]', '2053');
  expectNode(nodes[2], 'preferred.example.net');
});

test('malformed external share links are skipped and @ in external remarks is not a path', () => {
  const worker = loadWorker();
  const normalized = worker.processSubscriptionContent([
    `vmess://${btoa(JSON.stringify({ port: 443, ps: 'invalid' }))}`,
    'vless://malformed@[bad-ipv6]:443',
    '192.0.2.1:443#123@example.net',
  ]);
  const nodes = worker.parseExternalNodes(normalized, settings, request);
  assert.equal(nodes.length, 1);
  const node = expectNode(nodes[0], '192.0.2.1');
  assert.equal(decodeURIComponent(node.hash.slice(1)), '123@example.net');
});

test('legacy settings use the upstream hostname, then the subscription request hostname', () => {
  const worker = loadWorker();
  const legacy = { ...settings, nodeTlsHost: '' };
  const node = new URL(worker.parseCustomNodes('192.0.2.1:443#legacy', legacy, request)[0]);
  assert.equal(node.searchParams.get('sni'), 'upstream.example.net');
  const noUpstream = new URL(worker.generateInternalNodes([domain], { ...legacy, wsReverseProxyUrl: '' }, request)[0]);
  assert.equal(noUpstream.searchParams.get('sni'), 'subscription.example.org');
});

test('settings validation rejects URL/IP/port/injection as a TLS hostname before writes', async t => {
  const worker = loadWorker();
  const db = localD1(t);
  for (const value of ['https://customer.example', 'customer.example:443', '192.0.2.1', '[2001:db8::1]', 'bad_host.example', 'customer.example/path', 'customer.example&x=1', 'customer.example\nother', 42, {}, []]) {
    const response = await worker.apiSetSettings(new Request('https://local.example/api/settings', {
      method: 'POST', body: JSON.stringify({ proxySettings: { nodeTlsHost: value } }),
    }), { WUYA: db });
    assert.equal(response.status, 400, `invalid hostname type: ${typeof value}`);
  }
});

test('settings save and reload normalize the explicit hostname in D1', async t => {
  const worker = loadWorker();
  const db = localD1(t);
  await worker.initializeAndMigrateDatabase({ WUYA: db });
  const response = await worker.apiSetSettings(new Request('https://local.example/api/settings', {
    method: 'POST', body: JSON.stringify({ proxySettings: { ...settings, nodeTlsHost: ' Snippet.Customer.Example. ' } }),
  }), { WUYA: db });
  assert.equal(response.status, 200);
  const saved = await worker.getProxySettings(db);
  assert.equal(saved.nodeTlsHost, 'snippet.customer.example');
  assert.equal(saved.wsReverseProxyUrl, settings.wsReverseProxyUrl);
});

test('Worker fetch returns a base64 subscription from local D1 without network writes', async t => {
  const worker = loadWorker();
  const db = localD1(t);
  await worker.initializeAndMigrateDatabase({ WUYA: db });
  await worker.setSetting(db, 'PROXY_SETTINGS', JSON.stringify(settings));
  await db.prepare('INSERT INTO domains (source_domain, target_domain, zone_id, notes) VALUES (?, ?, ?, ?)')
    .bind('source.example.net', 'preferred.example.net', 'local-only', '测试').run();
  const response = await worker.worker.fetch(request, { WUYA: db }, {});
  assert.equal(response.status, 200);
  const links = atob(await response.text()).split('\n');
  assert.equal(links.length, 1);
  const node = expectNode(links[0], 'preferred.example.net');
  assert.equal(decodeURIComponent(node.hash.slice(1)), '1 ~ 测试');
});

test('an explicit SaaS TLS hostname leaves the Worker WebSocket upstream independent', async t => {
  const calls = [];
  const worker = loadWorker(async forwarded => {
    calls.push(forwarded);
    return new Response('mock WebSocket upstream');
  });
  const db = localD1(t);
  await worker.initializeAndMigrateDatabase({ WUYA: db });
  await worker.setSetting(db, 'PROXY_SETTINGS', JSON.stringify(settings));
  const response = await worker.worker.fetch(new Request('https://subscription.example.org/tunnel?ed=2560', {
    headers: { Upgrade: 'websocket' },
  }), { WUYA: db }, {});
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://upstream.example.net/tunnel?ed=2560');
  assert.equal(calls[0].method, 'GET');
});

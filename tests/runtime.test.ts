import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { VaultIndexer, parseMarkdown } from '../src/gbrain/indexer.js';
import { safeRelative } from '../src/gbrain/path.js';
import { AtlasHarness, parseVerdict } from '../src/core/harness.js';
import { Telemetry } from '../src/core/events.js';
import { OpenAICompatibleProvider } from '../src/core/provider.js';
import { startServer } from '../src/telemetry/server.js';
import { parseMention } from '../src/openbot/gateway.js';
import { verifyWebhook } from '../src/openbot/adapters.js';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Completion, ModelProvider, AtlasEvent } from '../src/contracts.js';

async function fixture(): Promise<{ directory: string; indexer: VaultIndexer; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'atlas-runtime-'));
  for (const folder of ['agents/atlashub', 'souls', 'projects', 'packs/crm-sales-os/leads']) await mkdir(path.join(directory, folder), { recursive: true });
  for (const slug of ['atlas-ai-native-architect', 'atlas-reality-auditor']) {
    await writeFile(path.join(directory, `agents/atlashub/${slug}.md`), `---\nname: ${slug}\ndescription: Atlas specialist\ncolor: blue\n---\n# ${slug}\nArchitecture workflow`);
    await writeFile(path.join(directory, `souls/${slug}.soul.md`), '# Soul\nRequire evidence and honesty.');
  }
  await writeFile(path.join(directory, 'projects/genesis.md'), '---\ntitle: Genesis\ntags: [atlas, atlas]\naliases: [Origin]\n---\n# Genesis\n[[atlas-ai-native-architect|Architect]] [[Origin#Heading]] [[missing]]\n#project\n```\n[[ignored-code]]\n```');
  await writeFile(path.join(directory, 'packs/crm-sales-os/leads/example.md'), '---\nname: Example\nstatus: new\nvalue: 490\nowner_agent: atlas-ai-native-architect\nnext_action: Review evidence\n---\n[[genesis]] [[atlas-ai-native-architect]]');
  const indexer = new VaultIndexer(directory); await indexer.initialize();
  return { directory, indexer, async cleanup() { await indexer.close(); await rm(directory, { recursive: true, force: true }); } };
}
class QueueProvider implements ModelProvider {
  readonly messages: unknown[] = [];
  constructor(private readonly queue: Completion[]) {}
  async complete(messages: unknown): Promise<Completion> { this.messages.push(structuredClone(messages)); const result = this.queue.shift(); assert.ok(result, 'Unexpected model call'); return result; }
}
const response = (content: string): Completion => ({ content, toolCalls: [] });

test('Graph resolves aliases, named links, heading links, and deduplicates tags', async () => {
  const f = await fixture();
  try {
    const graph = f.indexer.getGraph();
    assert.equal(graph.version, 1);
    assert.ok(graph.links.some(link => link.source === 'projects/genesis' && link.target === 'agents/atlashub/atlas-ai-native-architect'));
    assert.ok(graph.links.some(link => link.source === 'projects/genesis' && link.target === 'projects/genesis'));
    assert.deepEqual(graph.unresolved, [{ source: 'projects/genesis', target: 'missing' }]);
    assert.deepEqual(graph.nodes.find(node => node.id === 'projects/genesis')?.tags, ['atlas', 'project']);
    const hit = f.indexer.search('Architecture')[0]; assert.ok(hit?.id.startsWith('agents/'));
    graph.nodes.length = 0; assert.ok(f.indexer.getGraph().nodes.length > 0, 'Graph callers cannot mutate index');
  } finally { await f.cleanup(); }
});
test('Ambiguous basenames remain unresolved and malformed YAML is surfaced', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.directory, 'memory'));
    await writeFile(path.join(f.directory, 'memory/genesis.md'), '# Other Genesis');
    await writeFile(path.join(f.directory, 'memory/bad.md'), '---\nname: never closes\n');
    await f.indexer.scan();
    assert.ok(f.indexer.getGraph().unresolved.some(item => item.source.endsWith('/example') && item.target === 'genesis'));
    assert.ok(f.indexer.warnings.some(item => item.includes('Unclosed YAML')));
    assert.throws(() => parseMarkdown('---\na: [\n---\n'));
  } finally { await f.cleanup(); }
});
test('Vault rejects traversal, ADS, hidden paths and symbolic reads', async () => {
  const f = await fixture();
  try {
    for (const value of ['../secret.md', '/tmp/test.md', 'C:/temp/test.md', 'memory/a.md:stream', 'memory\\a.md', '.env', 'a//b.md']) assert.throws(() => safeRelative(value));
    await assert.rejects(() => f.indexer.read('../secret.md'));
    await assert.rejects(() => f.indexer.writeMemory('../escape', 'text'));
    await assert.rejects(() => f.indexer.writeMemory('safe', 'text', ['../escape|bad']));
    try { await symlink(path.join(f.directory, 'projects/genesis.md'), path.join(f.directory, 'projects/link.md')); await assert.rejects(() => f.indexer.read('projects/link.md'), /symlink/i); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
    const note = await f.indexer.writeMemory('tested', 'Evidence verified.', ['atlas-ai-native-architect']);
    assert.match(await readFile(path.join(f.directory, note), 'utf8'), /\[\[atlas-ai-native-architect\]\]/);
    assert.equal(f.indexer.getGraph().nodes.find(node => node.path === note)?.kind, 'memory');
  } finally { await f.cleanup(); }
});
test('Real semantic search uses supplied vectors and rejects malformed dimensions', async () => {
  const f = await fixture();
  try {
    const count = f.indexer.getGraph().nodes.length;
    const hits = await f.indexer.semanticSearch('architecture', { async embed() { return [[1, 0], ...Array.from({ length: count }, (_, i) => i === 1 ? [1, 0] : [0, 1])]; } });
    assert.equal(hits[0]?.score, 1);
    await assert.rejects(() => f.indexer.semanticSearch('test', { async embed() { return [[1, 0]]; } }), /count mismatch/);
  } finally { await f.cleanup(); }
});
test('Builder cannot close without separate auditor; rejection revises candidate', async () => {
  const f = await fixture(), telemetry = new Telemetry(), events: AtlasEvent[] = [];
  telemetry.on('event', event => events.push(event));
  const provider = new QueueProvider([response('Candidate one'), response('{"approved":false,"feedback":"Missing artifact"}'), response('Candidate with artifact'), response('{"approved":true,"feedback":"Meets response criteria"}')]);
  try {
    const harness = new AtlasHarness(provider, f.indexer, telemetry);
    const result = await harness.run('atlas-ai-native-architect', 'Write architecture');
    assert.equal(result.attempts, 2);
    assert.deepEqual(events.map(event => event.type), ['agent:start', 'agent:critic_review', 'agent:critic_review', 'agent:done']);
    assert.equal(events[1]?.data.approved, false);
    assert.equal(result.output, 'Candidate with artifact');
    assert.ok(events.every(event => event.version === 1 && event.runId === result.runId));
    await assert.rejects(() => harness.run('atlas-reality-auditor', 'Review yourself'), /own builder work/);
  } finally { await f.cleanup(); }
});
test('Auditor invalid verdict or exhaustive rejection never emits done', async () => {
  const f = await fixture();
  try {
    for (const verdict of ['APPROVED', '{"approved":"true","feedback":"bad"}', '{"approved":false,"feedback":"Missing"}']) {
      const telemetry = new Telemetry(), events: AtlasEvent[] = []; telemetry.on('event', event => events.push(event));
      const harness = new AtlasHarness(new QueueProvider([response('Draft'), response(verdict)]), f.indexer, telemetry, { maxAttempts: 1 });
      await assert.rejects(() => harness.run('atlas-ai-native-architect', 'Do work'));
      assert.ok(events.some(event => event.type === 'agent:error')); assert.ok(!events.some(event => event.type === 'agent:done'));
    }
    assert.throws(() => parseVerdict('{"approved":1,"feedback":"bad"}'));
  } finally { await f.cleanup(); }
});
test('Tool evidence is sent to auditor and tool traversal is rejected', async () => {
  const f = await fixture();
  try {
    const provider = new QueueProvider([
      { content: '', toolCalls: [{ id: 'read-1', name: 'vault_read', arguments: '{"path":"../secret.md"}' }] },
      response('I cannot read outside the Vault.'), response('{"approved":true,"feedback":"Accurate boundary"}')
    ]);
    const result = await new AtlasHarness(provider, f.indexer, new Telemetry()).run('atlas-ai-native-architect', 'Read secret');
    assert.equal(result.verdict.approved, true);
    assert.match(JSON.stringify(provider.messages[2]), /Invalid Vault relative path/);
    assert.match(JSON.stringify(provider.messages[2]), /evidence/);
  } finally { await f.cleanup(); }
});
test('Unconfigured remote provider fails explicitly and adapters enforce syntax', async () => {
  await assert.rejects(() => new OpenAICompatibleProvider({ model: 'test' }).complete([], {}), /ATLAS_API_KEY/);
  assert.throws(() => new OpenAICompatibleProvider({ baseUrl: 'http://remote.example/v1' }), /HTTPS/);
  assert.deepEqual(parseMention('@atlas-ai-native-architect Explain'), { agentSlug: 'atlas-ai-native-architect', task: 'Explain' });
  assert.throws(() => parseMention('@bad_slug test'));
  const data = Buffer.from('test'), secret = 'configured-secret';
  assert.equal(verifyWebhook(data, `sha256=${createHmac('sha256', secret).update(data).digest('hex')}`, secret), true);
  assert.equal(verifyWebhook(data, `sha256=${'0'.repeat(64)}`, secret), false);
});
test('HTTP/WS authenticates private Vault, rejects untrusted origins/hosts and streams envelopes', async () => {
  const f = await fixture(), telemetry = new Telemetry();
  const token = 'test-token-with-at-least-24-characters';
  const harness = new AtlasHarness(new QueueProvider([]), f.indexer, telemetry);
  const server = await startServer({ token, port: 0, harness, indexer: f.indexer, telemetry });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assert.equal((await fetch(`${base}/api/graph`)).status, 401);
    assert.equal((await fetch(`${base}/api/graph`, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status, 403);
    const graphResponse = await fetch(`${base}/api/graph`, { headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:1420' } });
    assert.equal(graphResponse.status, 200); assert.equal((await graphResponse.json() as { version: number }).version, 1);
    assert.equal(graphResponse.headers.get('access-control-allow-origin'), 'http://localhost:1420');
    assert.equal((await fetch(`${base}/api/search?q=hello&mode=semantic`, { headers: { authorization: `Bearer ${token}` } })).status, 503);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ['atlas-v1', `atlas-token.${token}`], { origin: 'http://localhost:1420' });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const message = new Promise<AtlasEvent>((resolve, reject) => { socket.once('message', data => resolve(JSON.parse(String(data)) as AtlasEvent)); socket.once('error', reject); });
    telemetry.publish('agent:start', randomUUID(), 'atlas-ai-native-architect', {});
    assert.equal((await message).type, 'agent:start'); socket.terminate();
    const memory = await fetch(`${base}/api/memory`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ topic: '../escape', content: 'blocked' }) });
    assert.equal(memory.status, 400);
    const leads = await fetch(`${base}/api/leads`, { headers: { authorization: `Bearer ${token}` } }); assert.equal((await leads.json() as unknown[]).length, 1);
  } finally { await server.close(); await f.cleanup(); }
});

test('Malformed frontmatter and file limits expose authenticated partial-index diagnostics', async () => {
  const f = await fixture();
  const token = 'diagnostics-test-token-24-characters', telemetry = new Telemetry();
  const harness = new AtlasHarness(new QueueProvider([]), f.indexer, telemetry);
  await writeFile(path.join(f.directory, 'projects/broken.md'), '---\ninvalid: [\n---\n');
  await f.indexer.scan();
  const server = await startServer({ token, port: 0, harness, indexer: f.indexer, telemetry });
  try {
    const open = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as Record<string, unknown>;
    assert.equal(open.indexComplete, false); assert.equal(open.ready, false); assert.equal(open.warnings, undefined);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/health`)).status, 401);
    const diagnostics = await (await fetch(`http://127.0.0.1:${server.port}/api/health`, { headers: { authorization: `Bearer ${token}` } })).json() as { ready: boolean; indexComplete: boolean; warnings: string[] };
    assert.equal(diagnostics.ready, false); assert.equal(diagnostics.indexComplete, false);
    assert.ok(diagnostics.warnings.some(warning => warning.includes('projects/broken.md')));
    assert.ok(f.indexer.getGraph().nodes.length > 0, 'Usable graph subset remains available');
    const bounded = new VaultIndexer(f.directory, 1); await bounded.initialize();
    assert.equal(bounded.getGraph().nodes.length, 1); assert.ok(bounded.warnings.some(warning => warning.includes('limit')));
    await bounded.close();
  } finally { await server.close(); await f.cleanup(); }
});

test('Concurrent streamed request bodies cannot bypass the active-run limit', async () => {
  const f = await fixture();
  let unblock!: () => void;
  const block = new Promise<void>(resolve => { unblock = resolve; });
  let started!: () => void;
  const builderStarted = new Promise<void>(resolve => { started = resolve; });
  let modelCalls = 0;
  const provider: ModelProvider = { async complete() {
    modelCalls++;
    if (modelCalls === 1) { started(); await block; return response('Reviewed result'); }
    return response('{"approved":true,"feedback":"Meets task"}');
  } };
  const telemetry = new Telemetry(), token = 'concurrency-test-token-24-characters';
  const harness = new AtlasHarness(provider, f.indexer, telemetry);
  const server = await startServer({ harness, indexer: f.indexer, telemetry, token, port: 0, maxConcurrentRuns: 1 });
  const begin = () => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.port, path: '/api/run', method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', expect: '100-continue', 'transfer-encoding': 'chunked'
    } });
    const ready = new Promise<void>((resolve, reject) => { req.once('continue', resolve); req.once('error', reject); });
    const result = new Promise<number>((resolve, reject) => { req.once('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); }); req.once('error', reject); });
    void result.catch(() => undefined);
    req.flushHeaders();
    return { req, ready, result };
  };
  const first = begin(), second = begin();
  // Both headers reach handlers before either body finishes. 100-continue is
  // the transport handshake, so this regression needs no timing sleeps.
  try {
    await Promise.all([first.ready, second.ready]);
    first.req.write('{"agentSlug":"atlas-ai-native-architect","task":');
    second.req.write('{"agentSlug":"atlas-ai-native-architect","task":');
    first.req.end('"first"}');
    await builderStarted;
    second.req.end('"second"}');
    assert.equal(await second.result, 429);
    assert.equal(modelCalls, 1, 'Second builder never starts while the first owns the capacity slot');
    unblock();
    assert.equal(await first.result, 200);
    assert.equal(modelCalls, 2, 'Only first builder and its auditor execute');
  } finally {
    unblock(); first.req.destroy(); second.req.destroy();
    await Promise.allSettled([first.ready, second.ready, first.result, second.result]);
    await server.close(); await f.cleanup();
  }
});

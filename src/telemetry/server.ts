import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AtlasHarness } from '../core/harness.js';
import type { Telemetry } from '../core/events.js';
import type { AtlasEvent } from '../contracts.js';
import type { EmbeddingProvider, VaultIndexer } from '../gbrain/indexer.js';

export const DEFAULT_ORIGINS = ['http://localhost:1420', 'http://127.0.0.1:1420', 'http://localhost:1430', 'http://127.0.0.1:1430', 'http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
export interface ServerOptions { token: string; port?: number; allowedOrigins?: string[]; harness: AtlasHarness; indexer: VaultIndexer; telemetry: Telemetry; embeddings?: EmbeddingProvider; maxConcurrentRuns?: number }
function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(res: ServerResponse, status: number, payload: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(payload)); }
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON content-type required');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const buffer = Buffer.from(chunk); length += buffer.length; if (length > 128 * 1024) throw new Error('Request body too large'); chunks.push(buffer); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object');
  return value as Record<string, unknown>;
}
export async function startServer(options: ServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  if (options.token.length < 24 || !/^[A-Za-z0-9_-]+$/.test(options.token)) throw new Error('ATLAS_TOKEN must be 24+ URL-safe characters');
  const origins = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
  let port = options.port ?? 18790;
  const controllers = new Set<AbortController>();
  let activeRuns = 0;
  const validHost = (req: IncomingMessage) => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  const validOrigin = (req: IncomingMessage) => !req.headers.origin || origins.has(req.headers.origin);
  const authenticated = (req: IncomingMessage) => sameSecret(req.headers.authorization?.replace(/^Bearer /, '') ?? '', options.token);
  const server = createServer(async (req, res) => {
    try {
      if (!validHost(req)) { json(res, 403, { error: 'Host rejected' }); return; }
      if (!validOrigin(req)) { json(res, 403, { error: 'Origin rejected' }); return; }
      if (req.headers.origin) { res.setHeader('access-control-allow-origin', req.headers.origin); res.setHeader('vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type' }); res.end(); return; }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { name: 'Atlas-Agent', version: 1, ready: options.indexer.warnings.length === 0, indexComplete: options.indexer.warnings.length === 0, authenticated: authenticated(req), searchMode: options.embeddings ? 'lexical+semantic' : 'lexical' }); return; }
      if (!authenticated(req)) { json(res, 401, { error: 'Bearer token required' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { name: 'Atlas-Agent', version: 1, ready: options.indexer.warnings.length === 0, indexComplete: options.indexer.warnings.length === 0, warnings: [...options.indexer.warnings], nodes: options.indexer.getGraph().nodes.length }); return; }
      if (req.method === 'GET' && url.pathname === '/api/graph') { json(res, 200, options.indexer.getGraph()); return; }
      if (req.method === 'GET' && url.pathname === '/api/leads') { json(res, 200, options.indexer.getGraph().nodes.filter(node => node.kind === 'lead')); return; }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const query = url.searchParams.get('q') ?? '';
        if (query.length > 2000) { json(res, 400, { error: 'Query too long' }); return; }
        if (url.searchParams.get('mode') === 'semantic') {
          if (!options.embeddings) { json(res, 503, { error: 'Semantic embedding provider is not configured' }); return; }
          json(res, 200, { mode: 'semantic', hits: await options.indexer.semanticSearch(query, options.embeddings) });
        } else json(res, 200, { mode: 'lexical', hits: options.indexer.search(query) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        if (activeRuns >= (options.maxConcurrentRuns ?? 2)) { json(res, 429, { error: 'Runtime capacity reached' }); return; }
        const input = await body(req);
        if (typeof input.agentSlug !== 'string' || typeof input.task !== 'string') { json(res, 400, { error: 'agentSlug and task are required' }); return; }
        // Several streamed bodies may have passed the early capacity check while
        // awaiting their final chunk. Recheck and reserve without an await gap.
        if (activeRuns >= (options.maxConcurrentRuns ?? 2)) { json(res, 429, { error: 'Runtime capacity reached' }); return; }
        const controller = new AbortController(); controllers.add(controller); activeRuns++;
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try { json(res, 200, await options.harness.run(input.agentSlug, input.task, controller.signal)); }
        finally { controllers.delete(controller); activeRuns--; }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/memory') {
        const input = await body(req);
        if (typeof input.topic !== 'string' || typeof input.content !== 'string' || (input.links !== undefined && (!Array.isArray(input.links) || input.links.some(value => typeof value !== 'string')))) { json(res, 400, { error: 'topic/content and optional string[] links required' }); return; }
        const relative = await options.indexer.writeMemory(input.topic, input.content, input.links as string[] | undefined);
        options.telemetry.publish('graph:updated', randomUUID(), 'atlas-gbrain-curator', { nodes: options.indexer.getGraph().nodes.length });
        json(res, 201, { path: relative }); return;
      }
      json(res, 404, { error: 'Route not found' });
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : 'Request failed' });
      else res.end();
    }
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 4096, handleProtocols: protocols => protocols.has('atlas-v1') ? 'atlas-v1' : false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
    const token = protocols.find(value => value.startsWith('atlas-token.'))?.slice('atlas-token.'.length) ?? '';
    if (url.pathname !== '/ws' || !validHost(req) || !validOrigin(req) || !sameSecret(token, options.token) || !protocols.includes('atlas-v1')) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client, req));
  });
  const onEvent = (event: AtlasEvent) => {
    const message = JSON.stringify(event);
    for (const client of ws.clients) if (client.readyState === WebSocket.OPEN) { if (client.bufferedAmount > 1024 * 1024) client.close(1013, 'Slow consumer'); else client.send(message); }
  };
  options.telemetry.on('event', onEvent);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { const address = server.address(); if (typeof address === 'object' && address) port = address.port; resolve(); }); });
  return { port, async close() {
    options.telemetry.off('event', onEvent);
    for (const controller of controllers) controller.abort();
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readdir, lstat, copyFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { VaultIndexer } from './gbrain/indexer.js';
import { OpenAIEmbeddings } from './gbrain/embeddings.js';
import { AtlasHarness } from './core/harness.js';
import { OpenAICompatibleProvider } from './core/provider.js';
import { Telemetry } from './core/events.js';
import { OpenBotGateway } from './openbot/gateway.js';
import { BraveWebSearch } from './openbot/search.js';
import { startServer, DEFAULT_ORIGINS } from './telemetry/server.js';

async function initializeVault(source: string, destination: string): Promise<{ copied: number; preserved: number }> {
  const canonical = await realpath(source);
  await mkdir(destination, { recursive: true });
  const target = await realpath(destination);
  if (target === canonical || path.relative(canonical, target).split(path.sep)[0] !== '..') throw new Error('Starter destination must be outside the starter source');
  let copied = 0, preserved = 0;
  const visit = async (directory: string, relative = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Starter may not contain symlinks');
      const next = path.join(relative, entry.name), out = path.join(target, next);
      try { if ((await lstat(out)).isSymbolicLink()) throw new Error('Destination contains a symlink'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (entry.isDirectory()) { await mkdir(out, { recursive: true }); await visit(path.join(directory, entry.name), next); }
      else if (entry.isFile()) {
        try { await copyFile(path.join(directory, entry.name), out, constants.COPYFILE_EXCL); copied++; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') preserved++; else throw error; }
      }
    }
  };
  await visit(canonical);
  return { copied, preserved };
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { vault: { type: 'string' }, from: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0] ?? 'help';
  const vault = path.resolve(values.vault ?? process.env.ATLAS_VAULT_PATH ?? process.env.ATLAS_VAULT ?? path.join(homedir(), '.atlas', 'vault'));
  if (values.help || command === 'help') {
    console.log('Atlas · atlas-si.com\n\natlas init --from ../atlas-workforce/vault-starter [--vault path]\natlas graph [--vault path]\natlas search words [--vault path]\natlas chat [--vault path]\natlas run "@atlas-ai-native-architect task" [--vault path]\natlas daemon [--vault path] [--port 18790]\n\nRemote models require ATLAS_API_KEY + ATLAS_MODEL. A Soul and specialty must exist in the Vault.'); return;
  }
  if (command === 'init') {
    if (!values.from) throw new Error('atlas init requires --from pointing to atlas-workforce/vault-starter');
    console.log(JSON.stringify({ vault, ...await initializeVault(path.resolve(values.from), vault) })); return;
  }
  const indexer = new VaultIndexer(vault); await indexer.initialize();
  if (indexer.warnings.length) {
    console.error(`Atlas Vault index is partial: ${indexer.warnings.length} warning(s).`);
    for (const warning of indexer.warnings.slice(0, 20)) console.error(`  ${warning}`);
    if (indexer.warnings.length > 20) console.error(`  ${indexer.warnings.length - 20} additional warnings; see authenticated GET /api/health in daemon mode.`);
  }
  if (command === 'graph') { console.log(JSON.stringify(indexer.getGraph(), null, 2)); return; }
  if (command === 'search') { console.log(JSON.stringify(indexer.search(positionals.slice(1).join(' ')), null, 2)); return; }
  const telemetry = new Telemetry();
  const provider = new OpenAICompatibleProvider({ apiKey: process.env.ATLAS_API_KEY, baseUrl: process.env.ATLAS_API_BASE, model: process.env.ATLAS_MODEL });
  const harness = new AtlasHarness(provider, indexer, telemetry, { model: process.env.ATLAS_MODEL, auditorModel: process.env.ATLAS_AUDITOR_MODEL, webSearch: process.env.ATLAS_BRAVE_API_KEY ? new BraveWebSearch(process.env.ATLAS_BRAVE_API_KEY) : undefined });
  const gateway = new OpenBotGateway(harness);
  if (command === 'chat') { await gateway.chat(); return; }
  if (command === 'run') { const result = await gateway.respond(positionals.slice(1).join(' ')); console.log(result.output); return; }
  if (command !== 'daemon') throw new Error(`Unknown command: ${command}`);
  const port = Number(values.port ?? '18790');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
  const token = process.env.ATLAS_TOKEN ?? randomBytes(32).toString('base64url');
  const embeddings = process.env.ATLAS_EMBEDDING_MODEL ? new OpenAIEmbeddings(process.env.ATLAS_API_KEY ?? '', process.env.ATLAS_EMBEDDING_MODEL, process.env.ATLAS_API_BASE) : undefined;
  const server = await startServer({ harness, indexer, telemetry, embeddings, token, port, allowedOrigins: process.env.ATLAS_ALLOWED_ORIGINS?.split(',').map(item => item.trim()).filter(Boolean) ?? DEFAULT_ORIGINS });
  indexer.startWatching(() => telemetry.publish('graph:updated', randomUUID(), 'atlas-gbrain-curator', { nodes: indexer.getGraph().nodes.length }), error => console.error(`Vault watcher failed: ${error.message}`));
  console.log(`Atlas daemon: http://127.0.0.1:${server.port}\nVault: ${vault}\nSearch: ${embeddings ? 'lexical + configured semantic provider' : 'lexical'}`);
  if (!process.env.ATLAS_TOKEN) console.log(`Session token (paste into Atlas Desktop): ${token}`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await indexer.close(); await server.close(); };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Atlas failed'); process.exitCode = 1; });

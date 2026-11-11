import { mkdir, readdir, readFile, lstat, writeFile, realpath, link, unlink } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as yaml } from 'yaml';
import type { GraphNode, GraphPayload, NodeKind, SearchHit } from '../contracts.js';
import { insideVault } from './path.js';

interface Document { node: GraphNode; body: string; raw: string; refs: string[] }
export interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }
const tokens = (text: string): string[] => text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
function plainBody(body: string): string { return body.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`]*`/g, ''); }
export function parseMarkdown(raw: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (/^---[ \t]*(?:\n|$)/.test(normalized) && !match) throw new Error('Unclosed YAML frontmatter');
  if (!match) return { metadata: {}, body: normalized };
  const value: unknown = parseYaml(match[1]!, { maxAliasCount: 50 });
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Frontmatter must be a mapping');
  return { metadata: (value ?? {}) as Record<string, unknown>, body: normalized.slice(match[0].length) };
}
function kindOf(relative: string): NodeKind {
  if (relative.startsWith('agents/')) return 'agent';
  if (relative.startsWith('souls/')) return 'soul';
  if (relative.startsWith('memory/')) return 'memory';
  if (relative.startsWith('packs/crm-sales-os/leads/')) return 'lead';
  if (relative.startsWith('projects/')) return 'project';
  return 'note';
}
export class VaultIndexer {
  private documents = new Map<string, Document>();
  private graph: GraphPayload = { version: 1, generatedAt: new Date().toISOString(), nodes: [], links: [], unresolved: [] };
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private pending: Promise<void> = Promise.resolve();
  readonly warnings: string[] = [];
  constructor(readonly root: string, private readonly maxFiles = 10000) {}
  async initialize(): Promise<void> { await mkdir(this.root, { recursive: true }); await this.scan(); }
  async scan(): Promise<void> {
    const next = new Map<string, Document>();
    this.warnings.length = 0;
    const canonical = await realpath(this.root);
    let totalBytes = 0;
    const visit = async (directory: string, depth = 0): Promise<void> => {
      if (depth > 32) { this.warnings.push('Vault depth limit reached'); return; }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (next.size >= this.maxFiles) { this.warnings.push(`Vault limit ${this.maxFiles} files reached`); return; }
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) { await visit(filename, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const relative = path.relative(canonical, filename).split(path.sep).join('/');
        try {
          const info = await lstat(filename);
          if (info.size > 2 * 1024 * 1024 || info.isSymbolicLink()) { this.warnings.push(`Skipped oversized or symbolic note: ${relative}`); continue; }
          if (totalBytes + info.size > 64 * 1024 * 1024) { this.warnings.push('Vault byte limit 64MiB reached'); continue; }
          totalBytes += info.size;
          const raw = await readFile(filename, 'utf8');
          const { metadata, body } = parseMarkdown(raw);
          const content = plainBody(body);
          const tags = [...new Set([
            ...(Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : typeof metadata.tags === 'string' ? [metadata.tags] : []),
            ...[...content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(m => m[1]!)
          ])];
          const kind = kindOf(relative);
          const id = relative.slice(0, -3);
          const node: GraphNode = { id, path: relative, label: String(metadata.name ?? metadata.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(id)), kind, tags, frontmatter: metadata };
          if (kind === 'agent') node.division = relative.split('/')[1];
          next.set(id, { node, raw, body, refs: [...content.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)].map(m => m[1]!.split('|')[0]!.split('#')[0]!.trim()).filter(Boolean) });
        } catch (error) { this.warnings.push(`Cannot index ${relative}: ${String(error)}`); }
      }
    };
    await visit(canonical);
    const aliases = new Map<string, Set<string>>();
    const addAlias = (name: string, id: string) => { const key = name.toLocaleLowerCase().replace(/\.md$/i, ''); const set = aliases.get(key) ?? new Set<string>(); set.add(id); aliases.set(key, set); };
    for (const [id, doc] of next) {
      addAlias(path.posix.basename(id), id);
      if (Array.isArray(doc.node.frontmatter.aliases)) for (const alias of doc.node.frontmatter.aliases) if (typeof alias === 'string') addAlias(alias, id);
    }
    const links: GraphPayload['links'] = [], unresolved: GraphPayload['unresolved'] = [];
    const seen = new Set<string>();
    for (const [id, doc] of next) for (const ref of doc.refs) {
      const normalized = ref.replace(/\.md$/i, '');
      const candidates = next.has(normalized) ? new Set([normalized]) : aliases.get(normalized.toLocaleLowerCase());
      if (candidates?.size === 1) {
        const target = [...candidates][0]!;
        const key = `${id}\0${target}`;
        if (!seen.has(key)) { links.push({ source: id, target, type: 'wikilink' }); seen.add(key); }
      } else unresolved.push({ source: id, target: ref });
    }
    this.documents = next;
    this.graph = { version: 1, generatedAt: new Date().toISOString(), nodes: [...next.values()].map(d => d.node).sort((a, b) => a.id.localeCompare(b.id)), links: links.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)), unresolved };
  }
  getGraph(): GraphPayload { return structuredClone(this.graph); }
  getDocument(id: string): string | undefined { return this.documents.get(id)?.raw; }
  search(query: string, limit = 10): SearchHit[] {
    const terms = [...new Set(tokens(query))];
    if (!terms.length) return [];
    const docs = [...this.documents.values()];
    const frequenciesByDocument = docs.map(doc => {
      const words = tokens(`${doc.node.label} ${doc.node.tags.join(' ')} ${doc.body}`);
      const frequencies = new Map<string, number>(); for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      return { words, frequencies };
    });
    const documentFrequency = new Map(terms.map(term => [term, frequenciesByDocument.filter(item => item.frequencies.has(term)).length]));
    return docs.map((doc, index) => {
      const { words, frequencies } = frequenciesByDocument[index]!;
      let score = 0;
      for (const term of terms) {
        const count = frequencies.get(term) ?? 0;
        const df = documentFrequency.get(term) ?? 0;
        if (count) score += (1 + Math.log(count)) * Math.log(1 + docs.length / (1 + df)) / Math.sqrt(1 + words.length / 100);
        if (tokens(doc.node.label).includes(term)) score += 2;
      }
      const position = Math.max(0, doc.body.toLocaleLowerCase().indexOf(terms[0]!));
      return { id: doc.node.id, label: doc.node.label, path: doc.node.path, score, excerpt: doc.body.slice(Math.max(0, position - 60), position + 240) };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(0, Math.min(limit, 100)));
  }
  async semanticSearch(query: string, provider: EmbeddingProvider, limit = 10): Promise<SearchHit[]> {
    const docs = [...this.documents.values()];
    if (!docs.length) return [];
    const vectors = await provider.embed([query, ...docs.map(doc => `${doc.node.label}\n${doc.body}`.slice(0, 12000))]);
    if (vectors.length !== docs.length + 1) throw new Error('Embedding count mismatch');
    const queryVector = vectors[0]!;
    return docs.map((doc, i) => {
      const vector = vectors[i + 1]!;
      if (!queryVector.length || vector.length !== queryVector.length || [...vector, ...queryVector].some(n => !Number.isFinite(n))) throw new Error('Invalid embedding vector');
      const dot = vector.reduce((sum, n, j) => sum + n * queryVector[j]!, 0);
      const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0) * queryVector.reduce((sum, n) => sum + n * n, 0));
      return { id: doc.node.id, label: doc.node.label, path: doc.node.path, score: norm ? dot / norm : 0, excerpt: doc.body.slice(0, 240) };
    }).sort((a, b) => b.score - a.score).slice(0, Math.max(0, Math.min(limit, 100)));
  }
  async read(relative: string): Promise<string> {
    if (!relative.endsWith('.md')) throw new Error('Vault reads require a Markdown path');
    const filename = await insideVault(this.root, relative);
    if ((await lstat(filename)).size > 2 * 1024 * 1024) throw new Error('Vault note exceeds 2MiB read limit');
    return readFile(filename, 'utf8');
  }
  async writeMemory(topic: string, content: string, links: string[] = []): Promise<string> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic) || topic.length > 100) throw new Error('Memory topic must be a kebab-case slug');
    if (!content.trim() || content.length > 100000) throw new Error('Memory must contain 1–100000 characters');
    if (links.some(link => !/^[a-zA-Z0-9_/-]+$/.test(link))) throw new Error('Invalid memory WikiLink');
    const relative = `memory/${new Date().toISOString().slice(0, 10)}-${topic}-${randomUUID().slice(0, 8)}.md`;
    const filename = await insideVault(this.root, relative, true);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `---\n${yaml({ title: topic, created: new Date().toISOString(), tags: ['episodic'] })}---\n\n${content}\n\n${links.map(link => `[[${link}]]`).join(' ')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      // Atomic, exclusive publication: an existing note can never be overwritten.
      await link(temporary, filename);
    } finally { await unlink(temporary).catch(() => undefined); }
    await this.scan();
    return relative;
  }
  startWatching(onChange: () => void, onError: (error: Error) => void): void {
    if (this.watcher) return;
    this.watcher = watch(this.root, { recursive: true }, () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.pending = this.pending.then(async () => { await this.scan(); onChange(); }).catch(onError); }, 120);
    });
    this.watcher.on('error', onError);
  }
  async close(): Promise<void> { clearTimeout(this.timer); this.watcher?.close(); this.watcher = undefined; await this.pending; }
}

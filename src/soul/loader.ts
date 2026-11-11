import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { insideVault } from '../gbrain/path.js';
import { parseMarkdown, type VaultIndexer } from '../gbrain/indexer.js';

export interface AgentIdentity { slug: string; name: string; specialty: string; soul: string; skills: string[] }
export class SoulLoader {
  constructor(private readonly indexer: VaultIndexer) {}
  async load(slug: string): Promise<AgentIdentity> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Agent slug must be kebab-case');
    const matches = this.indexer.getGraph().nodes.filter(node => node.kind === 'agent' && path.posix.basename(node.id) === slug);
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous agent: ${slug}` : `Unknown agent: ${slug}`);
    const node = matches[0]!;
    const specialty = (await this.indexer.read(node.path));
    let soul: string;
    try { soul = await readFile(await insideVault(this.indexer.root, `souls/${slug}.soul.md`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Error(`Missing identity: souls/${slug}.soul.md`);
    }
    if (!parseMarkdown(soul).body.trim()) throw new Error(`Empty Soul: ${slug}`);
    const skills: string[] = [];
    const skillDirectory = `skills/${slug}`;
    try {
      const directory = await insideVault(this.indexer.root, skillDirectory);
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('Skill symlinks are not permitted');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name === 'SKILL.md') skills.push(await this.indexer.read(`${skillDirectory}/SKILL.md`));
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const relative = `${skillDirectory}/${entry.name}/SKILL.md`;
          try { skills.push(await this.indexer.read(relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { slug, name: node.label, specialty, soul, skills };
  }
}

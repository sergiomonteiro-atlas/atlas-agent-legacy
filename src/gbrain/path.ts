import { lstat, realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function safeRelative(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Invalid Vault relative path');
  }
  return value;
}
export async function insideVault(root: string, relative: string, createParents = false): Promise<string> {
  safeRelative(relative);
  const canonical = await realpath(root);
  const parts = relative.split('/');
  let current = canonical;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Vault symlinks are not permitted');
      const resolved = await realpath(current);
      const relation = path.relative(canonical, resolved);
      if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('Path escapes Vault');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (i < parts.length - 1 && createParents) await mkdir(current);
      else if (i < parts.length - 1) throw error;
    }
  }
  return current;
}

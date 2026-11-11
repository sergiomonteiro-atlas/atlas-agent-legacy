import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { AtlasHarness, RunResult } from '../core/harness.js';

export function parseMention(input: string, fallback = 'atlas-ai-native-architect'): { agentSlug: string; task: string } {
  const match = input.trim().match(/^@([a-z0-9]+(?:-[a-z0-9]+)*)\s+([\s\S]+)$/);
  if (input.trim().startsWith('@') && !match) throw new Error('Use @agent-slug followed by a task');
  return match ? { agentSlug: match[1]!, task: match[2]! } : { agentSlug: fallback, task: input.trim() };
}
export class OpenBotGateway {
  constructor(private readonly harness: AtlasHarness) {}
  async respond(input: string, signal?: AbortSignal): Promise<RunResult> {
    const { agentSlug, task } = parseMention(input);
    return this.harness.run(agentSlug, task, signal);
  }
  async chat(): Promise<void> {
    const reader = createInterface({ input: stdin, output: stdout });
    stdout.write('Atlas · AI-Native Workforce\nUse @agent-slug task. /exit closes this session.\n');
    try {
      for (;;) {
        let input: string;
        try { input = await reader.question('atlas> '); } catch { break; }
        if (input.trim() === '/exit') break;
        if (!input.trim()) continue;
        try { const result = await this.respond(input); stdout.write(`${result.output}\n\nAuditor approved · ${result.runId}\n`); }
        catch (error) { stdout.write(`Task open: ${error instanceof Error ? error.message : 'Run failed'}\n`); }
      }
    } finally { reader.close(); }
  }
}

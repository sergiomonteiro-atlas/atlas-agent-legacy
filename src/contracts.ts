export type NodeKind = 'agent' | 'soul' | 'memory' | 'lead' | 'project' | 'note';
export interface GraphNode {
  id: string;
  path: string;
  label: string;
  kind: NodeKind;
  division?: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}
export interface GraphPayload {
  version: 1;
  generatedAt: string;
  nodes: GraphNode[];
  links: { source: string; target: string; type: 'wikilink' }[];
  unresolved: { source: string; target: string }[];
}
export type EventType = 'agent:start' | 'agent:tool_call' | 'agent:critic_review' | 'agent:done' | 'agent:error' | 'graph:updated';
export interface AtlasEvent {
  version: 1;
  id: string;
  runId: string;
  agentSlug: string;
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}
export interface SearchHit { id: string; label: string; path: string; score: number; excerpt: string }
export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface Completion { content: string; toolCalls: ToolCall[] }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ModelProvider {
  complete(messages: Message[], options: { model?: string; tools?: ToolDefinition[]; signal?: AbortSignal }): Promise<Completion>;
}

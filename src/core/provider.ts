import type { Completion, Message, ModelProvider, ToolDefinition } from '../contracts.js';

export interface ProviderOptions { apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number }
export class OpenAICompatibleProvider implements ModelProvider {
  readonly baseUrl: string;
  constructor(private readonly options: ProviderOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const url = new URL(this.baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Model endpoint must use HTTPS or local HTTP');
    }
  }
  async complete(messages: Message[], options: { model?: string; tools?: ToolDefinition[]; signal?: AbortSignal }): Promise<Completion> {
    if (!this.options.apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.baseUrl).hostname)) {
      throw new Error('ATLAS_API_KEY is required for the configured remote model. No simulated completion is available.');
    }
    const model = options.model ?? this.options.model;
    if (!model) throw new Error('ATLAS_MODEL is required');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}) })
    });
    if (!response.ok) throw new Error(`Model request failed (${response.status})`);
    const data = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('Model response did not contain a message');
    return { content: message.content ?? '', toolCalls: (message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) };
  }
}

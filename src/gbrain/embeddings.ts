import type { EmbeddingProvider } from './indexer.js';

export class OpenAIEmbeddings implements EmbeddingProvider {
  private readonly baseUrl: string;
  constructor(private readonly apiKey: string, private readonly model: string, baseUrl = 'https://api.openai.com/v1') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    const url = new URL(this.baseUrl);
    if (!model || (!apiKey && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Embedding model and API credentials are required');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Embedding endpoint must use HTTPS or local HTTP');
  }
  async embed(texts: string[]): Promise<number[][]> {
    const result: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 32) {
      const input = texts.slice(offset, offset + 32);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST', signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input })
      });
      if (!response.ok) throw new Error(`Embedding request failed (${response.status})`);
      const payload = await response.json() as { data?: { index: number; embedding: number[] }[] };
      if (payload.data?.length !== input.length) throw new Error('Embedding response count mismatch');
      result.push(...payload.data.sort((a, b) => a.index - b.index).map(item => item.embedding));
    }
    return result;
  }
}

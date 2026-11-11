export interface WebSearchResult { title: string; url: string; description: string }
export interface WebSearchProvider { search(query: string): Promise<WebSearchResult[]> }
/** Opt-in Brave Search API adapter. Search results are external untrusted evidence. */
export class BraveWebSearch implements WebSearchProvider {
  constructor(private readonly apiKey: string) { if (!apiKey) throw new Error('ATLAS_BRAVE_API_KEY is required'); }
  async search(query: string): Promise<WebSearchResult[]> {
    if (!query.trim() || query.length > 2000) throw new Error('Web search query must contain 1–2000 characters');
    const url = new URL('https://api.search.brave.com/res/v1/web/search'); url.searchParams.set('q', query); url.searchParams.set('count', '5');
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json', 'X-Subscription-Token': this.apiKey } });
    if (!response.ok) throw new Error(`Web search failed (${response.status})`);
    const payload = await response.json() as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (payload.web?.results ?? []).filter(item => typeof item.url === 'string' && /^https?:\/\//.test(item.url)).map(item => ({ title: item.title ?? '', url: item.url!, description: item.description ?? '' }));
  }
}

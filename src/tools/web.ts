/**
 * Web Interaction Tools
 *   #7  WebFetch  — Fetch URL content
 *   #8  WebSearch — Web search with optional domain filtering
 */

import { defineTool, ToolSpec } from './types';

// ---------------------------------------------------------------------------
// #7 — WebFetch
// ---------------------------------------------------------------------------

export const webFetchTool: ToolSpec = defineTool({
    name: 'WebFetch',
    category: 'web',
    description:
        'Fetch the content of a URL and return it as text. Useful for reading documentation, ' +
        'API responses, or web pages. Supports a prompt to describe what you are looking for ' +
        'in the page. Returns the first 10,000 characters of the response.',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The URL to fetch.' },
            prompt: { type: 'string', description: 'Optional description of what you are looking for on this page.' },
        },
        required: ['url'],
    },
    requiresConfirmation: false,
    permissionLevel: 'network',

    async execute(args) {
        const url = args.url as string;
        const prompt = args.prompt as string | undefined;

        // Validate URL
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return `Invalid URL: ${url}`;
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return `Only HTTP/HTTPS URLs are supported. Got: ${parsed.protocol}`;
        }

        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'ClawAgent/1.0 (VSCode Extension)',
                    'Accept': 'text/html,application/json,text/plain,*/*',
                },
                signal: AbortSignal.timeout(15000),
            });

            if (!response.ok) {
                return `HTTP ${response.status} ${response.statusText} for ${url}`;
            }

            const contentType = response.headers.get('content-type') || '';
            let text: string;

            if (contentType.includes('application/json')) {
                const json = await response.json();
                text = JSON.stringify(json, null, 2);
            } else {
                text = await response.text();
                // Strip HTML tags for readability if it's an HTML page
                if (contentType.includes('text/html')) {
                    text = text
                        .replace(/<script[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[\s\S]*?<\/style>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                }
            }

            // Truncate
            const maxLen = 10000;
            if (text.length > maxLen) {
                text = text.substring(0, maxLen) + `\n\n... (truncated, ${text.length} total chars)`;
            }

            const header = prompt ? `Fetched ${url} (looking for: ${prompt}):\n\n` : `Fetched ${url}:\n\n`;
            return header + text;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return `Fetch failed for ${url}: ${message}`;
        }
    },
});

// ---------------------------------------------------------------------------
// #8 — WebSearch
// ---------------------------------------------------------------------------

export const webSearchTool: ToolSpec = defineTool({
    name: 'WebSearch',
    category: 'web',
    description:
        'Search the web for information. Returns a list of results with titles, URLs, and snippets. ' +
        'Optionally filter by domain. Uses a public search API.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The search query.' },
            domain: { type: 'string', description: 'Optional domain filter, e.g. "docs.python.org" or "github.com".' },
            max_results: {
                type: 'number',
                description: 'Max number of results (default: 5, max: 10).',
                default: 5,
            },
        },
        required: ['query'],
    },
    requiresConfirmation: false,
    permissionLevel: 'network',

    async execute(args) {
        const query = args.query as string;
        const domain = args.domain as string | undefined;
        const maxResults = Math.min(Number(args.max_results) || 5, 10);

        const searchQuery = domain ? `site:${domain} ${query}` : query;

        try {
            // Use DuckDuckGo HTML API (no key required)
            const encodedQuery = encodeURIComponent(searchQuery);
            const response = await fetch(
                `https://html.duckduckgo.com/html/?q=${encodedQuery}`,
                {
                    headers: {
                        'User-Agent': 'ClawAgent/1.0 (VSCode Extension)',
                    },
                    signal: AbortSignal.timeout(10000),
                },
            );

            if (!response.ok) {
                return `Search failed: HTTP ${response.status}`;
            }

            const html = await response.text();

            // Parse DuckDuckGo HTML results
            const results: { title: string; url: string; snippet: string }[] = [];
            const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

            let match;
            while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
                const url = decodeURIComponent(match[1].replace(/.*uddg=/, '').replace(/&.*/, ''));
                const title = match[2].replace(/<[^>]+>/g, '').trim();
                const snippet = match[3].replace(/<[^>]+>/g, '').trim();
                if (title && url) {
                    results.push({ title, url, snippet });
                }
            }

            if (results.length === 0) {
                return `No results found for "${query}"${domain ? ` on ${domain}` : ''}.`;
            }

            return results
                .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
                .join('\n\n');
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return `Search failed: ${message}`;
        }
    },
});

export const webTools: ToolSpec[] = [webFetchTool, webSearchTool];

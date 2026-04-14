/**
 * synonymsClient.ts
 *
 * Synonyms lookup client used by the language server. Supports both providers
 * used by the pre-LSP implementation:
 *   - Merriam-Webster Dictionary API (`synonymsApi`)
 *   - Word Hippo (`wh`)
 *
 * The active provider is pushed from the extension host via WT_CONFIG_UPDATE.
 * Results are cached per provider+word and in-flight requests are deduplicated.
 */
import { getPersonalDict, getSynonymsApiKey, getSynonymsProvider } from '../state/serverState';
import { stripDiacritics, capitalize } from './textUtils';

export type Definition = {
    definitions: string[];
    part:        string;
    synonyms:    string[];
    antonyms:    string[];
};

export type Synonyms = {
    type:        'success';
    word:        string;
    definitions: Definition[];
};

export type SynonymError = {
    type:        'error';
    message:     string;
    suggestions?: string[];
};

export type SynonymSearchResult = Synonyms | SynonymError;

// Disable TLS certificate rejection to mirror the old client behaviour.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function parseList(defs: (string | string[])[]): string[] {
    const out: string[] = [];
    for (const d of defs) {
        if (Array.isArray(d)) out.push(...parseList(d));
        else out.push(d);
    }
    return out;
}

function keyFor(provider: 'wh' | 'synonymsApi', word: string): string {
    return `${provider}:${word}`;
}

const inflightQueries: Map<string, Promise<SynonymSearchResult>> = new Map();
const synonymCache: Map<string, SynonymSearchResult> = new Map();

async function querySynonymsApi(word: string, apiKey: string): Promise<SynonymSearchResult> {
    const url = `https://dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${encodeURIComponent(apiKey)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            return { type: 'error', message: 'Could not connect to dictionary API. Please check your internet connection.' };
        }

        // Some API failures return plain text (e.g. "Word is required.") with status 200.
        // Parse defensively to avoid throwing a JSON syntax error into user-facing hover text.
        const body = await resp.text();
        let json: unknown;
        try {
            json = JSON.parse(body);
        } catch {
            return { type: 'error', message: `Dictionary API request failed: ${body}` };
        }

        if (!Array.isArray(json) || json.length === 0 || typeof json[0] === 'string') {
            const arr = (json as string[]).slice(0, 10);
            const suggestions = arr.join(', ');
            return {
                type: 'error',
                message: `### Word not recognized by dictionary API.\n\n\nDid you mean: ${suggestions}?`,
                suggestions: arr,
            };
        }

        const definitions: Definition[] = (json as any[]).map(d => ({
            definitions: parseList(d['shortdef']),
            part:        d['fl'] as string,
            synonyms:    parseList(d['meta']['syns']),
            antonyms:    parseList(d['meta']['ants']),
        }));

        const defMap: Record<string, number> = {};
        definitions.forEach((def, i) => { defMap[def.definitions[0]] = i; });
        const dedupedDefs = Object.values(defMap).map(i => definitions[i]);

        return { type: 'success', word, definitions: dedupedDefs };
    } catch (err) {
        return { type: 'error', message: `Dictionary API request failed: ${err}` };
    }
}

async function queryWordHippo(word: string): Promise<SynonymSearchResult> {
    const normalized = word.toLowerCase().trim().replace(/\s+/g, '_');
    const url = `https://www.wordhippo.com/what-is/another-word-for/${encodeURIComponent(normalized)}.html`;

    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            console.log(url);
            return { type: 'error', message: `Could not connect to Word Hippo. Please check your internet connection.\n${url}` };
        }

        const html = await resp.text();
        if (html.includes('/what-is/recaptcha.bot')) {
            return { type: 'error', message: 'Word Hippo rejected the request (captcha). Try again shortly.' };
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { JSDOM } = require('jsdom') as typeof import('jsdom');
            const parser = new JSDOM(html);
            const doc = parser.window.document;
            const partsOfSpeech = doc.querySelectorAll('.wordtype');
            const descriptions = doc.querySelectorAll('.tabdesc');
            const allRelated = doc.querySelectorAll('.relatedwords');

            const definitions: Definition[] = [];
            for (let i = 0; i < allRelated.length; i++) {
                let part = partsOfSpeech[i]?.textContent?.replaceAll(/[^\w]/g, '')?.toLowerCase() ?? '';
                if (part === 'nearbywords') part = 'Nearby Words';

                const description = descriptions[i]?.textContent?.trim() ?? '';
                const related = allRelated[i];
                const phrases = [
                    ...related.querySelectorAll('.wb'),
                    ...related.querySelectorAll('.wordblock'),
                ];

                const synonyms = phrases
                    .map(p => (p.textContent ?? '').trim())
                    .map(txt => txt.endsWith('US') ? txt.replace('US', '').trim() : txt)
                    .filter(txt => txt.length > 0 && !txt.endsWith('UK'));

                definitions.push({
                    part,
                    definitions: [description],
                    synonyms,
                    antonyms: [],
                });
            }

            if (definitions.length === 0) {
                return { type: 'error', message: 'Word Hippo was unable to find synonyms for this word.' };
            }

            if (definitions.length === 1 && definitions[0].part === 'Nearby Words') {
                return {
                    type: 'error',
                    message: 'Word Hippo was unable to find exact synonyms for this word.',
                    suggestions: definitions[0].synonyms,
                };
            }

            return {
                type: 'success',
                word: normalized,
                definitions,
            };
        } catch {
            // Fallback if jsdom is unavailable: collect anchor labels only.
            const anchorMatches = [...html.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)];
            const words = anchorMatches.map(m => m[1].trim()).filter(Boolean).slice(0, 25);
            if (words.length === 0) {
                return { type: 'error', message: 'Word Hippo parsing failed for this word.' };
            }
            return {
                type: 'success',
                word: normalized,
                definitions: [{ part: 'Related Words', definitions: ['Related words from Word Hippo'], synonyms: words, antonyms: [] }],
            };
        }
    } catch (err) {
        return { type: 'error', message: `Word Hippo request failed: ${err}` };
    }
}

export async function provideSynonyms(word: string): Promise<SynonymSearchResult> {
    const provider = getSynonymsProvider();
    const normalized = stripDiacritics(word.toLowerCase());
    const cacheKey = keyFor(provider, normalized);

    const cached = synonymCache.get(cacheKey);
    if (cached) return cached;

    const inflight = inflightQueries.get(cacheKey);
    if (inflight) return inflight;

    let promise: Promise<SynonymSearchResult>;
    if (provider === 'wh') {
        promise = queryWordHippo(normalized);
    } else {
        const apiKey = getSynonymsApiKey();
        if (!apiKey) {
            return { type: 'error', message: 'No synonyms API key configured. Set `wt.synonyms.apiKey` in settings.' };
        }
        promise = querySynonymsApi(normalized, apiKey);
    }

    const tracked = promise.then(result => {
        synonymCache.set(cacheKey, result);
        inflightQueries.delete(cacheKey);
        return result;
    });

    inflightQueries.set(cacheKey, tracked);
    return tracked;
}

const hoverMarkdownCache: Map<string, string> = new Map();

export async function getHoverMarkdown(text: string): Promise<string> {
    const provider = getSynonymsProvider();
    const stripped = stripDiacritics(text);
    const hoverCacheKey = keyFor(provider, stripped);
    const cached = hoverMarkdownCache.get(hoverCacheKey);
    if (cached) return cached;

    const response = await provideSynonyms(stripped);

    if (response.type === 'error') {
        if (getPersonalDict()[stripped.toLowerCase()] === 1) {
            return '### From your personal dictionary';
        }
        return response.message;
    }

    const word = capitalize(text);
    const header = `### ${word}:`;
    const definitions = response.definitions.map(({ part, definitions: defs }) => {
        const def = capitalize(defs[0] ?? '');
        return `- (*${part}*) ${def}`;
    });
    const fullString = `${header}\n\n\n${definitions.join('\n\n')}`;

    hoverMarkdownCache.set(hoverCacheKey, fullString);
    return fullString;
}

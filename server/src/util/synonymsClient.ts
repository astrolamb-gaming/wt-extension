import { getPersonalDict, getSynonymsApiKey } from '../state/serverState';
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

// Disable TLS rejection to mirror client-side behaviour
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function parseList(defs: (string | string[])[]): string[] {
    const out: string[] = [];
    for (const d of defs) {
        if (Array.isArray(d)) out.push(...parseList(d));
        else out.push(d);
    }
    return out;
}

// Outgoing queries already in flight — avoids duplicate network requests
const inflightQueries: Map<string, Promise<SynonymSearchResult>> = new Map();
// Resolved cache (in-memory, server lifetime)
const synonymCache: Map<string, SynonymSearchResult> = new Map();

async function querySynonymsApi(word: string, apiKey: string): Promise<SynonymSearchResult> {
    const url = `https://dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${encodeURIComponent(apiKey)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            return { type: 'error', message: 'Could not connect to dictionary API. Please check your internet connection.' };
        }
        const json: unknown = await resp.json();

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

        // Deduplicate by first definition string (mirrors client)
        const defMap: Record<string, number> = {};
        definitions.forEach((def, i) => { defMap[def.definitions[0]] = i; });
        const dedupedDefs = Object.values(defMap).map(i => definitions[i]);

        return { type: 'success', word, definitions: dedupedDefs };
    } catch (err) {
        return { type: 'error', message: `Dictionary API request failed: ${err}` };
    }
}

export async function provideSynonyms(word: string): Promise<SynonymSearchResult> {
    const normalized = stripDiacritics(word.toLowerCase());

    const cached = synonymCache.get(normalized);
    if (cached) return cached;

    const inflight = inflightQueries.get(normalized);
    if (inflight) return inflight;

    const apiKey = getSynonymsApiKey();
    if (!apiKey) {
        return { type: 'error', message: 'No synonyms API key configured. Set `wt.synonyms.apiKey` in settings.' };
    }

    const promise = querySynonymsApi(normalized, apiKey).then(result => {
        synonymCache.set(normalized, result);
        inflightQueries.delete(normalized);
        return result;
    });
    inflightQueries.set(normalized, promise);
    return promise;
}

// Hover markdown cache — keyed on stripped word
const hoverMarkdownCache: Map<string, string> = new Map();

export async function getHoverMarkdown(text: string): Promise<string> {
    const stripped = stripDiacritics(text);
    const cached = hoverMarkdownCache.get(stripped);
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

    hoverMarkdownCache.set(stripped, fullString);
    return fullString;
}

/**
 * synonymsClient.ts
 *
 * Merriam-Webster Thesaurus API client for the language server.
 * Provides two public functions:
 *
 *   provideSynonyms(word)   — queries the API and returns definitions + synonyms,
 *                             or an error with spelling suggestions.
 *   getHoverMarkdown(word)  — wraps provideSynonyms and formats the result as
 *                             Markdown suitable for an LSP Hover response.
 *
 * Both functions maintain in-process caches that persist for the lifetime of the
 * language server process so the API is not hit more than once per word per
 * session.  In-flight deduplication prevents duplicate parallel requests for the
 * same word.
 */
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

// Disable TLS certificate rejection to mirror the client-side fetch behaviour
// (the MW API endpoint uses a self-signed cert in some environments).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Recursively flattens a nested array-of-strings structure returned by the
 * Merriam-Webster JSON response for `shortdef`, `syns`, and `ants` fields.
 */
function parseList(defs: (string | string[])[]): string[] {
    const out: string[] = [];
    for (const d of defs) {
        if (Array.isArray(d)) out.push(...parseList(d));
        else out.push(d);
    }
    return out;
}

/** Outgoing queries already in flight — avoids duplicate parallel network requests. */
const inflightQueries: Map<string, Promise<SynonymSearchResult>> = new Map();
/** In-memory result cache; keyed on stripped/lowercased word; lives for server lifetime. */
const synonymCache: Map<string, SynonymSearchResult> = new Map();

/**
 * Makes a single HTTP request to the Merriam-Webster Thesaurus API and parses
 * the JSON response into a typed SynonymSearchResult.
 *
 * When the API does not recognise the word it returns an array of strings
 * (spelling suggestions) instead of an array of entry objects — that case is
 * detected and mapped to a SynonymError containing the suggestions.
 */
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

/**
 * Returns synonyms and definitions for `word` from the Merriam-Webster
 * Thesaurus API, using in-process caching and in-flight deduplication.
 *
 * The word is normalised (diacritics stripped, lowercased) before lookup so
 * that "café" and "cafe" resolve to the same cached result.
 */
export async function provideSynonyms(word: string): Promise<SynonymSearchResult> {
    const normalized = stripDiacritics(word.toLowerCase());

    // Return immediately if a previous result is cached
    const cached = synonymCache.get(normalized);
    if (cached) return cached;

    // Re-use an in-flight promise for the same word to avoid duplicate requests
    const inflight = inflightQueries.get(normalized);
    if (inflight) return inflight;

    // Guard: cannot query without a configured API key
    const apiKey = getSynonymsApiKey();
    if (!apiKey) {
        return { type: 'error', message: 'No synonyms API key configured. Set `wt.synonyms.apiKey` in settings.' };
    }

    // Fire the request, register it as in-flight, and cache the result on completion
    const promise = querySynonymsApi(normalized, apiKey).then(result => {
        synonymCache.set(normalized, result);
        inflightQueries.delete(normalized);
        return result;
    });
    inflightQueries.set(normalized, promise);
    return promise;
}

/** In-memory hover-markdown cache; keyed on stripped word; lives for server lifetime. */
const hoverMarkdownCache: Map<string, string> = new Map();

/**
 * Builds the Markdown string shown in the hover tooltip for `text`.
 *
 * Flow:
 *   1. Check the in-memory cache (avoids re-formatting already-seen words).
 *   2. Call provideSynonyms().
 *   3. On error: return a personal-dictionary notice or the API error message.
 *   4. On success: format definitions as a Markdown bullet list and cache it.
 */
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

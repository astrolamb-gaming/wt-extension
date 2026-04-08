/**
 * Custom LSP notification method names and payload types used for the push-based
 * state model between the extension host (client) and the language server.
 *
 * Because the language server runs in a separate Node process it has no direct
 * access to VS Code APIs or workspace state.  Instead the client pushes snapshots
 * of the relevant state through these notifications whenever it changes.
 *
 * IMPORTANT: the client (client/src/client.ts) cannot import this file due to
 * TypeScript project-reference boundaries, so it duplicates the method-name
 * strings as local constants.  Keep the two in sync manually.
 */

// ── Notification method names ────────────────────────────────────────────────

/** Sent when the user adds or removes a word from their personal dictionary. */
export const WT_PERSONAL_DICT_UPDATE = 'wt/personalDictionaryUpdate';

/** Sent when the word-watcher watched-word list changes and a new regex is built. */
export const WT_WORD_WATCHER_UPDATE  = 'wt/wordWatcherUpdate';

/** Sent on startup and whenever the user edits a `wt.synonyms.*` setting. */
export const WT_CONFIG_UPDATE        = 'wt/configUpdate';

/**
 * Sent whenever the active set of autocorrect underlines changes (an entry is
 * added or its 5-second expiry timer fires).  The server uses the payload to
 * push `publishDiagnostics` back to the client and to serve code actions.
 */
export const WT_AUTOCORRECT_UPDATE   = 'wt/autocorrectUpdate';

// ── Payload types ────────────────────────────────────────────────────────────

/** Full personal-dictionary snapshot; values are always `1` (presence set). */
export type PersonalDictUpdateParams = { dict: Record<string, 1> };

/** Compiled regex pattern string for all watched words, or `null` when empty. */
export type WordWatcherUpdateParams  = { pattern: string | null };

/** Merriam-Webster Thesaurus API key and optional cache-location override. */
export type ConfigUpdateParams       = { apiKey: string | null; cacheLocation: string | null };

/**
 * A single autocorrect underline entry — one word that was changed (or swapped
 * for a special character) in a document.
 */
export type AutocorrectEntry = {
    /** `'correction'` = word substitution; `'specialCharacterSwap'` = e.g. " → " */
    kind: 'correction' | 'specialCharacterSwap';
    /** LSP-style range (line/character) of the replacement text in the document. */
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    /** The original text before correction. */
    original: string;
    /** The replacement text that was inserted. */
    corrected: string;
    /** Human-readable source label (outline node display name, or file basename). */
    nodeLabel: string;
};

/**
 * Full snapshot of all currently-active autocorrect underlines, grouped by
 * document URI.  Entries expire after UNDERLINE_TIMER ms on the client.
 */
export type AutocorrectUpdatePayload = {
    /** Key: full document URI string (e.g. "file:///path/to/file.wt") */
    corrections: {
        [uriString: string]: {
            /** Key: random id assigned by the client when the correction was made. */
            [id: string]: AutocorrectEntry;
        };
    };
};

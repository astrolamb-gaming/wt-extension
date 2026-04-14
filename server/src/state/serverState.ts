/**
 * serverState.ts
 *
 * In-process state store for data that originates in the extension host but is
 * needed by server-side providers.  Because the language server runs in a
 * separate Node process it cannot call VS Code APIs directly.
 *
 * The client pushes snapshots of the following items as LSP notifications:
 *   • Personal dictionary  (wt/personalDictionaryUpdate)
 *   • Word-watcher pattern (wt/wordWatcherUpdate)
 *   • Synonyms API config  (wt/configUpdate)
 *   • Autocorrect underlines (wt/autocorrectUpdate)
 *
 * registerStateHandlers() wires up handlers for all four notification types.
 * The individual getter functions are imported by providers that need them.
 */
import { Connection, DiagnosticSeverity } from 'vscode-languageserver/node';
import {
    WT_PERSONAL_DICT_UPDATE,
    WT_WORD_WATCHER_UPDATE,
    WT_CONFIG_UPDATE,
    WT_AUTOCORRECT_UPDATE,
    PersonalDictUpdateParams,
    WordWatcherUpdateParams,
    ConfigUpdateParams,
    AutocorrectEntry,
    AutocorrectUpdatePayload,
} from '../protocol/notifications';

// ── Module-level state ───────────────────────────────────────────────────────

/** Presence set of words the user has added to their personal dictionary. */
let personalDict: Record<string, 1> = {};

/** Compiled regex pattern string covering all word-watcher watched words. */
let wordWatcherPattern: string | null = null;

/** Merriam-Webster Thesaurus API key, passed through from VS Code settings. */
let synonymsApiKey: string | null = null;

/** Active synonyms provider selected in the extension host. */
let synonymsProvider: 'wh' | 'synonymsApi' = 'synonymsApi';

/**
 * Active autocorrect underlines keyed by document URI, then by a random entry
 * id.  Entries expire after UNDERLINE_TIMER ms on the client side.
 */
let autocorrectCorrections: Record<string, Record<string, AutocorrectEntry>> = {};

// ── Getters ──────────────────────────────────────────────────────────────────

export function getPersonalDict(): Record<string, 1> { return personalDict; }
export function getWordWatcherPattern(): string | null { return wordWatcherPattern; }
export function getSynonymsApiKey(): string | null { return synonymsApiKey; }
export function getSynonymsProvider(): 'wh' | 'synonymsApi' { return synonymsProvider; }
export function getAutocorrectCorrections(): Record<string, Record<string, AutocorrectEntry>> { return autocorrectCorrections; }

// ── Notification handlers ────────────────────────────────────────────────────

/**
 * Registers all client→server notification handlers on the given connection.
 * Must be called once during server startup, after `createConnection()`.
 */
export function registerStateHandlers(connection: Connection): void {

    // Replace the personal dictionary snapshot on every update.
    connection.onNotification(WT_PERSONAL_DICT_UPDATE, (params: PersonalDictUpdateParams) => {
        personalDict = params.dict;
    });

    // Replace the word-watcher compiled regex string on every update.
    connection.onNotification(WT_WORD_WATCHER_UPDATE, (params: WordWatcherUpdateParams) => {
        wordWatcherPattern = params.pattern;
    });

    // Store active synonyms provider and API key
    // (cacheLocation is still ignored server-side).
    connection.onNotification(WT_CONFIG_UPDATE, (params: ConfigUpdateParams) => {
        synonymsApiKey = params.apiKey;
        synonymsProvider = params.provider;
    });

    connection.onNotification(WT_AUTOCORRECT_UPDATE, (params: AutocorrectUpdatePayload) => {
        // Remember which URIs had corrections before this update so we can
        // clear diagnostics for any document that no longer has any underlines.
        const prevUris = new Set(Object.keys(autocorrectCorrections));
        autocorrectCorrections = params.corrections;

        // Clear diagnostics for documents that no longer have any corrections.
        // (If we skip this step, stale blue information markers linger in the
        // Problems panel even after all underlines have expired.)
        for (const uri of prevUris) {
            if (!(uri in params.corrections)) {
                connection.sendDiagnostics({ uri, diagnostics: [] });
            }
        }

        // Push updated diagnostics for each document that has active corrections.
        // Each entry becomes one Information-severity diagnostic that VS Code
        // displays as the blue underline in the editor and in the Problems panel.
        for (const [uri, entries] of Object.entries(params.corrections)) {
            const diagnostics = Object.values(entries).map(entry => ({
                range: entry.range,
                message: `Corrected '${entry.original}' to '${entry.corrected}' in '${entry.nodeLabel}'`,
                severity: DiagnosticSeverity.Information,
                source: 'wt-autocorrect',
            }));
            connection.sendDiagnostics({ uri, diagnostics });
        }
    });
}

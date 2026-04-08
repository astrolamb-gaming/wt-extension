/**
 * synonymsAction.ts
 *
 * Server-side code action provider for the synonyms / spellcheck feature.
 *
 * Given the document and the cursor range, this provider:
 *   1. Extracts the hovered word using the same word-boundary logic as hover/completions.
 *   2. If the word is in the user's personal dictionary, returns the standard
 *      "notebook / dictionary" quick-fix actions immediately (no API call).
 *   3. Otherwise queries the Merriam-Webster API:
 *      – If the word is recognised: returns the notebook / dictionary actions.
 *      – If the word is unknown:    returns the notebook / dictionary actions
 *        PLUS spelling-suggestion replacement actions for each API suggestion.
 *
 * Selecting a spelling suggestion also fires the `wt.autocorrections.wordReplaced`
 * command so the autocorrect system can offer to save the substitution as a
 * permanent rule.
 */
import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHoveredWord } from '../../util/hoveredWord';
import { provideSynonyms } from '../../util/synonymsClient';
import { getPersonalDict } from '../../state/serverState';
import { capitalize, getTextCapitalization, transformToCapitalization } from '../../util/textUtils';

/**
 * The three "notebook / dictionary" actions that are always offered for any
 * recognised word.  They are returned as a factory so the array is not shared.
 */
function defaultActions(text: string, capitalizedText: string): CodeAction[] {
    return [
        {
            title: `Add ${capitalizedText} to personal dictionary`,
            command: { command: 'wt.personalDictionary.add', arguments: [text], title: '' },
            isPreferred: true,
            kind: CodeActionKind.QuickFix,
        },
        {
            title: `Create new notebook note for '${capitalizedText}'`,
            command: { command: 'wt.notebook.addNote', arguments: [capitalizedText], title: '' },
            kind: CodeActionKind.QuickFix,
        },
        {
            title: `Add '${capitalizedText}' as new alias for existing note`,
            command: { command: 'wt.notebook.addAliasToNote', arguments: [capitalizedText], title: '' },
            kind: CodeActionKind.QuickFix,
        },
    ];
}

export async function synonymsCodeActions(doc: TextDocument, range: Range): Promise<CodeAction[]> {
    const text = doc.getText();
    const offset = doc.offsetAt(range.start);

    // Identify the word at the cursor position
    const hoverPos = getHoveredWord(text, offset);
    if (!hoverPos) return [];

    const hoverRange: Range = {
        start: doc.positionAt(hoverPos.start),
        end:   doc.positionAt(hoverPos.end),
    };

    const capitalized = capitalize(hoverPos.text);
    const defaults = () => defaultActions(hoverPos.text, capitalized);

    // Personal dictionary is the fast path — known word, no API call needed
    const inPersonalDict = getPersonalDict()[hoverPos.strippedText.toLowerCase()] === 1;
    if (inPersonalDict) return defaults();

    // Query the synonyms API to determine whether the word is correctly spelled
    const response = await provideSynonyms(hoverPos.strippedText);
    if (response.type !== 'error') return defaults();

    // Unknown word — show the standard actions plus spelling-suggestion replacements
    const capitalization = getTextCapitalization(hoverPos.text);
    const suggestions: CodeAction[] = (response.suggestions ?? []).map(suggest => {
        // Match the capitalisation of the original word
        const replaceText = transformToCapitalization(suggest, capitalization);
        return {
            title: `Replace with: '${replaceText}'`,
            kind: CodeActionKind.QuickFix,
            edit: {
                changes: {
                    [doc.uri]: [{ range: hoverRange, newText: replaceText }],
                },
            },
            // Let autocorrect know about this substitution so it can offer to save it
            command: {
                command: 'wt.autocorrections.wordReplaced',
                arguments: [hoverPos.text, replaceText],
                title: '',
            },
        } satisfies CodeAction;
    });

    return [...defaults(), ...suggestions];
}

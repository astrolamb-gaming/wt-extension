import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHoveredWord } from '../../util/hoveredWord';
import { provideSynonyms } from '../../util/synonymsClient';
import { getPersonalDict } from '../../state/serverState';
import { capitalize, getTextCapitalization, transformToCapitalization } from '../../util/textUtils';

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
    const hoverPos = getHoveredWord(text, offset);
    if (!hoverPos) return [];

    const hoverRange: Range = {
        start: doc.positionAt(hoverPos.start),
        end:   doc.positionAt(hoverPos.end),
    };

    const capitalized = capitalize(hoverPos.text);
    const defaults = () => defaultActions(hoverPos.text, capitalized);

    // Personal dictionary is the fast path — no API call needed
    const inPersonalDict = getPersonalDict()[hoverPos.strippedText.toLowerCase()] === 1;
    if (inPersonalDict) return defaults();

    // Ask the synonyms API: if the word is known it is correctly spelled
    const response = await provideSynonyms(hoverPos.strippedText);
    if (response.type !== 'error') return defaults();

    // Unknown word — show default actions + spelling suggestions from API
    const capitalization = getTextCapitalization(hoverPos.text);
    const suggestions: CodeAction[] = (response.suggestions ?? []).map(suggest => {
        const replaceText = transformToCapitalization(suggest, capitalization);
        return {
            title: `Replace with: '${replaceText}'`,
            kind: CodeActionKind.QuickFix,
            edit: {
                changes: {
                    [doc.uri]: [{ range: hoverRange, newText: replaceText }],
                },
            },
            command: {
                command: 'wt.autocorrections.wordReplaced',
                arguments: [hoverPos.text, replaceText],
                title: '',
            },
        } satisfies CodeAction;
    });

    return [...defaults(), ...suggestions];
}

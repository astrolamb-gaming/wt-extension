/**
 * wordWatcherAction.ts
 *
 * Server-side code action provider for the word-watcher feature.
 *
 * The client pushes a compiled regex pattern string that matches all
 * currently-watched words/phrases (via `wt/wordWatcherUpdate`).  When VS Code
 * requests code actions for a range, this provider tests the word under the
 * cursor against that pattern and — if it matches — offers a single quick-fix
 * that adds an exclusion for this particular occurrence.
 */
import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHoveredWord } from '../../util/hoveredWord';
import { getWordWatcherPattern } from '../../state/serverState';

export function wordWatcherCodeActions(doc: TextDocument, range: Range): CodeAction[] {
    const offset = doc.offsetAt(range.start);

    // Identify the word at the cursor position
    const hoverPos = getHoveredWord(doc, offset);
    if (!hoverPos) return [];

    // If there is no pattern, the user has no watched words configured
    const pattern = getWordWatcherPattern();
    if (!pattern) return [];

    // Test the word against the compiled pattern; guard against malformed regex
    try {
        const regex = new RegExp(pattern, 'gi');
        if (!regex.test(hoverPos.text)) return [];
    } catch {
        // Pattern is invalid (should not normally happen since the client
        // validates it before pushing, but be defensive)
        return [];
    }

    // The word matches a watched word — offer to exclude this occurrence
    return [
        {
            title: `Add word watcher exclusion for: '${hoverPos.text}'`,
            kind: CodeActionKind.QuickFix,
            command: {
                title: 'Add Word Watcher Exclusion',
                command: 'wt.wordWatcher.addExclusion',
                arguments: [hoverPos.text],
            },
        },
    ];
}

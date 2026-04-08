import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHoveredWord } from '../../util/hoveredWord';
import { getWordWatcherPattern } from '../../state/serverState';

export function wordWatcherCodeActions(doc: TextDocument, range: Range): CodeAction[] {
    const text = doc.getText();
    const offset = doc.offsetAt(range.start);
    const hoverPos = getHoveredWord(text, offset);
    if (!hoverPos) return [];

    const pattern = getWordWatcherPattern();
    if (!pattern) return [];

    try {
        const regex = new RegExp(pattern, 'gi');
        if (!regex.test(hoverPos.text)) return [];
    } catch {
        return [];
    }

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

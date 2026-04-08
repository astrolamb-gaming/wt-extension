/**
 * autocorrectAction.ts
 *
 * Server-side code action provider for autocorrect underlines.
 *
 * The client pushes the full set of active autocorrect corrections to the server
 * via the `wt/autocorrectUpdate` notification (see serverState.ts).  When VS Code
 * requests code actions for a range that overlaps one of those corrections, this
 * provider returns three quick-fix actions:
 *
 *   1. An informational label showing what happened ("Corrected from 'teh'").
 *   2. "Revert this correction" — reverts the replacement AND records an exclusion
 *      so the same instance is not corrected again.
 *   3. "Stop correcting X → Y" — permanently removes the rule from corrections.
 *
 * Actions 2 and 3 include a WorkspaceEdit that reverts the text, plus a command
 * that updates the client-side exclusion/corrections state.
 */
import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver/node';
import { getAutocorrectCorrections } from '../../state/serverState';

/**
 * Returns true when LSP ranges `a` and `b` have any character overlap.
 * Used to decide whether a correction's underline falls within the requested range.
 */
function rangesOverlap(a: Range, b: Range): boolean {
    if (a.end.line < b.start.line) return false;
    if (a.end.line === b.start.line && a.end.character <= b.start.character) return false;
    if (b.end.line < a.start.line) return false;
    if (b.end.line === a.start.line && b.end.character <= a.start.character) return false;
    return true;
}

/**
 * Returns autocorrect code actions whose underline range overlaps `range` in
 * the document identified by `uri`.
 *
 * Special-character swap entries (e.g. " → ") are excluded because they do
 * not have meaningful "revert / stop" actions.
 */
export function autocorrectCodeActions(uri: string, range: Range): CodeAction[] {
    // Look up the corrections for this specific document URI
    const docCorrections = getAutocorrectCorrections()[uri];
    if (!docCorrections) return [];

    // The client-side wt.autocorrections.wordExcluded command expects a plain
    // filename, not a full URI, so extract the basename here.
    const fileName = uri.substring(uri.lastIndexOf('/') + 1);
    const actions: CodeAction[] = [];

    for (const entry of Object.values(docCorrections)) {
        // Skip special-character swaps — no user-visible rule to revert / stop
        if (entry.kind === 'specialCharacterSwap') continue;
        // Skip corrections whose underline doesn't cover the requested range
        if (!rangesOverlap(entry.range, range)) continue;

        // The edit that undoes the replacement (used by actions 2 and 3)
        const edit = {
            changes: { [uri]: [{ range: entry.range, newText: entry.original }] },
        };

        // Action 1: Informational label only — no edit/command
        actions.push({
            title: `Corrected from '${entry.original}'`,
            kind: CodeActionKind.QuickFix,
        });

        // Action 2: Revert the change and exclude this occurrence from future corrections
        actions.push({
            title: `Revert this correction`,
            command: { command: 'wt.autocorrections.wordExcluded', arguments: [entry.original, fileName], title: '' },
            edit,
            kind: CodeActionKind.QuickFix,
        });

        // Action 3: Revert and remove the correction rule entirely
        actions.push({
            title: `Stop correcting '${entry.original}' \u2192 '${entry.corrected}'`,
            command: { command: 'wt.autocorrections.stopCorrecting', arguments: [entry.original], title: '' },
            edit,
            kind: CodeActionKind.QuickFix,
        });
    }

    return actions;
}

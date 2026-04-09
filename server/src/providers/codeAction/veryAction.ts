/**
 * veryAction.ts
 *
 * Server-side code action provider for the "very <word>" writing-style check.
 * Powered by losethevery.com, which suggests stronger replacements for phrases
 * like "very happy" → "ecstatic".
 *
 * Flow:
 *   1. `findVerySpans(text)` scans the full document for "very <word>" patterns.
 *   2. If the cursor range overlaps a span, `queryVery(word)` fetches the site.
 *   3. The response HTML is parsed with jsdom (with a regex fallback if jsdom
 *      is unavailable), yielding a list of synonym suggestions.
 *   4. Each suggestion is offered as a replacement QuickFix action.
 *
 * Results are memoised per word for the lifetime of the server process.
 * `null` in the memo means the query failed; an array means it succeeded.
 */
import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenizeDocument } from '../../semanticTokens/semanticTokens';
import { capitalize, stripDiacritics } from '../../util/textUtils';

type VerySpan = { startOff: number; endOff: number; veryText: string };

/**
 * Scans the token stream for all "very <word>" spans.
 *
 * A span is only counted when a `word` token whose text is "very" is
 * immediately followed by a single-character `whitespace` token and then
 * another `word` token, all on the same line.  Using tokens is consistent
 * with semantic highlighting and naturally handles contractions.
 */
function findVerySpans(doc: TextDocument): VerySpan[] {
    const tokens = tokenizeDocument(doc);
    const text   = doc.getText();
    const spans: VerySpan[] = [];

    for (let i = 0; i < tokens.length - 2; i++) {
        const veryTok = tokens[i];
        if (veryTok.type !== 'word') continue;

        const veryStart = doc.offsetAt({ line: veryTok.line, character: veryTok.startChar });
        const veryWord  = text.substring(veryStart, veryStart + veryTok.length);
        if (veryWord.toLowerCase() !== 'very') continue;

        // Must be followed immediately by a single space on the same line
        const wsTok = tokens[i + 1];
        if (wsTok.type !== 'whitespace' || wsTok.line !== veryTok.line || wsTok.length !== 1) continue;

        // Then a word token on the same line
        const nextTok = tokens[i + 2];
        if (nextTok.type !== 'word' || nextTok.line !== veryTok.line) continue;

        const nextStart = doc.offsetAt({ line: nextTok.line, character: nextTok.startChar });
        const nextEnd   = nextStart + nextTok.length;

        spans.push({
            startOff: veryStart,
            endOff:   nextEnd,
            veryText: text.substring(veryStart, nextEnd),
        });
    }

    return spans;
}

/** Returns true when the character ranges [aStart,aEnd) and [bStart,bEnd) share any characters. */
function offsetsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart < bEnd && bStart < aEnd;
}

/**
 * Memo cache for losethevery.com query results.
 *   `undefined` — not yet queried
 *   `null`      — query was attempted but failed
 *   `string[]`  — query succeeded; list of suggested replacements
 */
const alreadyObtained: Record<string, string[] | null> = {};

/**
 * Fetches losethevery.com for the given `word` and extracts the list of
 * suggested replacement words from the page HTML.
 *
 * Parsing strategy:
 *   1. Use jsdom if available in node_modules (full DOM traversal).
 *   2. Fall back to a lightweight <a>…</a> regex scan when jsdom is absent.
 *
 * Returns `null` on network / parse failure so the caller can show a fallback
 * "open in browser" action instead.
 */
async function queryVery(word: string): Promise<string[] | null> {
    const normalized = stripDiacritics(word);
    const url = `https://www.losethevery.com/another-word/very-${encodeURIComponent(normalized)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;

        const html = await resp.text();

        // Use jsdom if available; fall back to a lightweight regex scan
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { JSDOM } = require('jsdom') as typeof import('jsdom');
            const dom = new JSDOM(html);
            // The suggestions are anchor tags inside the first <div> inside <main>
            const main      = dom.window.document.querySelector('main');
            const container = main?.querySelector('div');
            const anchors   = container?.querySelectorAll('a');
            if (!anchors || anchors.length === 0) return null;
            return [...anchors].map((a: Element) => a.textContent?.trim().toLocaleLowerCase() ?? '').filter(Boolean);
        } catch {
            // jsdom not available — regex fallback: grab all <a> text nodes
            const matches = [...html.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)];
            const words = matches.map(m => m[1].trim().toLocaleLowerCase()).filter(Boolean);
            return words.length > 0 ? words : null;
        }
    } catch {
        return null;
    }
}

/** Fallback action shown when losethevery.com cannot be reached. */
const failureAction = (otherWord: string): CodeAction => ({
    title: 'Unable to query very synonyms: Open in a new browser?',
    isPreferred: true,
    command: {
        command: 'wt.very.openBrowser',
        title: 'Open Very Browser',
        arguments: [otherWord],
    },
    kind: CodeActionKind.QuickFix,
});

export async function veryCodeActions(doc: TextDocument, range: Range): Promise<CodeAction[]> {
    const actionStartOff = doc.offsetAt(range.start);
    const actionEndOff   = doc.offsetAt(range.end);

    // Find all "very <word>" spans in the document and check whether the
    // cursor overlaps any of them
    const spans = findVerySpans(doc);
    const hit = spans.find(s => offsetsOverlap(s.startOff, s.endOff, actionStartOff, actionEndOff));
    if (!hit) return [];

    const [veryWord, otherWord] = hit.veryText.split(' ');

    // Serve from memo cache if we already attempted this word
    if (alreadyObtained[otherWord] === null) return [failureAction(otherWord)];

    // Query losethevery.com (or use the cached result)
    const synonyms = alreadyObtained[otherWord] ?? (await queryVery(otherWord));
    alreadyObtained[otherWord] = synonyms;

    if (!synonyms) return [failureAction(otherWord)];

    // The replacement should cover the entire "very <word>" span
    const veryRange: Range = {
        start: doc.positionAt(hit.startOff),
        end:   doc.positionAt(hit.endOff),
    };

    // Preserve the capitalisation of "very" (e.g. "Very" at start of sentence)
    return synonyms.map(suggest => {
        const suggestedWord = veryWord === 'Very' ? capitalize(suggest) : suggest;
        return {
            title: `Replace with: '${suggestedWord}'`,
            kind: CodeActionKind.QuickFix,
            edit: {
                changes: {
                    [doc.uri]: [{ range: veryRange, newText: suggestedWord }],
                },
            },
        } satisfies CodeAction;
    });
}

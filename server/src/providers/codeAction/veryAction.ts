import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHoveredWord } from '../../util/hoveredWord';
import { capitalize, stripDiacritics } from '../../util/textUtils';

type VerySpan = { startOff: number; endOff: number; veryText: string };

/**
 * Scans raw document text for all "very <word>" spans.
 * Mirrors VeryIntellisense.update() but operates purely on a string.
 */
function findVerySpans(text: string): VerySpan[] {
    const stops = /[\.\?,\s\;'":\(\)\{\}\[\]\/\\\-!\*_]/g;
    const spans: VerySpan[] = [];

    let startOff: number;
    let endOff = -1;
    let match: RegExpExecArray | null;

    while ((match = stops.exec(text)) !== null) {
        startOff = endOff + 1;
        endOff = match.index;

        if (Math.abs(startOff - endOff) <= 1) continue;

        const word = text.substring(startOff, endOff).toLocaleLowerCase();
        if (word !== 'very') continue;
        if (text[endOff] !== ' ') continue;
        if (!text[endOff + 1]?.match(/[A-Za-z]/)) continue;

        const otherWordResult = getHoveredWord(text, endOff + 1);
        if (!otherWordResult) continue;

        spans.push({
            startOff,
            endOff:   otherWordResult.end,
            veryText: text.substring(startOff, otherWordResult.end),
        });
    }

    return spans;
}

function offsetsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart < bEnd && bStart < aEnd;
}

// Simple memoisation: null means "query failed", string[] means "succeeded"
const alreadyObtained: Record<string, string[] | null> = {};

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
            const main      = dom.window.document.querySelector('main');
            const container = main?.querySelector('div');
            const anchors   = container?.querySelectorAll('a');
            if (!anchors || anchors.length === 0) return null;
            return [...anchors].map((a: Element) => a.textContent?.trim().toLocaleLowerCase() ?? '').filter(Boolean);
        } catch {
            // jsdom not available — regex fallback
            const matches = [...html.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)];
            const words = matches.map(m => m[1].trim().toLocaleLowerCase()).filter(Boolean);
            return words.length > 0 ? words : null;
        }
    } catch {
        return null;
    }
}

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
    const text = doc.getText();

    const actionStartOff = doc.offsetAt(range.start);
    const actionEndOff   = doc.offsetAt(range.end);

    const spans = findVerySpans(text);
    const hit = spans.find(s => offsetsOverlap(s.startOff, s.endOff, actionStartOff, actionEndOff));
    if (!hit) return [];

    const [veryWord, otherWord] = hit.veryText.split(' ');

    // Check memo cache
    if (alreadyObtained[otherWord] === null) return [failureAction(otherWord)];

    const synonyms = alreadyObtained[otherWord] ?? (await queryVery(otherWord));
    alreadyObtained[otherWord] = synonyms;

    if (!synonyms) return [failureAction(otherWord)];

    const veryRange: Range = {
        start: doc.positionAt(hit.startOff),
        end:   doc.positionAt(hit.endOff),
    };

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

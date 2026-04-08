/**
 * hoveredWord.ts
 *
 * Pure-string port of the word-boundary scanner in src/intellisense/common.ts.
 * Operates on a raw document string + a numeric character offset rather than on
 * VS Code's TextDocument / Position objects, so it can run inside the language
 * server without any VS Code API dependency.
 */

export type HoverPosition = {
    /** Inclusive start offset of the word in the document string. */
    start: number;
    /** Exclusive end offset of the word in the document string. */
    end: number;
    /** The original word text, preserving diacritics and casing. */
    text: string;
    /** The word with diacritics stripped (used for dictionary lookups). */
    strippedText: string;
};

/** Strips combining diacritical marks (accents, umlauts, etc.) from a string. */
function stripDiacritics(text: string): string {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Given raw document text and a character offset, returns the word that spans
 * that offset (stopping at punctuation / whitespace boundaries).
 *
 * Mirrors the logic in src/intellisense/common.ts but operates on a plain
 * string + numeric offset rather than a vscode.TextDocument + vscode.Position.
 */
export function getHoveredWord(text: string, off: number): HoverPosition | null {
    // Characters that act as word boundaries
    const stops = /[\.\?,\s\;'":\(\)\{\}\[\]\/\\\-!\*_]/;

    const char = text[off];

    let start: number | undefined;
    let end: number | undefined;
    let goBack = true;  // whether to scan left for the word start
    let goLeft = true;  // whether to scan right for the word end

    // If the cursor is sitting directly on a stop character, decide which
    // adjacent word (if any) should be returned.
    if (stops.test(char)) {
        let beforeStops = false;
        if (off !== 0) {
            beforeStops = stops.test(text[off - 1]);
        }
        let afterStops = false;
        if (off !== text.length - 1) {
            afterStops = stops.test(text[off + 1]);
        }

        if (!beforeStops) {
            // Non-stop char is immediately to the left — use the left word.
            goLeft = false;
            end = off;
        } else if (!afterStops) {
            // Non-stop char is immediately to the right — use the right word.
            goBack = false;
            start = off + 1;
        } else {
            // Stop chars on both sides — the cursor is between words; nothing to hover.
            return null;
        }
    }

    // Scan left until a stop character (or the document start) to find the word start.
    if (goBack) {
        let current = off - 1;
        while (text[current] && !stops.test(text[current])) {
            current -= 1;
        }
        start = current + 1;
        goBack = false;
    }

    // Scan right until a stop character (or the document end) to find the word end.
    if (goLeft) {
        let current = off + 1;
        while (text[current] && !stops.test(text[current])) {
            current += 1;
        }
        end = current;
        goLeft = false;
    }

    if (goBack || goLeft || !start || !end) return null;

    // If the character immediately before this token is an apostrophe, it is a
    // contraction suffix (e.g. "ve" in "I've", "ll" in "we'll", "d" in "he'd").
    // Treat it as a non-word so providers don't flag it as misspelled.
    const precedingChar = text[start - 1] ?? '';
    const originalText = text.substring(start, end);
    if (/['''`]/.test(precedingChar) && /^(ve|d|s|ll|re|m|t)$/i.test(originalText)) return null;

    const strippedText = stripDiacritics(originalText);
    return { start, end, text: originalText, strippedText };
}

export type HoverPosition = {
    start: number;
    end: number;
    text: string;
    strippedText: string;
};

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
    const stops = /[\.\?,\s\;'":\(\)\{\}\[\]\/\\\-!\*_]/;

    const char = text[off];

    let start: number | undefined;
    let end: number | undefined;
    let goBack = true;
    let goLeft = true;

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
            goLeft = false;
            end = off;
        } else if (!afterStops) {
            goBack = false;
            start = off + 1;
        } else {
            return null;
        }
    }

    if (goBack) {
        let current = off - 1;
        while (text[current] && !stops.test(text[current])) {
            current -= 1;
        }
        start = current + 1;
        goBack = false;
    }

    if (goLeft) {
        let current = off + 1;
        while (text[current] && !stops.test(text[current])) {
            current += 1;
        }
        end = current;
        goLeft = false;
    }

    if (goBack || goLeft || !start || !end) return null;

    const originalText = text.substring(start, end);
    const strippedText = stripDiacritics(originalText);
    return { start, end, text: originalText, strippedText };
}

/**
 * hoveredWord.ts
 *
 * Token-based word lookup for hover, completion, and code-action providers.
 * Uses the same tokenizer as the semantic-tokens provider so word boundaries
 * are consistent across all features. Apostrophes between letters are treated
 * as part of the word (e.g. "I've" is one token), so contraction suffixes are
 * never seen as standalone words.
 *
 * A per-document cache (keyed by URI + document version) avoids re-tokenizing
 * on every hover or code-action request.
 */
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Token, tokenizeDocument } from '../semanticTokens/semanticTokens';

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

/** Per-document raw token cache to avoid re-tokenizing on every hover/completion/code-action. */
const rawTokenCache = new Map<string, { version: number; tokens: Token[] }>();

/**
 * Given a TextDocument and a character offset, returns the word token that
 * spans that offset, or null if the cursor is on whitespace, punctuation, or
 * a marker character.
 *
 * Word boundaries are determined by the semantic tokenizer, which already
 * handles apostrophes inside words (e.g. contractions like "I've") correctly.
 */
export function getHoveredWord(doc: TextDocument, offset: number): HoverPosition | null {
    // Re-use cached tokens when the document hasn't changed.
    let cached = rawTokenCache.get(doc.uri);
    if (!cached || cached.version !== doc.version) {
        cached = { version: doc.version, tokens: tokenizeDocument(doc) };
        rawTokenCache.set(doc.uri, cached);
    }

    const pos = doc.positionAt(offset);

    // Find the word token that covers the given line/character position.
    // Tokens are emitted in document order so a linear scan is fine here.
    const tok = cached.tokens.find(
        t => t.type === 'word' &&
             t.line === pos.line &&
             t.startChar <= pos.character &&
             t.startChar + t.length > pos.character
    );
    if (!tok) return null;

    const start = doc.offsetAt({ line: tok.line, character: tok.startChar });
    const end   = start + tok.length;
    const text  = doc.getText().substring(start, end);
    return { start, end, text, strippedText: stripDiacritics(text) };
}

/**
 * textUtils.ts
 *
 * Pure-string text utilities used by server-side providers.
 * Mirrors equivalent helpers in src/miscTools/help.ts without any VS Code
 * API dependency so they can run inside the language server process.
 */

/**
 * `'firstLetter'`      — only the first character is capitalised  (e.g. "Hello")
 * `'titleCase'`        — first letter of each major word is capitalised (e.g. "The Quick Fox")
 * `'allCaps'`          — every character is upper-case  (e.g. "HELLO")
 * `'noCapFrFrOnGod'`   — no capitalisation at all  (e.g. "hello")
 */
export type Capitalization = 'firstLetter' | 'titleCase' | 'allCaps' | 'noCapFrFrOnGod';

/** Strips combining diacritical marks (accents, umlauts, etc.) from a string. */
export function stripDiacritics(text: string): string {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Uppercases only the first character of a string, leaving the rest unchanged. */
export function capitalize(str: string): string {
    if (!str) return str;
    return str[0].toLocaleUpperCase() + str.substring(1);
}

/**
 * Common English articles, conjunctions, and prepositions that should remain
 * lower-case in title-case text unless they appear at the start of a phrase.
 */
const titleCaseExceptions = /^(a|the|and|as|at|but|by|down|for|from|if|in|into|like|near|nor|of|off|on|once|onto|or|over|past|so|than|that|to|upon|when|with|yet)([\.\?\:\;,\(\)!\&\s\+\-\n"'\^_*~]|$)/;

/**
 * Detects the capitalisation pattern of a string by examining each character.
 * Returns the most specific Capitalization variant that fits.
 */
export function getTextCapitalization(text: string): Capitalization {
    let cap: Capitalization = 'noCapFrFrOnGod';
    let capCount = 0;
    let startOfWord = true;
    let wordCount = 1;
    let capitalizedFirstLetterCount = 0;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (/\W/.test(char)) {
            // Non-word character — treat as a word boundary and count toward capCount
            if (!startOfWord) wordCount++;
            capCount++;
            startOfWord = true;
            continue;
        }
        if (/[A-Z]/.test(char) || (startOfWord && titleCaseExceptions.exec(text.substring(i))?.index === 0 && i !== 0)) {
            // Mark first-letter capitalisation the first time we encounter it
            if (i === 0) cap = 'firstLetter';
            if (startOfWord) capitalizedFirstLetterCount++;
            capCount++;
        }
        startOfWord = false;
    }

    // Promote to allCaps or titleCase when the counts support it
    if (capCount === text.length) {
        cap = 'allCaps';
    } else if (capitalizedFirstLetterCount === wordCount && wordCount > 1) {
        cap = 'titleCase';
    }
    return cap;
}

/**
 * Re-capitalises `input` to match the supplied `capitalization` pattern.
 * Used to preserve the original casing of a word when substituting a synonym.
 */
export function transformToCapitalization(input: string, capitalization: Capitalization): string {
    switch (capitalization) {
        case 'allCaps':        return input.toUpperCase();
        case 'firstLetter':    return capitalize(input.toLocaleLowerCase());
        case 'titleCase':      return capitalizeAll(input.toLocaleLowerCase());
        case 'noCapFrFrOnGod': return input.toLocaleLowerCase();
    }
}

/** Title-cases a lower-cased string, skipping common exception words mid-phrase. */
function capitalizeAll(str: string): string {
    if (!str) return str;
    let result = '';
    let startOfWord = true;
    for (const char of str) {
        if (/\W/.test(char)) {
            result += char;
            startOfWord = true;
        } else if (startOfWord) {
            result += char.toLocaleUpperCase();
            startOfWord = false;
        } else {
            result += char;
        }
    }
    return result;
}

export type Capitalization = 'firstLetter' | 'titleCase' | 'allCaps' | 'noCapFrFrOnGod';

export function stripDiacritics(text: string): string {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function capitalize(str: string): string {
    if (!str) return str;
    return str[0].toLocaleUpperCase() + str.substring(1);
}

const titleCaseExceptions = /^(a|the|and|as|at|but|by|down|for|from|if|in|into|like|near|nor|of|off|on|once|onto|or|over|past|so|than|that|to|upon|when|with|yet)([\.\?\:\;,\(\)!\&\s\+\-\n"'\^_*~]|$)/;

export function getTextCapitalization(text: string): Capitalization {
    let cap: Capitalization = 'noCapFrFrOnGod';
    let capCount = 0;
    let startOfWord = true;
    let wordCount = 1;
    let capitalizedFirstLetterCount = 0;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (/\W/.test(char)) {
            if (!startOfWord) wordCount++;
            capCount++;
            startOfWord = true;
            continue;
        }
        if (/[A-Z]/.test(char) || (startOfWord && titleCaseExceptions.exec(text.substring(i))?.index === 0 && i !== 0)) {
            if (i === 0) cap = 'firstLetter';
            if (startOfWord) capitalizedFirstLetterCount++;
            capCount++;
        }
        startOfWord = false;
    }

    if (capCount === text.length) {
        cap = 'allCaps';
    } else if (capitalizedFirstLetterCount === wordCount && wordCount > 1) {
        cap = 'titleCase';
    }
    return cap;
}

export function transformToCapitalization(input: string, capitalization: Capitalization): string {
    switch (capitalization) {
        case 'allCaps':        return input.toUpperCase();
        case 'firstLetter':    return capitalize(input.toLocaleLowerCase());
        case 'titleCase':      return capitalizeAll(input.toLocaleLowerCase());
        case 'noCapFrFrOnGod': return input.toLocaleLowerCase();
    }
}

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

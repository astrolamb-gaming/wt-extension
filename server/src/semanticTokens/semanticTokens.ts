import { TextDocument } from "vscode-languageserver-textdocument";
import { integer, SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver";

export const TOKEN_TYPES = [
	'word',        // 0
	'whitespace',  // 1
	'punctuation', // 2
	'marker'       // 3
] as const;

export const TOKEN_MODIFIERS = [
	'italics',        // 0
	'bold',           // 1
	'underline',      // 2
	'strikethrough'   // 3
] as const;



interface Token {
    line: number;
    startChar: number;
    length: number;
    type: string;
	modifiers?: string[];
}


/**
 * Tokenize a document into semantic tokens based on text styling markers.
 * Scans for matching pairs of style markers (*, ^, _, ~) and creates tokens.
 */
function tokenizeDocument(document: TextDocument): Token[] {
    const tokens: Token[] = [];
    const text = document.getText();

	const markerToModifier: Record<string, string> = {
		"*": "italics",
		"^": "bold",
		"_": "underline",
		"~": "strikethrough"
	};

	const activeModifiers = new Set<string>();
	const orderedModifiers = [...TOKEN_MODIFIERS];

	const isAlphaNum = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);
	const isInWordApostrophe = (index: number): boolean => {
		if (text[index] !== "'") {
			return false;
		}

		const prev = index > 0 ? text[index - 1] : "";
		const next = index + 1 < text.length ? text[index + 1] : "";
		return isAlphaNum(prev) && isAlphaNum(next);
	};
	const isWhitespace = (char: string): boolean => /\s/u.test(char) && char !== "\n" && char !== "\r";
	const sameModifiers = (left: string[], right: string[]): boolean => left.length === right.length && left.every((value, idx) => value === right[idx]);

	let line = 0;
	let col = 0;
	let runStartCol: number | null = null;
	let runType: string | null = null;
	let runModifiers: string[] = [];

	const emitRun = (runEndCol: number) => {
		if (runStartCol === null || runType === null) {
			return;
		}

		const length = runEndCol - runStartCol;
		if (length <= 0) {
			runStartCol = null;
			runModifiers = [];
			return;
		}
		tokens.push({
			line,
			startChar: runStartCol,
			length,
			type: runType,
			modifiers: runModifiers
		});

		runStartCol = null;
		runType = null;
		runModifiers = [];
	};

	const getActiveModifiers = (): string[] => orderedModifiers.filter((modifier) => activeModifiers.has(modifier));

	const startOrExtendRun = (charType: string, modifiers: string[]) => {
		if (runStartCol === null || runType === null) {
			runStartCol = col;
			runType = charType;
			runModifiers = modifiers;
			return;
		}

		if (runType !== charType || !sameModifiers(runModifiers, modifiers)) {
			emitRun(col);
			runStartCol = col;
			runType = charType;
			runModifiers = modifiers;
		}
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\r") {
			continue;
		}

		if (char === "\n") {
			emitRun(col);
			line += 1;
			col = 0;
			continue;
		}

		if (char in markerToModifier) {
			const modifier = markerToModifier[char];
			const isClosingMarker = activeModifiers.has(modifier);
			const markerModifiers = getActiveModifiers();
			if (!isClosingMarker && !markerModifiers.includes(modifier)) {
				markerModifiers.push(modifier);
			}

			startOrExtendRun("marker", markerModifiers);

			if (isClosingMarker) {
				activeModifiers.delete(modifier);
			} else {
				activeModifiers.add(modifier);
			}

			col += 1;
			continue;
		}

		const charType = (isAlphaNum(char) || isInWordApostrophe(i))
			? "word"
			: isWhitespace(char)
				? "whitespace"
				: "punctuation";
		const modifiers = getActiveModifiers();
		if (modifiers.length > 0 || charType !== "word") {
			startOrExtendRun(charType, modifiers);
		} else {
			emitRun(col);
		}

		col += 1;
	}

	emitRun(col);

    return tokens;
}

/**
 * Build empty semantic tokens (for error cases)
 */
export function getEmptySemanticTokens(): SemanticTokens {
	return new SemanticTokensBuilder().build();
}

/**
 * Converts TokenInfo array to SemanticTokens format for LSP
 */
export function buildSemanticTokens(tokens: Token[]): SemanticTokens {
	const builder = new SemanticTokensBuilder();

	for (const token of tokens) {
		const typeIndex = TOKEN_TYPES.indexOf(token.type as any);
		if (typeIndex === -1) {
			console.log(`Unknown token type: ${token.type}`);
			continue;
		}

		let modifierBits = 0;
		for (const modifier of token.modifiers ?? []) {
			const modifierIndex = TOKEN_MODIFIERS.indexOf(modifier as any);
			if (modifierIndex !== -1) {
				modifierBits |= (1 << modifierIndex);
			}
		}

		builder.push(
			token.line,
			token.startChar,
			token.length,
			typeIndex,
			modifierBits
		);
	}

	return builder.build();
}

/**
 * Tokenize a document and return semantic tokens for LSP
 * Combines tokenizeDocument() and buildSemanticTokens()
 * Also returns raw tokens for delta computation
 */
export function getSemanticTokens(document: TextDocument): SemanticTokens {
	const tokens = tokenizeDocument(document);
	return buildSemanticTokens(tokens);
}

/**
 * Caching layer for semantic tokens to avoid re-tokenizing unchanged documents
 * Uses a version-based caching strategy with delta support
 */
export class SemanticTokensCache {
	private cache: Map<string, {
		version: integer;
		tokens: SemanticTokens;
		rawTokens: Token[];
		resultId: string;
		timestamp: number;
	}> = new Map();

	private maxCacheSize: integer = 10; // Cache at most 10 documents
	private cacheLifetime: number = 5 * 60 * 1000; // 5 minutes in milliseconds
	private resultIdCounter: integer = 0;

	/**
	 * Generate a unique result ID for a cached token set
	 */
	private generateResultId(): string {
		return `resultId_${++this.resultIdCounter}`;
	}

	/**
	 * Get cached tokens if available and still valid
	 * @returns Cached tokens or null if not available/invalid
	 */
	public get(uri: string, currentVersion: integer): SemanticTokens | null {
		const entry = this.cache.get(uri);
		
		if (!entry) {
			return null;
		}

		// Check if version matches and cache hasn't expired
		if (entry.version === currentVersion && 
		    Date.now() - entry.timestamp < this.cacheLifetime) {
			console.log(`Cache hit for ${uri} (v${currentVersion})`);
			return entry.tokens;
		}

		// Cache is stale
		this.cache.delete(uri);
		return null;
	}

	/**
	 * Compute delta between previous and current tokens
	 * Returns either a delta or full tokens if comparison fails
	 */
	public getDelta(uri: string, previousResultId: string | undefined, currentTokens: SemanticTokens) {
		const entry = this.cache.get(uri);

		// If no previous state or result ID doesn't match, return full tokens
		if (!entry || !previousResultId || entry.resultId !== previousResultId) {
			return currentTokens;
		}

		// For now, return full tokens to ensure correctness
		// Delta computation is complex and requires careful tracking
		return currentTokens;
	}

	/**
	 * Store tokens in cache with raw token data for delta computation
	 */
	public set(uri: string, version: integer, tokens: SemanticTokens, rawTokens?: Token[]): void {
		// Implement simple LRU eviction if cache is full
		if (this.cache.size >= this.maxCacheSize) {
			const oldestUri = this.cache.keys().next().value;
			if (oldestUri) {
				this.cache.delete(oldestUri);
				console.log(`Evicted cache entry for ${oldestUri}`);
			}
		}

		const resultId = this.generateResultId();
		this.cache.set(uri, {
			version,
			tokens,
			rawTokens: rawTokens ?? [],
			resultId,
			timestamp: Date.now()
		});
		console.log(`Cached semantic tokens for ${uri} (v${version}, resultId: ${resultId})`);
	}

	/**
	 * Invalidate cache entry when document is closed
	 */
	public invalidate(uri: string): void {
		if (this.cache.has(uri)) {
			this.cache.delete(uri);
			console.log(`Invalidated cache for ${uri}`);
		}
	}

	/**
	 * Clear entire cache
	 */
	public clear(): void {
		this.cache.clear();
		this.resultIdCounter = 0;
		console.log('Cleared semantic tokens cache');
	}

	/**
	 * Get cache statistics (for console.logging)
	 */
	public getStats() {
		return {
			size: this.cache.size,
			maxSize: this.maxCacheSize,
			entries: Array.from(this.cache.keys())
		};
	}
}

// Global cache instance
let globalCache: SemanticTokensCache | null = null;

/**
 * Get the global semantic tokens cache instance
 */
export function getSemanticTokensCache(): SemanticTokensCache {
	if (!globalCache) {
		globalCache = new SemanticTokensCache();
	}
	return globalCache;
}

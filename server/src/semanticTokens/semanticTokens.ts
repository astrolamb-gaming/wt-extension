import { TextDocument } from "vscode-languageserver-textdocument";
import { connection, documents } from "../server";
import { integer, SemanticTokens, SemanticTokensBuilder, SemanticTokensParams } from "vscode-languageserver";

export const TOKEN_TYPES = [
	'italics',          // 0
	'bold',             // 1
	'underline',        // 2
	'strikethrough',    // 3
	'link'             // 4
] as const;

export const TOKEN_MODIFIERS = [
	'declaration',    // 0
	'definition',     // 1
	'readonly',       // 2
	'reference'       // 3
] as const;



interface Token {
    line: number;
    startChar: number;
    length: number;
    type: string;
    modifier?: string;
}

/**
 * Style patterns that map to semantic token types
 * Patterns define opening/closing characters for text styles
 */
const stylePatterns: Record<string, RegExp> = {
    'italics': /\*/g,          // *text*
    'bold': /\^/g,             // ^text^
    'underline': /_/g,         // _text_
    'strikethrough': /~/g,     // ~text~
};

/**
 * Tokenize a document into semantic tokens based on text styling markers.
 * Scans for matching pairs of style markers (*, ^, _, ~) and creates tokens.
 */
function tokenizeDocument(document: TextDocument): Token[] {
    const tokens: Token[] = [];
    const text = document.getText();
    
    // Replace escape sequences and special cases with non-matching placeholders
    // Use same-length replacements to keep positions aligned
    const sanitizedText = text
        .replaceAll("~~~", "@@@")                    // Triple tilde (visual separator)
        .replaceAll(/\\\*|\\^|\\~|\\_/g, "@@");     // Escaped style markers
    
    // Process each style type independently
    for (const [styleType, pattern] of Object.entries(stylePatterns)) {
        // Find all positions where the marker occurs
        const matchPositions: number[] = [];
        let match;
        const regexWithoutG = new RegExp(pattern.source);
        
        while ((match = pattern.exec(sanitizedText)) !== null) {
            matchPositions.push(match.index);
        }
        
        // Handle odd number of matches: extend last range to end of document
        if (matchPositions.length % 2 !== 0) {
            matchPositions.push(sanitizedText.length - 1);
        }
        
        // Pair opening/closing markers and create tokens for ranges
        for (let i = 0; i < matchPositions.length - 1; i += 2) {
            const startPos = matchPositions[i];
            const endPos = matchPositions[i + 1];
            
            // Convert character positions to line/column for each boundary
            const startLine = document.positionAt(startPos).line;
            const startChar = document.positionAt(startPos).character;
            const endLine = document.positionAt(endPos).line;
            const endChar = document.positionAt(endPos).character;
            
            // Create tokens for multi-line ranges (one token per line)
            if (startLine === endLine) {
                // Single line: one token for the entire range
                tokens.push({
                    line: startLine,
                    startChar: startChar,
                    length: endChar - startChar + 1,
                    type: styleType,
                });
            } else {
                // Multi-line: create tokens for each line in the range
                // Opening line: from startChar to end of line
                const startLineLength = document.getText(
                    { start: { line: startLine, character: 0 }, end: { line: startLine + 1, character: 0 } }
                ).length - 1; // -1 for newline
                tokens.push({
                    line: startLine,
                    startChar: startChar,
                    length: startLineLength - startChar + 1,
                    type: styleType,
                });
                
                // Middle lines
                for (let line = startLine + 1; line < endLine; line++) {
                    const lineLength = document.getText(
                        { start: { line: line, character: 0 }, end: { line: line + 1, character: 0 } }
                    ).length - 1;
                    if (lineLength > 0) {
                        tokens.push({
                            line: line,
                            startChar: 0,
                            length: lineLength,
                            type: styleType,
                        });
                    }
                }
                
                // Closing line: from start to endChar
                tokens.push({
                    line: endLine,
                    startChar: 0,
                    length: endChar + 1,
                    type: styleType,
                });
            }
        }
    }
    
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
		// Keep string tokens available to server-side analyzers, but do not
		// emit them in the semantic token stream returned to the client.
		if (token.type === 'string') {
			continue;
		}
		const typeIndex = TOKEN_TYPES.indexOf(token.type as any);
		if (typeIndex === -1) {
			console.log(`Unknown token type: ${token.type}`);
			continue;
		}

		const modifierIndex = token.modifier 
			? TOKEN_MODIFIERS.indexOf(token.modifier as any)
			: 0;

		builder.push(
			token.line,
			token.startChar,
			token.length,
			typeIndex,
			modifierIndex === -1 ? 0 : (1 << modifierIndex)
		);
	}

	return builder.build();
}

/**
 * Tokenize a document and return semantic tokens for LSP
 * Combines tokenizeDocument() and buildSemanticTokens()
 */
export function getSemanticTokens(document: TextDocument): SemanticTokens {
	const tokens = tokenizeDocument(document);
	return buildSemanticTokens(tokens);
}

/**
 * Caching layer for semantic tokens to avoid re-tokenizing unchanged documents
 * Uses a version-based caching strategy
 */
export class SemanticTokensCache {
	private cache: Map<string, {
		version: integer;
		tokens: SemanticTokens;
		timestamp: number;
	}> = new Map();

	private maxCacheSize: integer = 10; // Cache at most 10 documents
	private cacheLifetime: number = 5 * 60 * 1000; // 5 minutes in milliseconds

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
	 * Store tokens in cache
	 */
	public set(uri: string, version: integer, tokens: SemanticTokens): void {
		// Implement simple LRU eviction if cache is full
		if (this.cache.size >= this.maxCacheSize) {
			const oldestUri = this.cache.keys().next().value;
			if (oldestUri) {
				this.cache.delete(oldestUri);
				console.log(`Evicted cache entry for ${oldestUri}`);
			}
		}

		this.cache.set(uri, {
			version,
			tokens,
			timestamp: Date.now()
		});
		console.log(`Cached semantic tokens for ${uri} (v${version})`);
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

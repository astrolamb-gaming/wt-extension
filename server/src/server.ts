/**
 * server.ts
 *
 * Entry point for the wt Language Server.
 *
 * This file wires together the LSP connection, the text-document manager, and
 * all request/notification handlers.  The server runs in a separate Node.js
 * process and communicates with the VS Code extension host (client) over IPC.
 *
 * Capabilities advertised to the client:
 *   • hover              — synonym definitions / personal-dictionary notice
 *   • completion         — synonym suggestions or spelling-correction items
 *   • codeAction         — synonyms, "very <word>", word-watcher, autocorrect
 *   • semanticTokens     — custom token types for wt syntax highlighting
 *   • inlineCompletion   — (reserved for future use)
 *
 * Push-based state:
 *   The extension host pushes snapshots of personal dictionary, word-watcher
 *   pattern, API config, and autocorrect underlines via custom notifications
 *   (see protocol/notifications.ts and state/serverState.ts).
 */
import {
	createConnection,
	DidChangeConfigurationNotification,
	InitializeParams,
	InitializeResult,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
	SemanticTokensParams,
	TextDocumentPositionParams,
	Hover,
	CompletionItem,
	CompletionItemKind,
	CodeActionParams,
	CodeAction,
	TextEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getSemanticTokens, TOKEN_TYPES, TOKEN_MODIFIERS, getEmptySemanticTokens, getSemanticTokensCache } from './semanticTokens/semanticTokens';
import { registerStateHandlers } from './state/serverState';
import { getHoveredWord } from './util/hoveredWord';
import { getHoverMarkdown, provideSynonyms } from './util/synonymsClient';
import { capitalize, getTextCapitalization, transformToCapitalization } from './util/textUtils';
import { synonymsCodeActions } from './providers/codeAction/synonymsAction';
import { veryCodeActions } from './providers/codeAction/veryAction';
import { wordWatcherCodeActions } from './providers/codeAction/wordWatcherAction';
import { autocorrectCodeActions } from './providers/codeAction/autocorrectAction';

// Create the IPC connection, enabling all proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);

// Manages open text documents and exposes their latest content to handlers.
export const documents = new TextDocuments(TextDocument);

// Client capability flags set during onInitialize; consulted by some handlers.
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;


connection.onInitialize((params: InitializeParams) => {
	// These are only executed on startup

	const capabilities = params.capabilities;
	
	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	// Whether diagnostics can include related information (secondary locations).
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);
	if (capabilities.workspace && capabilities.workspace.configuration) {
		capabilities.workspace.configuration;
	}

	const result: InitializeResult = {
		capabilities: {
			// Synchronise document content incrementally (smallest diff units).
			textDocumentSync: TextDocumentSyncKind.Incremental,
			hoverProvider: true,
			completionProvider: { triggerCharacters: [] },
			codeActionProvider: true,
			inlineCompletionProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: TOKEN_TYPES as unknown as string[],
                    tokenModifiers: TOKEN_MODIFIERS as unknown as string[]
                },
                range: false,
                full: true  // provide full token set per request (no delta support yet)
            } as any
		}
	};

	if (params.workspaceFolders) {

	} else {
		console.log("No Workspace folders");
	}
	return result;
});

connection.onInitialized(async () => {

	console.log("Language ServerInitialized");
	
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
});

// Register handlers for client→server state pushes (personal dict, word watcher, config, autocorrect)
registerStateHandlers(connection);


//#region Completion Provider
// Returns synonym completion items for a known word, or spelling-suggestion
// items (plus "add to dictionary" / "create notebook note" actions) for an
// unknown word.  Only fires for .wt files.
connection.onCompletion(async (params: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> => {
	if (!params?.textDocument.uri.endsWith('.wt')) return undefined;

	const doc = documents.get(params.textDocument.uri);
	if (!doc) return undefined;

	const offset = doc.offsetAt(params.position);
	const hoverPos = getHoveredWord(doc, offset);
	if (!hoverPos || hoverPos.strippedText.length === 0) return [];

	const hoverRange = { start: doc.positionAt(hoverPos.start), end: doc.positionAt(hoverPos.end) };
	const wordText   = hoverPos.text;

	const response = await provideSynonyms(hoverPos.strippedText);

	if (response.type === 'error') {
		// Unknown word — offer spelling suggestions + dictionary actions
		const wordCap = capitalize(wordText);
		const maxDigits = Math.max((response.suggestions?.length ?? 0).toString().length, 1);
		const misspellItems: CompletionItem[] = (response.suggestions ?? []).map((suggest, i) => ({
			label:      suggest,
			textEdit:   TextEdit.replace(hoverRange, suggest),
			filterText: wordText,
			sortText:   i.toString().padStart(maxDigits, '0'),
			command: { command: 'wt.autocorrections.wordReplaced', arguments: [wordText, suggest], title: '' },
		}));

		return [
			{
				label:      `Add ${wordCap} to personal dictionary`,
				textEdit:   TextEdit.replace(hoverRange, wordText),
				filterText: wordText,
				sortText:   '0000!',
				preselect:  true,
				command: { command: 'wt.personalDictionary.add', arguments: [wordText], title: '' },
			},
			{
				label:      `Create new notebook note for '${wordCap}'`,
				textEdit:   TextEdit.replace(hoverRange, wordText),
				filterText: wordText,
				sortText:   '0000!',
				command: { command: 'wt.notebook.addNote', arguments: [wordCap], title: '' },
			},
			{
				label:      `Add '${wordCap}' as new alias for existing note`,
				textEdit:   TextEdit.replace(hoverRange, wordText),
				filterText: wordText,
				sortText:   '0000!',
				command: { command: 'wt.notebook.addAliasToNote', arguments: [wordCap], title: '' },
			},
			...misspellItems,
		];
	}

	// Known word — offer all synonyms across all definitions
	// Each definition gets a header item (non-inserting) followed by its synonyms.
	// sortText is constructed as "defIndex!!synIndex" so items group by definition.
	const wordCapitalization = getTextCapitalization(hoverPos.strippedText);
	const items: CompletionItem[] = [];
	const inserted: Record<string, true> = {};

	response.definitions.forEach((def, defIdx) => {
		const defMaxDigits = response.definitions.length.toString().length;
		const defIndexStr  = defIdx.toString().padStart(defMaxDigits, '0');

		// Definition header item (non-replacing)
		items.push({
			label:       `(${def.part}) ${def.definitions[0]}`,
			filterText:  wordText,
			textEdit:    TextEdit.replace(hoverRange, wordText),
			detail:      `(${def.synonyms.length} synonyms)`,
			sortText:    `${defIndexStr}!!header`,
			kind:        CompletionItemKind.Folder,
		});

		const synMaxDigits = def.synonyms.length.toString().length;
		def.synonyms.forEach((syn, synIdx) => {
			// Strip parenthetical disambiguators like "run (in baseball)" before inserting
			const insertText = syn.split('(')[0].trim();
			if (inserted[insertText]) return;  // skip exact-duplicate insert text
			inserted[insertText] = true;

			const displayText = transformToCapitalization(syn,        wordCapitalization);
			const insertWith  = transformToCapitalization(insertText, wordCapitalization);

			items.push({
				label:      displayText,
				filterText: wordText,
				textEdit:   TextEdit.replace(hoverRange, insertWith),
				detail:     `[${def.definitions[0]}]`,
				sortText:   `${defIndexStr}!!${synIdx.toString().padStart(synMaxDigits, '0')}`,
				kind:       CompletionItemKind.Event,
			});
		});
	});

	return items;
});
//#endregion


//#region Hover Provider
// Returns a Markdown hover card showing the word's synonyms and first definition
// per part of speech.  Only fires for .wt files.
connection.onHover(async (params: TextDocumentPositionParams): Promise<Hover | undefined> => {
	if (!params?.textDocument.uri.endsWith('.wt')) return undefined;

	const doc = documents.get(params.textDocument.uri);
	if (!doc) return undefined;

	const offset = doc.offsetAt(params.position);
	const hoverPos = getHoveredWord(doc, offset);
	if (!hoverPos) return undefined;

	const markdown = await getHoverMarkdown(hoverPos.strippedText);
	if (!markdown) return undefined;

	return {
		contents: { kind: 'markdown', value: markdown },
		range: {
			start: doc.positionAt(hoverPos.start),
			end:   doc.positionAt(hoverPos.end),
		},
	};
});
//#endregion


//#region Code Action Provider
// Runs all four sub-providers in parallel and concatenates their results.
// Only fires for .wt files.
connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[]> => {
	if (!params?.textDocument.uri.endsWith('.wt')) return [];

	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];

	const [synonyms, very, wordWatcher, autocorrect] = await Promise.all([
		synonymsCodeActions(doc, params.range),
		veryCodeActions(doc, params.range),
		Promise.resolve(wordWatcherCodeActions(doc, params.range)),
		Promise.resolve(autocorrectCodeActions(params.textDocument.uri, params.range)),
	]);

	return [...synonyms, ...very, ...wordWatcher, ...autocorrect];
});
//#endregion


//#region Semantic Tokens Provider
// Computes full semantic token sets for custom wt syntax highlighting.
// Results are also stored in a cache keyed by (uri, version) to avoid
// redundant recomputation when the document hasn't changed.
connection.languages.semanticTokens.on((params: SemanticTokensParams) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return getEmptySemanticTokens();
	}
	const cache = getSemanticTokensCache();
	// This is where the semantic tokens are computed and cached.
	const tokens = getSemanticTokens(document);
	cache.set(document.uri, document.version, tokens);
	return tokens;
});
//#endregion


// Note: Delta handler commented due to LSP library version limitations
// The cache infrastructure supports delta computation via getDelta() method
// when delta support becomes available through library updates

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
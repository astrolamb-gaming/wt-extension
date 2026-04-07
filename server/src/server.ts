import { createConnection, DidChangeConfigurationNotification, InitializeParams, InitializeResult, ProposedFeatures, TextDocuments, TextDocumentSyncKind, SemanticTokensRequest, SemanticTokensParams, TextDocumentPositionParams, Hover, CompletionItem, DocumentDiagnosticParams, DocumentDiagnosticReport, DocumentDiagnosticReportKind, Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getSemanticTokens, TOKEN_TYPES, TOKEN_MODIFIERS, getEmptySemanticTokens, getSemanticTokensCache } from './semanticTokens/semanticTokens';
import { get } from 'http';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
export const documents = new TextDocuments(TextDocument);

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
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			inlineCompletionProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: TOKEN_TYPES as unknown as string[],
                    tokenModifiers: TOKEN_MODIFIERS as unknown as string[]
                },
                range: false,
                full: true
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

//#region Diagnostics Provider
connection.languages.diagnostics.on(async (params:DocumentDiagnosticParams): Promise<DocumentDiagnosticReport> => {
	let diagnostics: Diagnostic[] = [];
	// Add diagnostics here.
	const ret = {
		kind: DocumentDiagnosticReportKind.Full,
		items: diagnostics
	} satisfies DocumentDiagnosticReport;
	return ret;
});
//#endregion


//#region Completion Provider
connection.onCompletion(async (_textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> => {
	const completionItems: CompletionItem[] = [];
	// Add items here.
	return completionItems;
});
//#endregion


//#region Hover Provider
connection.onHover(async (_textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined> => {
	// This is where hover information would be computed and returned.
	if (!_textDocumentPosition || !_textDocumentPosition.textDocument.uri.endsWith('.wt')) {
		return undefined;
	}
	const hover: Hover = {
		contents: {
			kind: 'markdown',
			value: 'Hover information goes here'
		}
	};
	return hover;
});
//#endregion


//#region Semantic Tokens Provider
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
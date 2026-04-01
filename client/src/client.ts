import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import * as path from 'path';

let client: LanguageClient;


export function activateLanguageServerClient(context: vscode.ExtensionContext, clientOptions?: LanguageClientOptions) {
    console.log("Language server started");
    // Start the language server logic here
    const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		}
	};

    if (!clientOptions) {
        // Options to control the language client
        clientOptions = {
            // Register the server for plain text documents
            documentSelector: [{ scheme: 'file', language: 'wt' },{scheme:'file',language:'json'}],
            synchronize: {
                // Notify the server about file changes to '.clientrc files contained in the workspace
                fileEvents: [
                    vscode.workspace.createFileSystemWatcher('**/*.wt'),
                    vscode.workspace.createFileSystemWatcher('**/*.json')
                ]
            }
        };
	}

    // Initialize the language client
    client = new LanguageClient(
        'wt-lsp',
        'wt-lsp',
        serverOptions,
        clientOptions
    );

    // Start the LSP client so requests (including semantic tokens) flow to the server.
    // context.subscriptions.push(client.start());
    client.start();

}

import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import * as path from 'path';

// Notification method strings — kept in sync with server/src/protocol/notifications.ts
const WT_PERSONAL_DICT_UPDATE = 'wt/personalDictionaryUpdate';
const WT_WORD_WATCHER_UPDATE  = 'wt/wordWatcherUpdate';
const WT_CONFIG_UPDATE        = 'wt/configUpdate';
const WT_AUTOCORRECT_UPDATE   = 'wt/autocorrectUpdate';

type SynonymProviderType = 'wh' | 'synonymsApi';

let client: LanguageClient;

/** Notifications sent before the server is ready are queued here and flushed on ready. */
const pendingNotifications: Array<{ method: string; params: unknown }> = [];
let serverReady = false;

/**
 * Low-level notification helper — safe to call before the server has finished
 * initialising; messages are queued and flushed when the server signals readiness.
 */
export function sendClientNotification(method: string, params: unknown): void {
    if (serverReady && client) {
        client.sendNotification(method, params);
    } else {
        pendingNotifications.push({ method, params });
    }
}

/** Push the full personal dictionary to the language server. */
export function sendPersonalDictionaryUpdate(dict: Record<string, 1>): void {
    sendClientNotification(WT_PERSONAL_DICT_UPDATE, { dict });
}

/** Push the current word-watcher regex pattern string to the language server. */
export function sendWordWatcherUpdate(pattern: string | null): void {
    sendClientNotification(WT_WORD_WATCHER_UPDATE, { pattern });
}

/** Push all active autocorrect corrections to the server for diagnostics and code actions. */
export function sendAutocorrectUpdate(corrections: Record<string, Record<string, {
    kind: 'correction' | 'specialCharacterSwap';
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    original: string;
    corrected: string;
    nodeLabel: string;
}>>): void {
    sendClientNotification(WT_AUTOCORRECT_UPDATE, { corrections });
}

async function getCurrentSynonymsProvider(): Promise<SynonymProviderType> {
    try {
        const provider = await vscode.commands.executeCommand('wt.intellisense.synonyms.getCurrentProvider');
        if (provider === 'wh' || provider === 'synonymsApi') {
            return provider;
        }
    } catch {
        // Command may not be registered yet during early activation.
    }
    return 'synonymsApi';
}

/** Push current synonyms provider + API settings to the language server. */
export function sendSynonymsConfigUpdate(provider?: SynonymProviderType): void {
    void (async () => {
        const config = vscode.workspace.getConfiguration();
        const activeProvider = provider ?? (await getCurrentSynonymsProvider());
        sendClientNotification(WT_CONFIG_UPDATE, {
            apiKey:        config.get<string>('wt.synonyms.apiKey')        ?? null,
            cacheLocation: config.get<string>('wt.synonyms.cacheLocation') ?? null,
            provider:      activeProvider,
        });
    })();
}

/**
 * Called whenever the language server responds with hover markdown.
 * Register a callback here to update UI (e.g. the definitions panel webview).
 */
let onHoverResultCallback: ((markdown: string) => void) | null = null;
export function setHoverResultCallback(cb: ((markdown: string) => void) | null): void {
    onHoverResultCallback = cb;
}


export function activateLanguageServerClient(context: vscode.ExtensionContext, clientOptions?: LanguageClientOptions) {
    console.log("Language server started");

    const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	const serverOptions: ServerOptions = {
		run:   { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc },
	};

    if (!clientOptions) {
        clientOptions = {
            documentSelector: [{ scheme: 'file', language: 'wt' }, { scheme: 'file', language: 'json' }],
            synchronize: {
                fileEvents: [
                    vscode.workspace.createFileSystemWatcher('**/*.wt'),
                    vscode.workspace.createFileSystemWatcher('**/*.json'),
                ],
            },
            middleware: {
                // Intercept the server's hover response:
                // 1. Pass the result through so VS Code still shows the tooltip.
                // 2. Forward the markdown to any registered callback (e.g. definitions panel).
                provideHover: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    if (result && onHoverResultCallback) {
                        const rawContents = result.contents;
                        const contentsArray = Array.isArray(rawContents) ? rawContents : [rawContents];
                        const md = contentsArray
                            .map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? '')
                            .filter(Boolean)
                            .join('\n\n');
                        if (md) onHoverResultCallback(md);
                    }
                    return result;
                },
            },
        };
	}

    client = new LanguageClient(
        'wt-lsp',
        'wt-lsp',
        serverOptions,
        clientOptions!
    );

    // start() returns a Promise<void> in vscode-languageclient v9
    client.start().then(() => {
        serverReady = true;

        // Flush queued notifications (personalDict / wordWatcher may have been
        // pushed before the server finished initialising)
        for (const notif of pendingNotifications) {
            client.sendNotification(notif.method, notif.params);
        }
        pendingNotifications.length = 0;

        // Push current synonyms config (provider + API key + cache location)
        sendSynonymsConfigUpdate();
    });

    // Re-push config whenever the user changes relevant settings
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('wt.synonyms')) return;
            sendSynonymsConfigUpdate();
        })
    );
}


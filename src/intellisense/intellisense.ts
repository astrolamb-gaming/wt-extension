import * as vscode from 'vscode';
import { Workspace } from '../workspace/workspaceClass';
import * as console from '../miscTools/vsconsole';
import { CompletionItemProvider } from './synonyms/completionItemProvider';
import { HoverProvider } from './synonyms/hoverProvider';
import { CodeActionProvider } from './synonyms/codeActionProvider';
import { PersonalDictionary } from './spellcheck/personalDictionary';
import { SynonymsProvider } from './synonymsProvider/provideSynonyms';
import { rootPath } from '../extension';
import { statFile } from '../miscTools/help';

export class SynonymsIntellisense {
    constructor (
        private context: vscode.ExtensionContext,
        private workspace: Workspace,
        private personalDictionary: PersonalDictionary,
        private useWordHippo: boolean,
    ) {
    }

    public async init () {
        await SynonymsProvider.init(this.workspace);

        // CompletionItemProvider is no longer registered as a VS Code completion provider
        // (completions are now handled by the language server), but its constructor
        // registers commands (e.g. wt.intellisense.synonyms.getCurrentProvider) that are
        // still used by keybindings and other features.
        new CompletionItemProvider(this.context, this.workspace, this.useWordHippo);

        this.registerCommands();
    }

    registerCommands() {
        this.context.subscriptions.push(vscode.commands.registerCommand('wt.synonyms.getSynonyms', () => {
            // TODO    
        }));
    }
}
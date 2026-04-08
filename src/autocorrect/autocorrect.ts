import * as vscode from 'vscode';
import * as vscodeUri from 'vscode-uri';
import { Timed } from '../timedView';
import { DiskContextType, Workspace } from '../workspace/workspaceClass';
import { PersonalDictionary } from '../intellisense/spellcheck/personalDictionary';
import { Packageable } from '../packageable';
import { getAllIndices, getTextCapitalization, stripDiacritics, transformToCapitalization, vagueNodeSearch } from '../miscTools/help';
import { ExtensionGlobals } from '../extension';
import { OutlineNode } from '../outline/nodes_impl/outlineNode';
import { report } from 'process';
import { sendAutocorrectUpdate } from '../../client/out/client';
export const commonReplacements = {
    '”': '"',
    '“': '"',
    '‘': "'",
    '’': "'",
    '‛': "'",
    '‟': '"',
    '…': '...',
    '—': ' -- ',
    '–': ' -- ',
    '­': '',
    ' ': ' ',
};

const UNDERLINE_TIMER = 5 * 1000; // ms

type UriFileName = string;
type IncorrectWord = string;
type CorrectedWord = string;
type UnderlineIdentifier = string;
type HowMany = number;

type CorrectionKind = 'correction' | 'specialCharacterSwap';


export class Autocorrect implements Timed, Packageable<"wt.autocorrections.exclusions" | "wt.autocorrections.corrections" | "wt.autocorrections.dontCorrect"> {
    private static BlueUnderline: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        overviewRulerColor: 'royalblue',
        borderStyle: 'none none dashed none',
        borderColor: 'royalblue',
    });

    private corrections: { [index: IncorrectWord]: CorrectedWord };
    private dontCorrect: { [index: IncorrectWord]: CorrectedWord[] };
    private exclusions:  { [index: UriFileName]: {
        [index: IncorrectWord]: HowMany;            // Tells us how many times we should ignore 
    } };
    private specialCharactersSearch: RegExp;

    // Keyed by full document URI string (uri.toString())
    private allCorrections: { [uriString: string]: {
        [id: string]: {
            kind: CorrectionKind;
            range: vscode.Range;
            original: string; 
            corrected: string;
            nodeLabel: string;
        }
    } } = {};

    private notificationActive: {
        token: vscode.CancellationTokenSource,
        saveAutocorrect: boolean | null,
    } | null = null;
    async askToCorrect (original: string, correction: string) {
        if (!this.enabled) return;
        original = original.toLocaleLowerCase();

        // Do not ask again if the user has already denied autocorrecting for this (word, correction) combination beforeprod
        if (this.dontCorrect[original]?.find(word => word === correction)) {
            return;
        }


        const tokenSource = new vscode.CancellationTokenSource();
        this.notificationActive = {
            token: tokenSource,
            saveAutocorrect: false
        };

        
        const notificationPromise: Thenable<boolean | null> = vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Correction completed!`,
        }, async (progress) => {
            return new Promise((resolve, reject) => {

                // Display message to save the autocorrect
                const reportSave = () => {
                    progress.report({
                        message: `Hit alt+enter to save '${original}' -> '${correction}' as a permanent auto-correction . . . `
                    });
                };

                // Display message to refuse the autocorrect
                const reportRefuse = () => {
                    progress.report({
                        message: `Hit alt+x to never save '${original}' -> '${correction}' as a permanent auto-correction . . . `
                    });
                }

                // Start with the save message
                reportSave();

                // Create an interval to alternate between the save and refuse
                //      messages every 2 seconds
                let idx = 0;
                const interval = setInterval(() => {
                    if (idx % 2 !== 0) reportSave();
                    else reportRefuse();
                    idx++;
                }, 2000);

                // If no choice has been made after 20 seconds, return `null` to indicate
                //      neither a save nor a refusal
                const timeout = setTimeout(() => {
                    clearInterval(interval);
                    resolve(null);
                }, 20000);

                // Otherwise if the cancellation token was triggered, clear the timeout and the interval
                //      and return the response from the key binding that was entered 
                // (This occurs when the user activates either 'wt.autocorrections.acceptAutocorrect' or
                //      'wt.autocorrections.rejectAutocorrect', which "cancels" the token with a response true or false
                //      see the bodies of those function below for more info)
                tokenSource.token.onCancellationRequested(() => {
                    if (!this.notificationActive || this.notificationActive.saveAutocorrect === null) return;
                    clearInterval(interval);
                    clearTimeout(timeout);
                    resolve(this.notificationActive.saveAutocorrect);
                });
            });
        });

        const saveAutocorrect: boolean | null = await notificationPromise;
        this.notificationActive = null;
        tokenSource.dispose();

        if (saveAutocorrect === true) {
            this.corrections[original] = correction;
            Workspace.updateContext(this.context, "wt.autocorrections.corrections", this.corrections);
        }
        else if (saveAutocorrect === false) {
            if (this.dontCorrect[original]) {
                this.dontCorrect[original].push(correction);
            }
            else {
                this.dontCorrect[original] = [ correction ];
            }
            Workspace.updateContext(this.context, "wt.autocorrections.dontCorrect", this.dontCorrect);
        }

        // saveAutocorrect === null -> time elapsed without a response
        else if (saveAutocorrect === null) {}
    }


    private async createUnderliner (uri: vscode.Uri, original: string, replacement: string, replacedRange: vscode.Range, correctionKind: CorrectionKind='correction') {

        const fileName = vscodeUri.Utils.basename(uri);
        const uriString = uri.toString();

        // Query for the node representing this document to get its label
        // Label is used in the diagnostic to show where it came from
        let label: string;
        const { node: nodeOrNote, source } = await vagueNodeSearch(uri);
        if (!nodeOrNote || !source) {
            label = fileName;
        }
        else {
            const node: { data: { ids: { display: string } } } = nodeOrNote instanceof OutlineNode ?
                nodeOrNote : { data: { ids: { display: nodeOrNote!.title } } };
            label = node.data.ids.display;
        }
        
        const id = Math.random().toString(); 
        if (!this.allCorrections[uriString]) {
            this.allCorrections[uriString] = {};
        }
        
        this.allCorrections[uriString][id] = {
            kind: correctionKind,
            corrected: replacement,
            original: original,
            range: replacedRange,
            nodeLabel: label
        };
        this.pushToServer();

        setTimeout(() => {
            // After the underline timer elapses, remove the entry entirely
            delete this.allCorrections[uriString]?.[id];

            // If a visible text editor exists for this document, then update it to remove the blue
            //      underline visually
            for (const visible of vscode.window.visibleTextEditors) {
                if (visible.document.uri.fsPath === uri.fsPath) {
                    this.update(visible, []);
                    break;
                }
            }
            this.pushToServer();
        }, UNDERLINE_TIMER);
    }

    async tryCorrection (original: string, editor: vscode.TextEditor, range: vscode.Range): Promise<boolean> {
        const capitalization = getTextCapitalization(original);
        
        const stripped = stripDiacritics(original.toLocaleLowerCase());
        const replacementRaw = this.corrections[stripped];
        if (!replacementRaw) return false;
        if (!this.enabled) return false;
        
        const replacement = transformToCapitalization(replacementRaw, capitalization);
        
        const documentFileName = vscodeUri.Utils.basename(editor.document.uri);
        if (this.exclusions[documentFileName]?.[stripped]) {
            const instancesOfOriginal = getAllIndices(editor.document.getText(), stripped);
            for (let index = 0; index < instancesOfOriginal.length; index++) {
                const instanceStartIndex = instancesOfOriginal[index];
                if (instanceStartIndex === editor.document.offsetAt(range.start)) {
                    if (index < this.exclusions[documentFileName][stripped]) {
                        return false;
                    }
                }
            }
        }

        const success = await editor.edit((eb) => {
            eb.replace(range, replacement);
        });
        if (!success) return false;
        
        // Can't use original range because the replacement word may not be the same size as the original word
        // The replacement range is used for blue underline so it needs to fit under the replaced word
        const replacedRange = new vscode.Range(
            range.start,
            new vscode.Position(range.start.line, range.start.character + replacement.length)
        );
        this.createUnderliner(
            editor.document.uri, 
            original, replacement, 
            replacedRange,
        );

        this.update(editor, [])
        return true;
    }

    private wordExcluded (original: string, fileName: string, range: vscode.Range) {

        const stripped = stripDiacritics(original);

        if (this.exclusions[fileName]) {
            if (this.exclusions[fileName][stripped]) {
                this.exclusions[fileName][stripped]++;
            }
            else {
                this.exclusions[fileName][stripped] = 1;
            }
        }
        else {
            this.exclusions[fileName] = {
                [stripped]: 1
            };
        }
        Workspace.updateContext(this.context, "wt.autocorrections.exclusions", this.exclusions);
    }
    
    private stopCorrecting (original: string): any {
        const stripped = stripDiacritics(original);
        delete this.corrections[stripped];
        Workspace.updateContext(this.context, "wt.autocorrections.corrections", this.corrections);
    }
    
    enabled: boolean;
    async update (editor: vscode.TextEditor, commentedRanges: vscode.Range[]): Promise<void> {

        const docText = stripDiacritics(editor.document.getText());
        
        const specialCharacterEdits: [ vscode.Range, CorrectedWord ][] = [];

        let m: RegExpExecArray | null;
        while ((m = this.specialCharactersSearch.exec(docText)) !== null) {
            const original = m[0];
            const replacement = commonReplacements[m[0] as keyof typeof commonReplacements];
            const specialCharacterRange = new vscode.Range(
                editor.document.positionAt(m.index),
                editor.document.positionAt(m.index + original.length)
            );
            specialCharacterEdits.push([ specialCharacterRange, replacement ]);

            // KNOWN ISSUE:
            // Multiple autocorrections on the same line where one of the corrections
            //      is ' -- ' will result in this `replacementRange` appear
            //      visually incorrect with the blue underline
            const replacementRange = new vscode.Range(
                editor.document.positionAt(m.index),
                editor.document.positionAt(m.index + replacement.length)
            );

            this.createUnderliner(
                editor.document.uri, 
                original, replacement, 
                replacementRange, 
                'specialCharacterSwap'
            );
        }

        if (specialCharacterEdits.length > 0) {
            editor.edit(eb => {
                for (const [ range, replacement ] of specialCharacterEdits) {
                    eb.replace(range, replacement);
                }
            });
        }
        
        const uriString = editor.document.uri.toString();
        const decorations = Object.entries(this.allCorrections).map(([ docUri, corrections ]) => {
            if (docUri !== uriString) return [];
            return Object.entries(corrections).map(([ _, correctionData ]) => {
                // Do not show the underline if the replacement text no longer matches
                const currentText = editor.document.getText(correctionData.range);
                const replacedText = correctionData.corrected;
                if (stripDiacritics(currentText) !== stripDiacritics(replacedText)) {
                    return [];
                }
                return correctionData.range;
            }).flat();
        }).flat();
        return editor.setDecorations(Autocorrect.BlueUnderline, decorations);
    }

    getPackageItems() {
        return {
            "wt.autocorrections.exclusions": this.exclusions,
            "wt.autocorrections.corrections": this.corrections,
            "wt.autocorrections.dontCorrect": this.dontCorrect,
        }
    }

    /** Serialize allCorrections and push them to the language server for diagnostics and code actions. */
    pushToServer(): void {
        const corrections: Record<string, Record<string, {
            kind: CorrectionKind;
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            original: string;
            corrected: string;
            nodeLabel: string;
        }>> = {};
        for (const [uri, entries] of Object.entries(this.allCorrections)) {
            corrections[uri] = {};
            for (const [id, entry] of Object.entries(entries)) {
                corrections[uri][id] = {
                    kind: entry.kind,
                    range: {
                        start: { line: entry.range.start.line, character: entry.range.start.character },
                        end:   { line: entry.range.end.line,   character: entry.range.end.character },
                    },
                    original: entry.original,
                    corrected: entry.corrected,
                    nodeLabel: entry.nodeLabel,
                };
            }
        }
        sendAutocorrectUpdate(corrections);
    }

    registerCommands () {
        this.context.subscriptions.push(vscode.commands.registerCommand('wt.autocorrections.wordReplaced', (word: string, correction: string) => this.askToCorrect(word, correction)));
        this.context.subscriptions.push(vscode.commands.registerCommand('wt.autocorrections.wordExcluded', (original: string, fileName: string, range: vscode.Range) => this.wordExcluded(original, fileName, range)));
        this.context.subscriptions.push(vscode.commands.registerCommand('wt.autocorrections.stopCorrecting', (original: string) => this.stopCorrecting(original)));
        this.context.subscriptions.push(vscode.commands.registerCommand('wt.autocorrections.acceptAutocorrect', async () => {
            if (!this.notificationActive) return;
            this.notificationActive.saveAutocorrect = true;
            this.notificationActive.token.cancel();
        }));
        this.context.subscriptions.push(vscode.commands.registerCommand('wt.autocorrections.rejectAutocorrect', async () => {
            if (!this.notificationActive) return;
            this.notificationActive.saveAutocorrect = false;
            this.notificationActive.token.cancel();
        }));
    }

    constructor (
        private context: vscode.ExtensionContext,
        private workspace: Workspace
    ) {
        this.enabled = true;
        this.corrections = this.context.workspaceState.get<DiskContextType['wt.autocorrections.corrections']>('wt.autocorrections.corrections') || {};
        this.dontCorrect = this.context.workspaceState.get<DiskContextType['wt.autocorrections.dontCorrect']>('wt.autocorrections.dontCorrect') || {};
        this.exclusions = this.context.workspaceState.get<DiskContextType['wt.autocorrections.exclusions']>('wt.autocorrections.exclusions') || {};
        this.registerCommands();

        this.specialCharactersSearch = new RegExp(`(${Object.keys(commonReplacements).join("|")})`, 'g');
        this.context.subscriptions.push(Autocorrect.BlueUnderline);
    }

    getUpdatesAreVisible(): boolean {
        return true;
    }
}
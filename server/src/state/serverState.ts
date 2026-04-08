import { Connection } from 'vscode-languageserver/node';
import {
    WT_PERSONAL_DICT_UPDATE,
    WT_WORD_WATCHER_UPDATE,
    WT_CONFIG_UPDATE,
    PersonalDictUpdateParams,
    WordWatcherUpdateParams,
    ConfigUpdateParams,
} from '../protocol/notifications';

let personalDict: Record<string, 1> = {};
let wordWatcherPattern: string | null = null;
let synonymsApiKey: string | null = null;

export function getPersonalDict(): Record<string, 1> { return personalDict; }
export function getWordWatcherPattern(): string | null { return wordWatcherPattern; }
export function getSynonymsApiKey(): string | null { return synonymsApiKey; }

export function registerStateHandlers(connection: Connection): void {
    connection.onNotification(WT_PERSONAL_DICT_UPDATE, (params: PersonalDictUpdateParams) => {
        personalDict = params.dict;
    });
    connection.onNotification(WT_WORD_WATCHER_UPDATE, (params: WordWatcherUpdateParams) => {
        wordWatcherPattern = params.pattern;
    });
    connection.onNotification(WT_CONFIG_UPDATE, (params: ConfigUpdateParams) => {
        synonymsApiKey = params.apiKey;
    });
}

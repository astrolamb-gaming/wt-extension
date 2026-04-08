export const WT_PERSONAL_DICT_UPDATE = 'wt/personalDictionaryUpdate';
export const WT_WORD_WATCHER_UPDATE  = 'wt/wordWatcherUpdate';
export const WT_CONFIG_UPDATE        = 'wt/configUpdate';

export type PersonalDictUpdateParams = { dict: Record<string, 1> };
export type WordWatcherUpdateParams  = { pattern: string | null };
export type ConfigUpdateParams       = { apiKey: string | null; cacheLocation: string | null };

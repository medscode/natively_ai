// electron/services/SuggestionStore.ts
// Phase P: thin facade over DatabaseManager.insertSuggestion / getSuggestions.
// Persists every "done" event from the SuggestionPipeline so the chat-bubble
// history survives meeting end, app restart, and page refresh.
//
// Uses the same "live-meeting-current" virtual meeting ID convention that
// LiveRAGIndexer uses (the in-progress meeting has no real ID until end).

import type { DatabaseManager } from '../db/DatabaseManager';

export interface PersistedSuggestion {
    suggestionId: string;
    text: string;
    citations?: unknown[];
    source: 'live' | 'mock' | 'manual';
    firedAt: number;
    question?: string;
}

export class SuggestionStore {
    private db: DatabaseManager;

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    saveLiveSuggestion(meetingId: string, item: PersistedSuggestion): void {
        this.db.insertSuggestion(meetingId, item);
    }

    getSuggestionsForMeeting(meetingId: string): PersistedSuggestion[] {
        return this.db.getSuggestions(meetingId);
    }
}
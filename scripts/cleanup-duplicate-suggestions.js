#!/usr/bin/env node
// scripts/cleanup-duplicate-suggestions.js
// Cleans up fragmented streaming token rows from meeting_suggestions in natively.db.

'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Resolve database path
const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'natively');
const dbPath = path.join(userDataPath, 'natively.db');

if (!fs.existsSync(dbPath)) {
    console.log('[cleanup] No natively.db found at', dbPath);
    process.exit(0);
}

const Database = require('better-sqlite3');
const db = new Database(dbPath);

try {
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meeting_suggestions'`).get();
    if (!tableExists) {
        console.log('[cleanup] meeting_suggestions table does not exist.');
        process.exit(0);
    }

    const rows = db.prepare(`SELECT id, meeting_id, suggestion_id, text, fired_at FROM meeting_suggestions ORDER BY meeting_id, fired_at ASC`).all();
    console.log(`[cleanup] Found ${rows.length} total suggestion rows in database.`);

    const toDeleteIds = [];
    const meetingGroups = new Map();

    for (const row of rows) {
        if (!meetingGroups.has(row.meeting_id)) {
            meetingGroups.set(row.meeting_id, []);
        }
        meetingGroups.get(row.meeting_id).push(row);
    }

    for (const [meetingId, group] of meetingGroups) {
        for (let i = 0; i < group.length; i++) {
            const current = group[i];
            const curText = (current.text || '').trim();

            // Very short fragments (like "• I" or "Yes")
            if (curText.length < 15) {
                toDeleteIds.push(current.id);
                continue;
            }

            // Check if there is a longer entry that starts with or contains this text within the same meeting
            const hasLongerSuperset = group.some((other, oIdx) => {
                if (oIdx === i) return false;
                const oText = (other.text || '').trim();
                return oText.length > curText.length && (oText.startsWith(curText) || oText.includes(curText));
            });

            if (hasLongerSuperset) {
                toDeleteIds.push(current.id);
            }
        }
    }

    if (toDeleteIds.length > 0) {
        console.log(`[cleanup] Removing ${toDeleteIds.length} fragmented / prefix duplicate suggestion rows...`);
        const deleteStmt = db.prepare(`DELETE FROM meeting_suggestions WHERE id = ?`);
        const runTx = db.transaction((ids) => {
            for (const id of ids) {
                deleteStmt.run(id);
            }
        });
        runTx(toDeleteIds);
        console.log(`[cleanup] Successfully cleaned up ${toDeleteIds.length} duplicate rows. Remaining rows: ${rows.length - toDeleteIds.length}`);
    } else {
        console.log(`[cleanup] No fragmented duplicate rows found.`);
    }
} catch (err) {
    console.error('[cleanup] Error:', err);
} finally {
    db.close();
}

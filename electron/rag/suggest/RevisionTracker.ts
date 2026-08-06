// electron/rag/suggest/RevisionTracker.ts
// Monotonic revision counter for transcript updates. Every async work item
// (retrieval, LLM generation, topic-card lookup) carries the revision ID it
// started under; on completion, the caller checks `isStale()` before doing
// anything observable (rendering tokens, firing side-effects).
//
// This is the prerequisite for the event-driven polling replacement +
// streaming LLM call. Without it, a partial-then-revised transcript would
// let stale tokens reach the DOM and show wrong information.

export class RevisionTracker {
    private _current: number = 0;
    private readonly _listeners = new Set<(rev: number) => void>();

    /** Bump the revision. Called on every STT-final transcript update. */
    bump(): number {
        this._current += 1;
        const rev = this._current;
        for (const l of this._listeners) {
            try {
                l(rev);
            } catch {
                /* listener errors don't poison the rest */
            }
        }
        return rev;
    }

    /** Current revision. */
    get current(): number {
        return this._current;
    }

    /** Subscribe to revision bumps. Returns an unsubscribe fn. */
    onBump(fn: (rev: number) => void): () => void {
        this._listeners.add(fn);
        return () => {
            this._listeners.delete(fn);
        };
    }

    /** True if the given revision is no longer the current one. */
    isStale(rev: number): boolean {
        return rev < this._current;
    }

    /**
     * Wrap an async function so its return value is discarded if the
     * revision has advanced by the time the promise resolves. The wrapped
     * function still resolves (with `undefined`) so callers don't have to
     * handle rejections specially.
     */
    guard<T>(rev: number, fn: () => Promise<T>): Promise<T | undefined> {
        return fn().then((result) => {
            if (this.isStale(rev)) {
                return undefined;
            }
            return result;
        });
    }
}

// Module-scoped singleton — one revision stream per app instance.
let _instance: RevisionTracker | null = null;

export function getRevisionTracker(): RevisionTracker {
    if (!_instance) {
        _instance = new RevisionTracker();
    }
    return _instance;
}
import { useEffect, useState } from 'react';

type ResolvedTheme = 'light' | 'dark';

const THEME_CACHE_KEY = 'natively_resolved_theme';

const getResolvedTheme = (): ResolvedTheme =>
    document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

const applyResolvedTheme = (resolved: ResolvedTheme): void => {
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
};

const subscribers = new Set<(theme: ResolvedTheme) => void>();
let unsubscribeThemeChanged: (() => void) | null = null;
let themeObserver: MutationObserver | null = null;

const notifySubscribers = (theme: ResolvedTheme): void => {
    subscribers.forEach((subscriber) => subscriber(theme));
};

const ensureSharedThemeSubscription = (): void => {
    if (!themeObserver) {
        themeObserver = new MutationObserver(() => {
            notifySubscribers(getResolvedTheme());
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        });
    }

    if (!unsubscribeThemeChanged) {
        // electronAPI's getThemeMode returns { mode, resolved } where
        // resolved may include 'system' (auto). Our local `ResolvedTheme`
        // union is `'light' | 'dark'` only — we resolve 'system' to
        // 'light' or 'dark' by reading the actual DOM attribute set
        // by the main process.
        unsubscribeThemeChanged = window.electronAPI?.onThemeChanged?.(() => {
            applyResolvedTheme(getResolvedTheme());
        }) ?? null;
    }
};

const teardownSharedThemeSubscription = (): void => {
    themeObserver?.disconnect();
    themeObserver = null;
    unsubscribeThemeChanged?.();
    unsubscribeThemeChanged = null;
};

export const useResolvedTheme = (): ResolvedTheme => {
    const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => getResolvedTheme());

    useEffect(() => {
        ensureSharedThemeSubscription();
        subscribers.add(setResolvedTheme);
        setResolvedTheme(getResolvedTheme());

        return () => {
            subscribers.delete(setResolvedTheme);
            if (subscribers.size === 0) {
                teardownSharedThemeSubscription();
            }
        };
    }, []);

    return resolvedTheme;
};

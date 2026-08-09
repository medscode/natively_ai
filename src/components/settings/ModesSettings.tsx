/**
 * ModesSettings — Modes Manager UI
 *
 * Two-column layout:
 *   • Left: sidebar listing built-in templates + custom modes, with a "+ New Mode"
 *     button at the top and a "Natively Templates" footer link.
 *   • Right: detail pane for the selected mode — title + Set active toggle, an
 *     overflow menu (rename / delete), Real-time prompt textarea, Reference
 *     files upload, and Notes template section editor.
 *
 * Wired to the existing modes IPC surface (electronAPI.modesGetAll /
 * modesSetActive / modesUpdate / modesCreate / modesUploadReferenceFile /
 * modesAddNoteSection etc.). No premium submodule dependency.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    FileText,
    Plus,
    MoreHorizontal,
    Check,
    Upload,
    Trash2,
    Pencil,
    Layers,
    Save,
    X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';

// ─── Types mirroring the existing modes IPC ────────────────────────────────

type ModeTemplateType =
    | 'general'
    | 'looking-for-work'
    | 'sales'
    | 'recruiting'
    | 'team-meet'
    | 'lecture'
    | 'technical-interview'
    | 'lawyer';

interface ModeRow {
    id: string;
    name: string;
    templateType: ModeTemplateType | string;
    customContext: string;
    isActive: boolean;
    createdAt: string;
    referenceFileCount: number;
}

interface ReferenceFileRow {
    id: string;
    modeId: string;
    fileName: string;
    content: string;
    createdAt: string;
}

interface NoteSectionRow {
    id: string;
    modeId: string;
    title: string;
    description: string;
    sortOrder: number;
}

// Built-in template labels + icons. Custom modes render with the same icon.
const TEMPLATE_LABEL: Record<string, string> = {
    general: 'Co-Pilot',
    'looking-for-work': 'Looking for Work',
    sales: 'Sales Mode',
    recruiting: 'Recruiting',
    'team-meet': 'Team Meet',
    lecture: 'Lecture Mode',
    'technical-interview': 'Technical Interview',
    lawyer: 'Lawyer — Wills, Trusts, Deeds',
};

// Stable render order for the sidebar. Matches the order users will encounter
// the modes in (co-pilot first, then specialty templates, then lawyer).
const TEMPLATE_ORDER: ModeTemplateType[] = [
    'general',
    'technical-interview',
    'sales',
    'recruiting',
    'looking-for-work',
    'team-meet',
    'lecture',
    'lawyer',
];

// ─── Component ─────────────────────────────────────────────────────────────

export interface ModesSettingsProps {
    onClose?: () => void;
    isPremium?: boolean;
    isLoaded?: boolean;
    isTrialActive?: boolean;
    onOpenNativelyAPI?: () => void;
}

export const ModesSettings: React.FC<ModesSettingsProps> = ({
    onClose: _onClose,
    isPremium: _isPremium,
    isLoaded: _isLoaded,
    isTrialActive: _isTrialActive,
    onOpenNativelyAPI: _onOpenNativelyAPI,
}) => {
    const resolvedTheme = useResolvedTheme();
    const isLight = resolvedTheme === 'light';

    // ── State ────────────────────────────────────────────────────────────
    const [modes, setModes] = useState<ModeRow[]>([]);
    const [activeModeId, setActiveModeId] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Detail-pane state
    const [draftPrompt, setDraftPrompt] = useState('');
    const [savedPrompt, setSavedPrompt] = useState('');
    const [refFiles, setRefFiles] = useState<ReferenceFileRow[]>([]);
    const [sections, setSections] = useState<NoteSectionRow[]>([]);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [uploadingFile, setUploadingFile] = useState(false);
    const promptDirty = draftPrompt !== savedPrompt;
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // ── Load ────────────────────────────────────────────────────────────
    const refreshAll = useCallback(async () => {
        setError(null);
        try {
            const api: any = (window as any).electronAPI;
            const [all, active] = await Promise.all([api?.modesGetAll?.(), api?.modesGetActive?.()]);
            const rows: ModeRow[] = (all ?? []) as ModeRow[];
            setModes(rows);
            const activeRow = active as ModeRow | null;
            setActiveModeId(activeRow?.id ?? null);
            // Pick first selection: the active mode if any, else the General row, else the first row.
            setSelectedId((prev) => {
                if (prev && rows.some((r) => r.id === prev)) return prev;
                if (activeRow?.id && rows.some((r) => r.id === activeRow.id)) return activeRow.id;
                const general = rows.find((r) => r.templateType === 'general');
                if (general) return general.id;
                return rows[0]?.id ?? null;
            });
        } catch (e: any) {
            setError(e?.message || 'Failed to load modes');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshAll();
    }, [refreshAll]);

    // Load detail-pane data whenever the selection changes.
    useEffect(() => {
        const api: any = (window as any).electronAPI;
        if (!selectedId || !api) return;
        const row = modes.find((m) => m.id === selectedId);
        if (!row) return;
        setSavedPrompt(row.customContext ?? '');
        setDraftPrompt(row.customContext ?? '');
        setNameDraft(row.name);
        setEditingName(false);
        setOverflowOpen(false);
        // Reference files + note sections.
        (async () => {
            try {
                const [refs, secs] = await Promise.all([
                    api.modesGetReferenceFiles?.(selectedId),
                    api.modesGetNoteSections?.(selectedId),
                ]);
                setRefFiles((refs ?? []) as ReferenceFileRow[]);
                setSections((secs ?? []) as NoteSectionRow[]);
            } catch (e: any) {
                setError(e?.message || 'Failed to load mode details');
            }
        })();
    }, [selectedId, modes]);

    // ── Derived ─────────────────────────────────────────────────────────
    const selectedMode = useMemo(
        () => modes.find((m) => m.id === selectedId) ?? null,
        [modes, selectedId]
    );

    // Split modes: built-in template instances (always seeded at v11+) appear
    // first in TEMPLATE_ORDER; custom user modes (renamed templates or free-form
    // custom modes) follow sorted by createdAt desc.
    const orderedModes = useMemo(() => {
        const built: ModeRow[] = [];
        const custom: ModeRow[] = [];
        for (const t of TEMPLATE_ORDER) {
            const row = modes.find((m) => m.templateType === t);
            if (row) built.push(row);
        }
        for (const m of modes) {
            if (!TEMPLATE_ORDER.includes(m.templateType as ModeTemplateType)) {
                custom.push(m);
            }
        }
        custom.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return { built, custom };
    }, [modes]);

    // ── Mutations ───────────────────────────────────────────────────────
    const handleSetActive = useCallback(async () => {
        if (!selectedId) return;
        setBusy(true);
        setError(null);
        try {
            const api: any = (window as any).electronAPI;
            const targetId = activeModeId === selectedId ? null : selectedId;
            await api?.modesSetActive?.(targetId);
            setActiveModeId(targetId);
            await refreshAll();
        } catch (e: any) {
            setError(e?.message || 'Failed to set active mode');
        } finally {
            setBusy(false);
        }
    }, [selectedId, activeModeId, refreshAll]);

    const handleSavePrompt = useCallback(async () => {
        if (!selectedId) return;
        setBusy(true);
        setError(null);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesUpdate?.(selectedId, { customContext: draftPrompt });
            setSavedPrompt(draftPrompt);
            await refreshAll();
        } catch (e: any) {
            setError(e?.message || 'Failed to save prompt');
        } finally {
            setBusy(false);
        }
    }, [selectedId, draftPrompt, refreshAll]);

    const handleNewMode = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const api: any = (window as any).electronAPI;
            // Pick a fresh templateType not already used (custom mode = templateType='general').
            const used = new Set(modes.map((m) => m.templateType));
            const templateHint = TEMPLATE_ORDER.find((t) => !used.has(t)) ?? 'general';
            const result = await api?.modesCreate?.({
                name: 'New Mode',
                templateType: templateHint,
            });
            await refreshAll();
            if (result?.mode?.id) setSelectedId(result.mode.id);
        } catch (e: any) {
            setError(e?.message || 'Failed to create mode');
        } finally {
            setBusy(false);
        }
    }, [modes, refreshAll]);

    const handleDelete = useCallback(async () => {
        if (!selectedId) return;
        if (!window.confirm(`Delete "${selectedMode?.name ?? 'this mode'}"? This cannot be undone.`)) return;
        setBusy(true);
        setError(null);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesDelete?.(selectedId);
            await refreshAll();
        } catch (e: any) {
            setError(e?.message || 'Failed to delete mode');
        } finally {
            setBusy(false);
        }
    }, [selectedId, selectedMode, refreshAll]);

    const handleSaveName = useCallback(async () => {
        if (!selectedId) return;
        const next = nameDraft.trim();
        if (!next) {
            setEditingName(false);
            return;
        }
        setBusy(true);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesUpdate?.(selectedId, { name: next });
            await refreshAll();
            setEditingName(false);
        } catch (e: any) {
            setError(e?.message || 'Failed to rename mode');
        } finally {
            setBusy(false);
        }
    }, [selectedId, nameDraft, refreshAll]);

    const handleUploadFile = useCallback(async () => {
        if (!selectedId) return;
        const input = fileInputRef.current;
        if (!input) return;
        setUploadingFile(true);
        setError(null);
        try {
            const api: any = (window as any).electronAPI;
            // The IPC handler opens the OS file picker itself. We just trigger it.
            const result = await api?.modesUploadReferenceFile?.(selectedId);
            if (result?.success) {
                const refs = await api?.modesGetReferenceFiles?.(selectedId);
                setRefFiles((refs ?? []) as ReferenceFileRow[]);
                await refreshAll();
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to upload file');
        } finally {
            setUploadingFile(false);
        }
    }, [selectedId, refreshAll]);

    const handleDeleteRef = useCallback(async (refId: string) => {
        setBusy(true);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesDeleteReferenceFile?.(refId);
            if (selectedId) {
                const refs = await api?.modesGetReferenceFiles?.(selectedId);
                setRefFiles((refs ?? []) as ReferenceFileRow[]);
            }
            await refreshAll();
        } catch (e: any) {
            setError(e?.message || 'Failed to remove file');
        } finally {
            setBusy(false);
        }
    }, [selectedId, refreshAll]);

    const handleAddSection = useCallback(async () => {
        if (!selectedId) return;
        setBusy(true);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesAddNoteSection?.(selectedId, 'New section', 'Describe what should go here');
            const secs = await api?.modesGetNoteSections?.(selectedId);
            setSections((secs ?? []) as NoteSectionRow[]);
        } catch (e: any) {
            setError(e?.message || 'Failed to add section');
        } finally {
            setBusy(false);
        }
    }, [selectedId]);

    const handleUpdateSection = useCallback(async (id: string, updates: { title?: string; description?: string }) => {
        setBusy(true);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesUpdateNoteSection?.(id, updates);
            if (selectedId) {
                const secs = await api?.modesGetNoteSections?.(selectedId);
                setSections((secs ?? []) as NoteSectionRow[]);
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to update section');
        } finally {
            setBusy(false);
        }
    }, [selectedId]);

    const handleDeleteSection = useCallback(async (id: string) => {
        setBusy(true);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesDeleteNoteSection?.(id);
            if (selectedId) {
                const secs = await api?.modesGetNoteSections?.(selectedId);
                setSections((secs ?? []) as NoteSectionRow[]);
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to remove section');
        } finally {
            setBusy(false);
        }
    }, [selectedId]);

    const handleRemoveAllSections = useCallback(async () => {
        if (!selectedId) return;
        if (!window.confirm('Remove all note-template sections for this mode?')) return;
        setBusy(true);
        try {
            const api: any = (window as any).electronAPI;
            await api?.modesRemoveAllNoteSections?.(selectedId);
            const secs = await api?.modesGetNoteSections?.(selectedId);
            setSections((secs ?? []) as NoteSectionRow[]);
        } catch (e: any) {
            setError(e?.message || 'Failed to clear sections');
        } finally {
            setBusy(false);
        }
    }, [selectedId]);

    // ── Style tokens (light/dark) ─────────────────────────────────────────
    const tokens = {
        bg: isLight ? 'bg-white' : 'bg-[#0e0e10]',
        surface: isLight ? 'bg-[#fafafa]' : 'bg-[#15151a]',
        surfaceAlt: isLight ? 'bg-[#f3f3f5]' : 'bg-[#1c1c22]',
        border: isLight ? 'border-[#e5e5ea]' : 'border-white/[0.08]',
        borderHover: isLight ? 'hover:border-[#c5c5cc]' : 'hover:border-white/[0.16]',
        textPrimary: isLight ? 'text-[#1c1c1e]' : 'text-white',
        textSecondary: isLight ? 'text-[#666668]' : 'text-white/60',
        textTertiary: isLight ? 'text-[#9b9ba0]' : 'text-white/40',
        accent: 'text-indigo-500',
        accentBg: isLight ? 'bg-indigo-50 border-indigo-200' : 'bg-indigo-500/10 border-indigo-400/20',
        accentText: isLight ? 'text-indigo-700' : 'text-indigo-300',
        hover: isLight ? 'hover:bg-[#f3f3f5]' : 'hover:bg-white/[0.06]',
        selectedRow: isLight ? 'bg-[#f3f3f5]' : 'bg-white/[0.06]',
        betaBg: isLight ? 'bg-amber-100 border-amber-300 text-amber-700' : 'bg-amber-500/15 border-amber-400/30 text-amber-300',
    };

    const displayName = (m: ModeRow) => TEMPLATE_LABEL[m.templateType] ?? m.name;
    const isActive = selectedMode?.id === activeModeId;
    const canDelete = selectedMode?.templateType === 'general' && selectedMode.name === 'New Mode'
        ? false
        : Boolean(selectedMode) && (orderedModes.custom.some((c) => c.id === selectedMode?.id) || (selectedMode && selectedMode.name !== TEMPLATE_LABEL[selectedMode.templateType]));
    // Built-in templates are deletable too (they just un-seed). We surface
    // delete as long as it's a real row the user can mutate.

    return (
        <div className={`h-full w-full flex ${tokens.bg} ${tokens.textPrimary}`}>
            {/* ────────────────  Left: sidebar  ──────────────── */}
            <aside
                className={`w-[260px] shrink-0 flex flex-col border-r ${tokens.border}`}
            >
                {/* Header */}
                <div className="flex items-center gap-2 px-5 pt-5 pb-3">
                    <span className={`text-[12px] font-extrabold tracking-[0.18em] uppercase ${tokens.textSecondary}`}>
                        Modes
                    </span>
                    <span className={`text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border ${tokens.betaBg}`}>
                        BETA
                    </span>
                </div>

                {/* New Mode button */}
                <div className="px-3 pb-3">
                    <button
                        onClick={handleNewMode}
                        disabled={busy || loading}
                        className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-full border border-dashed ${tokens.border} ${tokens.borderHover} ${tokens.textSecondary} hover:${tokens.textPrimary} text-[12.5px] font-medium transition-all disabled:opacity-50`}
                    >
                        <Plus size={13} strokeWidth={2.2} />
                        New Mode
                    </button>
                </div>

                {/* Mode list */}
                <div className="flex-1 overflow-y-auto px-2 pb-3">
                    {loading && (
                        <div className={`px-3 py-4 text-[11px] ${tokens.textTertiary}`}>
                            Loading…
                        </div>
                    )}
                    {!loading && (
                        <>
                            <SidebarSection label="Templates" tokens={tokens}>
                                {orderedModes.built.map((m) => (
                                    <SidebarRow
                                        key={m.id}
                                        mode={m}
                                        label={displayName(m)}
                                        selected={selectedId === m.id}
                                        active={m.id === activeModeId}
                                        tokens={tokens}
                                        onClick={() => setSelectedId(m.id)}
                                    />
                                ))}
                            </SidebarSection>
                            {orderedModes.custom.length > 0 && (
                                <SidebarSection label="Your modes" tokens={tokens}>
                                    {orderedModes.custom.map((m) => (
                                        <SidebarRow
                                            key={m.id}
                                            mode={m}
                                            label={m.name}
                                            selected={selectedId === m.id}
                                            active={m.id === activeModeId}
                                            tokens={tokens}
                                            onClick={() => setSelectedId(m.id)}
                                        />
                                    ))}
                                </SidebarSection>
                            )}
                        </>
                    )}
                </div>

                {/* Footer link — Natively Templates */}
                <div className={`px-3 py-3 border-t ${tokens.border}`}>
                    <button
                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-[12px] font-medium ${tokens.textSecondary} ${tokens.hover} transition-colors`}
                    >
                        <Layers size={13} strokeWidth={2.1} />
                        Natively Templates
                    </button>
                </div>
            </aside>

            {/* ────────────────  Right: detail pane  ──────────────── */}
            <main className="flex-1 min-w-0 overflow-y-auto">
                {error && (
                    <div className="mx-6 mt-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-400/30 text-red-600 dark:text-red-300 text-[12px]">
                        {error}
                    </div>
                )}

                {!selectedMode && !loading && (
                    <div className={`h-full flex items-center justify-center text-[13px] ${tokens.textTertiary}`}>
                        Select a mode from the sidebar to edit.
                    </div>
                )}

                {selectedMode && (
                    <div className="px-8 pt-6 pb-10 max-w-[820px]">
                        {/* Title row */}
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                                {editingName ? (
                                    <div className="flex items-center gap-2">
                                        <input
                                            autoFocus
                                            value={nameDraft}
                                            onChange={(e) => setNameDraft(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleSaveName();
                                                if (e.key === 'Escape') { setEditingName(false); setNameDraft(selectedMode.name); }
                                            }}
                                            className={`text-[28px] font-extrabold tracking-tight ${tokens.textPrimary} bg-transparent border-b ${tokens.border} focus:outline-none focus:border-indigo-500 min-w-0`}
                                        />
                                        <button
                                            onClick={handleSaveName}
                                            disabled={busy}
                                            className={`p-1.5 rounded-md ${tokens.hover} ${tokens.textSecondary}`}
                                            title="Save name"
                                        >
                                            <Check size={14} />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <h1 className="text-[28px] font-extrabold tracking-tight leading-tight">
                                            {selectedMode.name}
                                        </h1>
                                        <button
                                            onClick={() => { setEditingName(true); setNameDraft(selectedMode.name); }}
                                            className={`p-1 rounded-md ${tokens.hover} ${tokens.textTertiary}`}
                                            title="Rename"
                                        >
                                            <Pencil size={13} />
                                        </button>
                                    </div>
                                )}
                                {TEMPLATE_LABEL[selectedMode.templateType] && (
                                    <div className={`mt-1 text-[11px] ${tokens.textTertiary}`}>
                                        Template: {TEMPLATE_LABEL[selectedMode.templateType]}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <button
                                    onClick={handleSetActive}
                                    disabled={busy}
                                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-all ${
                                        isActive
                                            ? isLight
                                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-300'
                                                : 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/30'
                                            : tokens.surfaceAlt
                                    } ${tokens.border} ${!isActive ? tokens.textSecondary : ''} hover:${isActive ? '' : 'bg-white/[0.08]'} disabled:opacity-50`}
                                >
                                    {isActive ? (
                                        <>
                                            <Check size={13} strokeWidth={2.5} />
                                            Set active
                                        </>
                                    ) : (
                                        <>Set active</>
                                    )}
                                </button>
                                <div className="relative">
                                    <button
                                        onClick={() => setOverflowOpen((v) => !v)}
                                        disabled={busy}
                                        className={`p-1.5 rounded-full ${tokens.hover} ${tokens.textSecondary} disabled:opacity-50`}
                                        title="More"
                                    >
                                        <MoreHorizontal size={16} />
                                    </button>
                                    <AnimatePresence>
                                        {overflowOpen && (
                                            <motion.div
                                                initial={{ opacity: 0, y: -4 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                exit={{ opacity: 0, y: -4 }}
                                                transition={{ duration: 0.12 }}
                                                className={`absolute right-0 top-full mt-1.5 min-w-[160px] rounded-lg border ${tokens.border} ${tokens.surface} shadow-2xl py-1 z-50`}
                                            >
                                                <button
                                                    onClick={() => { setOverflowOpen(false); setEditingName(true); setNameDraft(selectedMode.name); }}
                                                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] ${tokens.textPrimary} ${tokens.hover}`}
                                                >
                                                    <Pencil size={12} />
                                                    Rename
                                                </button>
                                                <button
                                                    onClick={() => { setOverflowOpen(false); handleDelete(); }}
                                                    disabled={!canDelete}
                                                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-500 ${tokens.hover} disabled:opacity-40`}
                                                >
                                                    <Trash2 size={12} />
                                                    Delete
                                                </button>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </div>
                        </div>

                        {/* Real-time prompt */}
                        <Section title="Real-time prompt" tokens={tokens}>
                            <div className={`relative rounded-2xl border ${tokens.border} ${tokens.surface} overflow-hidden`}>
                                <textarea
                                    value={draftPrompt}
                                    onChange={(e) => setDraftPrompt(e.target.value)}
                                    placeholder="Describe how this mode should behave. e.g. 'You are a senior legal counsel drafting the lawyer's exact words for the client. Cite the Indian Succession Act §63/§67/§13 when relevant.'"
                                    rows={6}
                                    className={`w-full bg-transparent px-5 py-4 text-[14px] leading-relaxed ${tokens.textPrimary} placeholder:${tokens.textTertiary} focus:outline-none resize-none`}
                                />
                                <div className={`flex items-center justify-end px-3 py-2 border-t ${tokens.border} ${tokens.surfaceAlt}`}>
                                    <button
                                        onClick={handleSavePrompt}
                                        disabled={busy || !promptDirty}
                                        className={`flex items-center gap-1.5 px-4 py-1 rounded-full text-[12px] font-medium transition-all ${
                                            promptDirty
                                                ? isLight
                                                    ? 'bg-[#1c1c1e] text-white hover:bg-black'
                                                    : 'bg-white text-[#1c1c1e] hover:bg-white/90'
                                                : isLight
                                                    ? 'bg-[#e5e5ea] text-[#9b9ba0]'
                                                    : 'bg-white/[0.08] text-white/40'
                                        } disabled:opacity-50`}
                                    >
                                        <Save size={11} strokeWidth={2.5} />
                                        Save
                                    </button>
                                </div>
                            </div>
                            <p className={`mt-2 text-[11px] ${tokens.textTertiary}`}>
                                {TEMPLATE_LABEL[selectedMode.templateType]
                                    ? `Powered by Natively's built-in ${TEMPLATE_LABEL[selectedMode.templateType]} intelligence.`
                                    : 'Custom mode prompt — your instructions are the only prompt.'}
                            </p>
                        </Section>

                        {/* Reference files */}
                        <Section
                            title="Reference files"
                            tokens={tokens}
                            action={
                                <button
                                    onClick={handleUploadFile}
                                    disabled={busy || uploadingFile}
                                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-medium border ${tokens.border} ${tokens.hover} ${tokens.textSecondary} hover:${tokens.textPrimary} disabled:opacity-50`}
                                >
                                    <Upload size={12} />
                                    Upload file
                                </button>
                            }
                        >
                            {/* Hidden file input — actually unused: the IPC handler opens the picker.
                                Kept for HTML semantics so label[for] still works if you want to
                                bind it. */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                className="hidden"
                                multiple={false}
                                accept=".txt,.md,.pdf,.docx,.json,.csv,.html,.htm"
                            />
                            {refFiles.length === 0 ? (
                                <div
                                    className={`rounded-2xl border border-dashed ${tokens.border} ${tokens.surface} px-5 py-8 text-center`}
                                >
                                    <p className={`text-[13px] ${tokens.textSecondary}`}>
                                        Add files as real-time context.
                                    </p>
                                    <p className={`mt-1 text-[11px] ${tokens.textTertiary}`}>
                                        PDFs, docs, transcripts — chunked and grounded into every prompt.
                                    </p>
                                </div>
                            ) : (
                                <ul className={`rounded-2xl border ${tokens.border} ${tokens.surface} divide-y ${tokens.border}`}>
                                    {refFiles.map((f) => (
                                        <li
                                            key={f.id}
                                            className={`flex items-center gap-3 px-4 py-2.5 text-[12.5px] ${tokens.textPrimary}`}
                                        >
                                            <FileText size={13} className={tokens.textSecondary} />
                                            <span className="flex-1 truncate">{f.fileName}</span>
                                            <span className={`text-[10px] ${tokens.textTertiary}`}>
                                                {(f.content?.length ?? 0).toLocaleString()} chars
                                            </span>
                                            <button
                                                onClick={() => handleDeleteRef(f.id)}
                                                disabled={busy}
                                                className={`p-1 rounded-md ${tokens.hover} ${tokens.textTertiary} hover:text-red-500 disabled:opacity-50`}
                                                title="Remove"
                                            >
                                                <X size={12} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Section>

                        {/* Notes template */}
                        <Section
                            title="Notes template"
                            tokens={tokens}
                            action={
                                sections.length > 0 ? (
                                    <button
                                        onClick={handleRemoveAllSections}
                                        disabled={busy}
                                        className={`text-[11.5px] font-medium ${tokens.textTertiary} hover:text-red-500 disabled:opacity-50`}
                                    >
                                        Remove template
                                    </button>
                                ) : null
                            }
                        >
                            {sections.length === 0 ? (
                                <div
                                    className={`rounded-2xl border border-dashed ${tokens.border} ${tokens.surface} px-5 py-6 text-center`}
                                >
                                    <p className={`text-[13px] ${tokens.textSecondary}`}>
                                        No note template yet.
                                    </p>
                                    <button
                                        onClick={handleAddSection}
                                        disabled={busy}
                                        className={`mt-2 text-[11.5px] font-medium ${tokens.accentText} hover:underline disabled:opacity-50`}
                                    >
                                        + Add first section
                                    </button>
                                </div>
                            ) : (
                                <div className={`rounded-2xl border ${tokens.border} ${tokens.surface} divide-y ${tokens.border}`}>
                                    {sections.map((s) => (
                                        <NoteSectionEditor
                                            key={s.id}
                                            section={s}
                                            onUpdate={(updates) => handleUpdateSection(s.id, updates)}
                                            onDelete={() => handleDeleteSection(s.id)}
                                            busy={busy}
                                            tokens={tokens}
                                            isLight={isLight}
                                        />
                                    ))}
                                    <div className={`px-4 py-2 border-t ${tokens.border}`}>
                                        <button
                                            onClick={handleAddSection}
                                            disabled={busy}
                                            className={`text-[11.5px] font-medium ${tokens.accentText} hover:underline disabled:opacity-50`}
                                        >
                                            + Add section
                                        </button>
                                    </div>
                                </div>
                            )}
                        </Section>
                    </div>
                )}
            </main>
        </div>
    );
};

// ─── Small subcomponents ──────────────────────────────────────────────────

const SidebarSection: React.FC<{ label: string; tokens: any; children: React.ReactNode }> = ({ label, tokens, children }) => (
    <div className="mb-2">
        <div className={`px-3 pt-2 pb-1 text-[10px] font-bold tracking-wider uppercase ${tokens.textTertiary}`}>
            {label}
        </div>
        <div className="space-y-0.5">{children}</div>
    </div>
);

const SidebarRow: React.FC<{
    mode: ModeRow;
    label: string;
    selected: boolean;
    active: boolean;
    tokens: any;
    onClick: () => void;
}> = ({ mode, label, selected, active, tokens, onClick }) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left transition-colors ${
            selected ? tokens.selectedRow : tokens.hover
        }`}
    >
        <FileText size={14} className={selected ? tokens.textPrimary : tokens.textSecondary} />
        <span className={`text-[13px] flex-1 truncate ${selected ? `font-semibold ${tokens.textPrimary}` : tokens.textSecondary}`}>
            {label}
        </span>
        {active && (
            <span
                className={`w-1.5 h-1.5 rounded-full ${
                    tokens.bg.includes('bg-white') ? 'bg-emerald-500' : 'bg-emerald-400'
                }`}
                title="Active mode"
            />
        )}
        {mode.referenceFileCount > 0 && (
            <span className={`text-[10px] ${tokens.textTertiary}`}>{mode.referenceFileCount}</span>
        )}
    </button>
);

const Section: React.FC<{ title: string; tokens: any; action?: React.ReactNode; children: React.ReactNode }> = ({ title, tokens, action, children }) => (
    <div className="mt-7">
        <div className="flex items-center justify-between mb-2.5">
            <h3 className={`text-[12px] font-bold tracking-tight ${tokens.textPrimary}`}>{title}</h3>
            {action}
        </div>
        {children}
    </div>
);

const NoteSectionEditor: React.FC<{
    section: NoteSectionRow;
    onUpdate: (updates: { title?: string; description?: string }) => void;
    onDelete: () => void;
    busy: boolean;
    tokens: any;
    isLight: boolean;
}> = ({ section, onUpdate, onDelete, busy, tokens, isLight }) => {
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(section.title);
    const [desc, setDesc] = useState(section.description);

    useEffect(() => {
        setTitle(section.title);
        setDesc(section.description);
    }, [section.title, section.description]);

    if (editing) {
        return (
            <div className="px-4 py-3 space-y-2">
                <input
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { onUpdate({ title, description: desc }); setEditing(false); }
                        if (e.key === 'Escape') { setTitle(section.title); setDesc(section.description); setEditing(false); }
                    }}
                    className={`w-full text-[13px] font-semibold ${tokens.textPrimary} bg-transparent border-b ${tokens.border} focus:outline-none focus:border-indigo-500`}
                    placeholder="Section title"
                />
                <textarea
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { onUpdate({ title, description: desc }); setEditing(false); }
                        if (e.key === 'Escape') { setTitle(section.title); setDesc(section.description); setEditing(false); }
                    }}
                    rows={2}
                    className={`w-full text-[12px] ${tokens.textSecondary} bg-transparent border-b ${tokens.border} focus:outline-none focus:border-indigo-500 resize-none`}
                    placeholder="Describe what should go here"
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                        onClick={() => { setTitle(section.title); setDesc(section.description); setEditing(false); }}
                        className={`px-3 py-1 rounded-full text-[11.5px] ${tokens.textSecondary} ${tokens.hover}`}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => { onUpdate({ title, description: desc }); setEditing(false); }}
                        disabled={busy}
                        className={`px-3 py-1 rounded-full text-[11.5px] font-medium ${
                            isLight ? 'bg-[#1c1c1e] text-white' : 'bg-white text-[#1c1c1e]'
                        } disabled:opacity-50`}
                    >
                        Save
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className={`group px-4 py-3 flex items-start gap-3 ${tokens.textPrimary}`}>
            <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold leading-tight truncate">{section.title}</div>
                <div className={`mt-0.5 text-[11.5px] leading-snug ${tokens.textSecondary}`}>
                    {section.description}
                </div>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={() => setEditing(true)}
                    className={`p-1 rounded-md ${tokens.hover} ${tokens.textTertiary}`}
                    title="Edit"
                >
                    <Pencil size={12} />
                </button>
                <button
                    onClick={onDelete}
                    disabled={busy}
                    className={`p-1 rounded-md ${tokens.hover} ${tokens.textTertiary} hover:text-red-500 disabled:opacity-50`}
                    title="Remove"
                >
                    <Trash2 size={12} />
                </button>
            </div>
        </div>
    );
};

export default ModesSettings;
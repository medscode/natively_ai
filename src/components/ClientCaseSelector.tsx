// src/components/ClientCaseSelector.tsx
// Meeting Copilot: client/case scoping dropdown
// Lets users create and select a client case for knowledge base scoping.

import React, { useState, useEffect, useCallback, useRef } from 'react';

interface ClientCase {
  id: string;
  name: string;
  company: string;
  notes: string;
  createdAt: string;
}

interface ClientCaseSelectorProps {
  selectedCaseId?: string;
  onCaseSelected: (clientCase: ClientCase | null) => void;
  label?: string;
}

export function ClientCaseSelector({ selectedCaseId, onCaseSelected, label }: ClientCaseSelectorProps) {
  const [cases, setCases] = useState<ClientCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selected = cases.find(c => c.id === selectedCaseId) || null;

  // Load client cases on mount
  useEffect(() => {
    loadCases();
  }, []);

  const prevSelectedCaseIdRef = useRef<string | undefined>(undefined);

  // When selectedCaseId changes externally, update active case
  useEffect(() => {
    if (selectedCaseId && selectedCaseId !== prevSelectedCaseIdRef.current) {
      prevSelectedCaseIdRef.current = selectedCaseId;
      const cs = cases.find(c => c.id === selectedCaseId);
      if (cs) {
        setActiveClientCase(cs);
      }
    }
  }, [selectedCaseId, cases]);

  const setActiveClientCase = async (clientCase: ClientCase) => {
    try {
      await window.electronAPI.suggestSetActiveCase({
        clientCaseId: clientCase.id,
        clientCaseName: clientCase.name,
        clientCaseCompany: clientCase.company,
      });
    } catch (e: any) {
      console.warn('[ClientCaseSelector] Failed to set active case:', e);
    }
  };

  const clearActiveClientCase = async () => {
    try {
      await window.electronAPI.suggestSetActiveCase({
        clientCaseId: null,
      });
    } catch (e: any) {
      console.warn('[ClientCaseSelector] Failed to clear active case:', e);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadCases = async () => {
    try {
      setLoading(true);
      const result = await window.electronAPI.kbGetClientCases();
      if (result.success) {
        setCases(result.cases);
      }
    } catch (e: any) {
      console.error('Failed to load client cases:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setError(null);
    try {
      const id = `case_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const result = await window.electronAPI.kbCreateClientCase({
        id,
        name: newName.trim(),
        company: newCompany.trim() || undefined,
        notes: newNotes.trim() || undefined,
      });
      if (result.success) {
        const createdCase: ClientCase = {
          id,
          name: newName.trim(),
          company: newCompany.trim(),
          notes: newNotes.trim(),
          createdAt: new Date().toISOString(),
        };
        setNewName('');
        setNewCompany('');
        setNewNotes('');
        setShowCreateForm(false);
        await loadCases();
        // Select the newly created case
        onCaseSelected(createdCase);
        setActiveClientCase(createdCase);
      } else {
        setError(result.error || 'Failed to create case');
      }
    } catch (e: any) {
      setError(e.message || 'Failed to create case');
    }
  };

  const handleDelete = async (clientCaseId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this client case and all associated knowledge sources?')) return;
    try {
      await window.electronAPI.kbDeleteClientCase(clientCaseId);
      if (selectedCaseId === clientCaseId) {
        onCaseSelected(null);
        clearActiveClientCase();
      }
      await loadCases();
    } catch (e: any) {
      console.error('Failed to delete client case:', e);
    }
  };

  const handleCaseSelected = (clientCase: ClientCase) => {
    onCaseSelected(clientCase);
    setActiveClientCase(clientCase);
    setIsOpen(false);
  };

  const clearSelection = () => {
    onCaseSelected(null);
    clearActiveClientCase();
    setIsOpen(false);
  };

  return (
    <div className="relative w-full text-left" ref={dropdownRef}>
      {label && <label className="block text-xs font-medium text-text-secondary mb-1">{label}</label>}

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm bg-bg-main border border-border-subtle rounded-lg hover:border-accent-primary transition-colors text-text-primary"
      >
        {loading ? (
          <span className="text-text-tertiary">Loading...</span>
        ) : selected ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-accent-primary flex-shrink-0" />
            <span className="truncate font-medium">{selected.name}</span>
            {selected.company && (
              <span className="text-xs text-text-tertiary truncate">— {selected.company}</span>
            )}
          </div>
        ) : (
          <span className="text-text-tertiary/60">Select a client case...</span>
        )}
        <svg className={`w-4 h-4 text-text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-bg-card border border-border-subtle rounded-lg shadow-xl overflow-hidden max-h-80 overflow-y-auto">
          {/* Clear selection */}
          {selectedCaseId && (
            <button
              type="button"
              onClick={clearSelection}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-item-active border-b border-border-subtle text-left"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear selection
            </button>
          )}

          {/* Create new case button */}
          {!showCreateForm ? (
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-accent-primary hover:bg-bg-item-active border-b border-border-subtle text-left font-medium"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New client case
            </button>
          ) : (
            <div className="p-3 border-b border-border-subtle space-y-2 bg-bg-main/50">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Case name (e.g. Acme Corp)"
                className="w-full px-3 py-1.5 text-xs bg-bg-input border border-border-subtle rounded text-text-primary placeholder-text-tertiary/60 focus:outline-none focus:ring-1 focus:ring-accent-primary"
              />
              <input
                type="text"
                value={newCompany}
                onChange={e => setNewCompany(e.target.value)}
                placeholder="Company (optional)"
                className="w-full px-3 py-1.5 text-xs bg-bg-input border border-border-subtle rounded text-text-primary placeholder-text-tertiary/60 focus:outline-none focus:ring-1 focus:ring-accent-primary"
              />
              <textarea
                value={newNotes}
                onChange={e => setNewNotes(e.target.value)}
                placeholder="Notes (optional)"
                className="w-full px-3 py-1.5 text-xs bg-bg-input border border-border-subtle rounded text-text-primary placeholder-text-tertiary/60 focus:outline-none focus:ring-1 focus:ring-accent-primary h-12 resize-none"
              />
              {error && <p className="text-[10px] text-red-400 font-medium">{error}</p>}
              <div className="flex justify-end gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="px-2 py-1 text-[10px] text-text-tertiary hover:bg-bg-item-active rounded"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={!newName.trim()}
                  className="px-2.5 py-1 text-[10px] bg-accent-primary text-white rounded hover:opacity-90 disabled:opacity-50 font-medium"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* Cases list */}
          {cases.length === 0 ? (
            <div className="px-3 py-4 text-xs text-text-tertiary text-center">
              No client cases found
            </div>
          ) : (
            cases.map(c => (
              <div
                key={c.id}
                onClick={() => handleCaseSelected(c)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition-colors ${
                  selectedCaseId === c.id
                    ? 'bg-bg-item-active text-accent-primary font-medium'
                    : 'hover:bg-bg-item-active text-text-primary'
                }`}
              >
                <div className="flex-1 truncate min-w-0">
                  <div className="truncate font-medium">{c.name}</div>
                  {c.company && (
                    <div className="text-[10px] text-text-tertiary truncate">{c.company}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={(e) => handleDelete(c.id, e)}
                  className="p-1 text-text-tertiary hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// src/components/settings/KnowledgeBaseSettings.tsx
// Meeting Copilot: Knowledge Base settings panel
// Create/select client cases, upload files/web pages, and manage sources.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { ClientCaseSelector } from '../ClientCaseSelector';
import { Globe, Upload, FileText, Trash2, Check, AlertCircle, ExternalLink, Link, Youtube, ChevronDown, ChevronUp, BookOpen, Info } from 'lucide-react';

interface ClientCase {
  id: string;
  name: string;
  company: string;
  notes: string;
  createdAt: string;
}

interface Source {
  id: string;
  clientCaseId: string;
  sourceType: 'file' | 'web_page' | 'ppt' | 'youtube';
  title: string;
  content?: string;
  metadata?: {
    originalUrl?: string;
    filePath?: string;
    fileSize?: number;
    pageCount?: number;
    extractedAt?: string;
  };
  indexStatus: string;
  createdAt: string;
}

interface ActiveCase {
  clientCaseId: string | null;
  clientCaseName: string;
  clientCaseCompany: string;
}

const SOURCE_ICONS: Record<string, React.ReactNode> = {
  file: <FileText size={16} />,
  web_page: <Globe size={16} />,
  ppt: <FileText size={16} />,
  youtube: <Youtube size={16} />,
};

const SOURCE_LABELS: Record<string, string> = {
  file: 'File',
  web_page: 'Web Page',
  ppt: 'Presentation',
  youtube: 'YouTube',
};

const SOURCE_COLORS: Record<string, string> = {
  file: 'text-blue-400 bg-blue-500/10',
  web_page: 'text-emerald-400 bg-emerald-500/10',
  ppt: 'text-orange-400 bg-orange-500/10',
  youtube: 'text-red-400 bg-red-500/10',
};

export function KnowledgeBaseSettings() {
  const t = useT();
  const isLight = useResolvedTheme() === 'light';
  const [selectedCase, setSelectedCase] = useState<ClientCase | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeCase, setActiveCase] = useState<ActiveCase>({ clientCaseId: null, clientCaseName: '', clientCaseCompany: '' });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [webUrl, setWebUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  // Load active case on mount
  useEffect(() => {
    loadActiveCase();
  }, []);

  // Load sources when a case is selected
  useEffect(() => {
    if (selectedCase) {
      loadSources(selectedCase.id);
    } else {
      setSources([]);
    }
  }, [selectedCase]);

  const loadActiveCase = async () => {
    try {
      const result = await window.electronAPI?.suggestGetActiveCase();
      if (result?.success) {
        setActiveCase({
          clientCaseId: result.clientCaseId,
          clientCaseName: result.clientCaseName || '',
          clientCaseCompany: result.clientCaseCompany || '',
        });
      }
    } catch {
      // Ignore
    }
  };

  const loadSources = async (clientCaseId: string) => {
    try {
      setLoading(true);
      const result = await window.electronAPI?.kbListSources(clientCaseId);
      if (result?.success) {
        setSources(result.sources || []);
      }
    } catch (e: any) {
      console.error('Failed to load sources:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleCaseSelected = useCallback(async (clientCase: ClientCase | null) => {
    setSelectedCase(clientCase);
    if (clientCase) {
      await loadActiveCase(); // Refresh active case after selection
    }
  }, []);

  const handleAddWebPage = async () => {
    if (!webUrl.trim() || !selectedCase) return;
    const url = webUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setMessage({ type: 'error', text: 'Please enter a valid URL starting with http:// or https://' });
      return;
    }

    setUploading(true);
    setMessage(null);
    try {
      const result = await window.electronAPI?.kbAddSource({
        clientCaseId: selectedCase.id,
        sourceType: 'web_page',
        sourcePath: url,
        title: url,
      });
      if (result?.success) {
        setWebUrl('');
        setShowAddSource(false);
        setMessage({ type: 'success', text: 'Web page added and processing started.' });
        // Re-fetch sources after a delay
        setTimeout(() => loadSources(selectedCase.id), 2000);
      } else {
        setMessage({ type: 'error', text: result?.error || 'Failed to add web page.' });
      }
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'Failed to add web page.' });
    } finally {
      setUploading(false);
    }
  };

  const handleUploadFile = async () => {
    if (!selectedCase) return;
    setUploading(true);
    setMessage(null);
    try {
      // Open file dialog for supported files
      const dialogResult = await window.electronAPI?.kbOpenFileDialog([
        { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'csv'] },
        { name: 'Presentations', extensions: ['pptx', 'ppt'] },
        { name: 'All Files', extensions: ['*'] },
      ]);
      if (dialogResult?.cancelled || !dialogResult?.filePaths?.length) {
        setUploading(false);
        return;
      }

      const filePath = dialogResult.filePaths[0];
      const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Untitled';
      const isPpt = fileName.match(/\.(pptx|ppt)$/i);

      const result = await window.electronAPI?.kbAddSource({
        clientCaseId: selectedCase.id,
        sourceType: isPpt ? 'ppt' : 'file',
        title: fileName,
        sourcePath: filePath,
      });
      if (result?.success) {
        setMessage({ type: 'success', text: `File "${fileName}" uploaded and processing started.` });
        // Re-fetch sources after a delay
        setTimeout(() => loadSources(selectedCase.id), 2000);
      } else {
        setMessage({ type: 'error', text: result?.error || 'Failed to upload file.' });
      }
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'Failed to upload file.' });
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteAllSources = async () => {
    if (!selectedCase) return;
    if (!confirm('Delete ALL knowledge sources for this case?')) return;
    try {
      await window.electronAPI?.kbDeleteClientCase(selectedCase.id);
      await loadSources(selectedCase.id);
      setMessage({ type: 'success', text: 'All sources deleted.' });
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'Failed to delete sources.' });
    }
  };

  const handleSetActive = async (clientCase: ClientCase) => {
    try {
      const result = await window.electronAPI?.suggestSetActiveCase({
        clientCaseId: clientCase.id,
        clientCaseName: clientCase.name,
        clientCaseCompany: clientCase.company,
      });
      if (result?.success) {
        await loadActiveCase();
        setMessage({ type: 'success', text: `Active case set to "${clientCase.name}".` });
      }
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'Failed to set active case.' });
    }
  };

  const handleClearActive = async () => {
    try {
      await window.electronAPI?.suggestSetActiveCase({ clientCaseId: null });
      setActiveCase({ clientCaseId: null, clientCaseName: '', clientCaseCompany: '' });
      setMessage({ type: 'success', text: 'Active case cleared.' });
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'Failed to clear active case.' });
    }
  };

  return (
    <div className="space-y-6 animated fadeIn text-text-primary">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary flex items-center gap-2">
          <BookOpen size={20} className="text-accent-primary" />
          {t('Knowledge Base')}
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          {t('Upload documents, add web pages, and manage client cases. When an active case is set, the AI will automatically ground answers in your uploaded knowledge.')}
        </p>
      </div>

      {/* Active Case Status */}
      {activeCase.clientCaseId && (
        <div className={`p-4 rounded-xl border ${isLight ? 'bg-indigo-50 border-indigo-200' : 'bg-indigo-500/10 border-indigo-500/20'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isLight ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>
                <Check size={16} />
              </div>
              <div>
                <p className={`text-sm font-medium ${isLight ? 'text-indigo-800' : 'text-indigo-300'}`}>
                  Active case: {activeCase.clientCaseName || 'Active Workspace'}
                  {activeCase.clientCaseCompany && <span className="opacity-70"> — {activeCase.clientCaseCompany}</span>}
                </p>
                <p className="text-xs text-text-tertiary mt-0.5">
                  Chat answers will be grounded in this case's knowledge base
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClearActive}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${isLight ? 'text-indigo-600 hover:bg-indigo-100' : 'text-indigo-400 hover:bg-indigo-500/20'}`}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Client Case Selector */}
      <div className={`p-4 rounded-xl border ${isLight ? 'bg-white border-gray-200' : 'bg-bg-card border-border-subtle'}`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium text-text-primary">Client Case</h3>
            <p className="text-xs text-text-tertiary mt-0.5">Select or create a client case to organize knowledge sources</p>
          </div>
        </div>
        <ClientCaseSelector
          selectedCaseId={selectedCase?.id}
          onCaseSelected={handleCaseSelected}
          label=""
        />
      </div>

      {/* Knowledge Sources Section (only when a case is selected) */}
      {selectedCase && (
        <>
          {/* Add Source Controls */}
          <div className={`p-4 rounded-xl border ${isLight ? 'bg-white border-gray-200' : 'bg-bg-card border-border-subtle'}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-text-primary">Knowledge Sources</h3>
              <button
                type="button"
                onClick={() => setShowAddSource(!showAddSource)}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${isLight ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100' : 'bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20'}`}
              >
                {showAddSource ? 'Done' : '+ Add Source'}
              </button>
            </div>

            {/* Add Source Form */}
            {showAddSource && (
              <div className="space-y-3 mb-4 p-3 rounded-lg bg-bg-main border border-border-subtle">
                {/* Upload File */}
                <button
                  type="button"
                  onClick={handleUploadFile}
                  disabled={uploading}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border-subtle hover:bg-bg-item-active transition-colors disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center shrink-0">
                    <Upload size={16} />
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">Upload file</p>
                    <p className="text-xs text-text-tertiary">PDF, DOCX, TXT, PPTX, etc.</p>
                  </div>
                  {uploading && <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />}
                </button>

                {/* Add Web Page */}
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
                    <Globe size={16} />
                  </div>
                  <input
                    type="text"
                    value={webUrl}
                    onChange={e => setWebUrl(e.target.value)}
                    placeholder="Enter a URL (e.g. https://example.com)"
                    className="flex-1 px-3 py-2 text-sm bg-bg-input border border-border-subtle rounded-lg text-text-primary placeholder-text-tertiary/60 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                    onKeyDown={e => { if (e.key === 'Enter') handleAddWebPage(); }}
                  />
                  <button
                    type="button"
                    onClick={handleAddWebPage}
                    disabled={!webUrl.trim() || uploading}
                    className="px-3 py-2 text-xs font-medium bg-accent-primary text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            {/* Message Toast */}
            {message && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-3 text-xs font-medium ${
                message.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-red-500/10 text-red-400 border border-red-500/20'
              }`}>
                {message.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
                <span className="flex-1">{message.text}</span>
                <button type="button" onClick={() => setMessage(null)} className="ml-auto opacity-60 hover:opacity-100 text-sm">×</button>
              </div>
            )}

            {/* Sources List */}
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-text-tertiary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : sources.length === 0 ? (
              <div className="text-center py-8 text-text-tertiary">
                <Info size={24} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">No knowledge sources yet.</p>
                <p className="text-xs mt-1">Add a web page or upload a file to get started.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sources.map(source => (
                  <div
                    key={source.id}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${isLight ? 'bg-white border-gray-100 hover:border-gray-200' : 'bg-bg-main border-border-subtle hover:border-border-muted'} transition-colors group`}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${SOURCE_COLORS[source.sourceType] || 'text-gray-400 bg-gray-500/10'}`}>
                        {SOURCE_ICONS[source.sourceType] || <FileText size={16} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-text-primary truncate" title={source.title}>
                          {source.title}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-text-tertiary">
                            {SOURCE_LABELS[source.sourceType] || source.sourceType}
                          </span>
                          {source.metadata?.fileSize && (
                            <span className="text-xs text-text-tertiary">
                              • {(source.metadata.fileSize / 1024).toFixed(1)} KB
                            </span>
                          )}
                          {(source.sourceType === 'web_page' && source.metadata?.originalUrl) && (
                            <a
                              href={source.metadata.originalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-accent-primary hover:underline flex items-center gap-0.5 shrink-0"
                              onClick={e => {
                                e.stopPropagation();
                              }}
                            >
                              <ExternalLink size={10} />
                              Open
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      {source.indexStatus === 'indexed' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium">Indexed</span>
                      ) : source.indexStatus === 'failed' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 font-medium">Failed</span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">Pending</span>
                      )}
                      <button
                        type="button"
                        onClick={handleDeleteAllSources}
                        className="p-1.5 text-text-tertiary hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete all sources"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Set as Active Case */}
          <div className={`p-4 rounded-xl border ${isLight ? 'bg-white border-gray-200' : 'bg-bg-card border-border-subtle'}`}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-text-primary">Use this case</h3>
                <p className="text-xs text-text-tertiary mt-0.5">
                  Set this as the active knowledge base for chat answers
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleSetActive(selectedCase)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  activeCase.clientCaseId === selectedCase.id
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                    : 'bg-accent-primary text-white hover:opacity-90'
                }`}
                disabled={activeCase.clientCaseId === selectedCase.id}
              >
                {activeCase.clientCaseId === selectedCase.id ? '✓ Active' : 'Set Active'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* How it Works */}
      <div className={`p-4 rounded-xl border ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-bg-card border-border-subtle'}`}>
        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2 mb-2">
          <Info size={14} />
          How it works
        </h3>
        <ol className="text-xs text-text-tertiary space-y-1.5 ml-5 list-decimal">
          <li>Create or select a <strong>client case</strong> to group knowledge sources</li>
          <li><strong>Add sources</strong> — upload files (PDF, DOCX, PPTX) or add web pages by URL</li>
          <li>Click <strong>"Set Active"</strong> to make this case the active knowledge base</li>
          <li>Open the meeting chat or use the search — answers will be grounded in your uploaded knowledge with citations</li>
        </ol>
      </div>
    </div>
  );
}

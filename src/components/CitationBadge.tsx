// src/components/CitationBadge.tsx
// Meeting Copilot PRD Phase 3: visibly label every KB-grounded or web-sourced claim.
//
// Citation types:
//   - 'kb'       — grounded in a knowledge-base chunk (user's own documents)
//   - 'web'      — grounded in a web search result (only when web search is on)
//   - 'inference' — model's own reasoning, not tied to any retrieved chunk

import React from 'react';
import { useT } from '../i18n';
import { BookOpen, Globe, Sparkles } from 'lucide-react';

export type CitationSource = 'kb' | 'web' | 'inference';

export interface CitationBadgeProps {
  source: CitationSource;
  label?: string;
  /** Optional secondary line (e.g., chunk title, web result domain). */
  detail?: string;
  /** Optional score (0..1) for retrieval confidence. */
  score?: number;
}

const SOURCE_META: Record<CitationSource, { Icon: typeof BookOpen; className: string; defaultLabel: string }> = {
  kb: {
    Icon: BookOpen,
    className: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
    defaultLabel: 'Knowledge Base',
  },
  web: {
    Icon: Globe,
    className: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
    defaultLabel: 'Web',
  },
  inference: {
    Icon: Sparkles,
    className: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
    defaultLabel: 'Inference',
  },
};

export function CitationBadge({ source, label, detail, score }: CitationBadgeProps) {
  const t = useT();
  const meta = SOURCE_META[source];
  const Icon = meta.Icon;
  const displayLabel = label ?? meta.defaultLabel;
  const tooltipParts = [displayLabel];
  if (detail) tooltipParts.push(detail);
  if (typeof score === 'number') {
    tooltipParts.push(`score: ${score.toFixed(2)}`);
  }
  const title = tooltipParts.join(' • ');

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-medium align-middle ml-1 select-none ${meta.className}`}
    >
      <Icon size={10} strokeWidth={2.5} />
      <span>{t(displayLabel)}</span>
      {typeof score === 'number' && (
        <span className="opacity-70 font-mono text-[9px]">{score.toFixed(2)}</span>
      )}
    </span>
  );
}

export interface Citation {
  source: CitationSource;
  label?: string;
  detail?: string;
  score?: number;
}

/**
 * Render a chat message with inline citation badges. Looks for a `_citations`
 * array attached to the message and renders badges after sentences that have
 * chunk references. If no citations, returns the raw text.
 */
export function renderMessageWithCitations(
  text: string,
  citations?: Citation[],
): React.ReactNode {
  if (!citations || citations.length === 0) {
    return text;
  }
  // Naive sentence split. Avoid pulling in a tokenizer; chat messages are short.
  const sentenceEnd = /([.!?])\s+/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let sentenceIndex = 0;

  while ((match = sentenceEnd.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index + 1));
    const citation = citations[sentenceIndex];
    if (citation) {
      parts.push(<CitationBadge key={`c-${sentenceIndex}`} {...citation} />);
    }
    lastIndex = match.index + match[0].length;
    sentenceIndex += 1;
  }
  parts.push(text.slice(lastIndex));
  // If we still have unused citations (more citations than sentences), append them at the end.
  if (sentenceIndex < citations.length) {
    citations.slice(sentenceIndex).forEach((c, i) => {
      parts.push(<CitationBadge key={`tail-${i}`} {...c} />);
    });
  }
  return parts;
}
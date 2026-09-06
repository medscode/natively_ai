const { jsPDF } = require('jspdf');
const fs = require('fs');
const path = require('path');

function createPRDDocument() {
    const doc = new jsPDF({
        unit: 'pt',
        format: 'a4',
        orientation: 'portrait'
    });

    const pageWidth = doc.internal.pageSize.getWidth(); // 595.28 pt
    const pageHeight = doc.internal.pageSize.getHeight(); // 841.89 pt
    const margin = 40;
    const contentWidth = pageWidth - (margin * 2); // 515.28 pt
    let y = margin;

    // Color Palette
    const colors = {
        primary: [30, 41, 59],       // Slate 800
        primaryLight: [71, 85, 105], // Slate 600
        accent: [79, 70, 229],       // Indigo 600
        accentLight: [238, 242, 255],// Indigo 50
        accentBorder: [199, 210, 254],// Indigo 200
        dark: [15, 23, 42],          // Slate 900
        lightGray: [248, 250, 252],  // Slate 50
        borderGray: [226, 232, 240], // Slate 200
        textMuted: [100, 116, 139],  // Slate 500
        white: [255, 255, 255],
        highlight: [245, 158, 11]    // Amber 500
    };

    function checkPageBreak(neededHeight) {
        if (y + neededHeight > pageHeight - margin - 30) {
            drawFooter();
            doc.addPage();
            y = margin + 15;
            drawHeader();
            return true;
        }
        return false;
    }

    function drawHeader() {
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.textMuted);
        doc.text('LEGAL AI COPILOT — PRD SPECIFICATION & CLARIFICATION GUIDE', margin, 28);
        doc.setDrawColor(...colors.borderGray);
        doc.setLineWidth(0.5);
        doc.line(margin, 34, pageWidth - margin, 34);
    }

    function drawFooter() {
        const pageCount = doc.internal.getNumberOfPages();
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.textMuted);
        doc.setDrawColor(...colors.borderGray);
        doc.setLineWidth(0.5);
        doc.line(margin, pageHeight - 28, pageWidth - margin, pageHeight - 28);
        doc.text('Confidential — For Internal Product Management Review', margin, pageHeight - 16);
        doc.text(`Page ${pageCount}`, pageWidth - margin - 35, pageHeight - 16);
    }

    // --- TITLE & METADATA BLOCK ---
    doc.setFillColor(...colors.accentLight);
    doc.roundedRect(margin, y, contentWidth, 88, 6, 6, 'F');
    doc.setDrawColor(...colors.accentBorder);
    doc.setLineWidth(1);
    doc.roundedRect(margin, y, contentWidth, 88, 6, 6, 'S');

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.accent);
    doc.text('Legal AI Copilot — PRD Clarification & Decisions', margin + 16, y + 24);

    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.primary);
    doc.text('Product Requirements & Core Feature Specification for Engineering Alignment', margin + 16, y + 40);

    // Meta chips
    doc.setFontSize(8);
    doc.setTextColor(...colors.textMuted);
    const metaText = 'Target Audience: Product Management  •  Status: Awaiting Clarifications  •  Version: 1.0 Draft';
    doc.text(metaText, margin + 16, y + 70);

    y += 102;

    // --- EXECUTIVE SUMMARY ---
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.dark);
    doc.text('Executive Summary', margin, y);
    y += 14;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.primaryLight);
    const intro = "This document outlines the core capabilities of the Legal AI Copilot and requests specific product decisions to finalize the Product Requirements Document (PRD). The system is designed for practicing advocates and law firms to assist in real-time during client meetings and hearings. Please review each section and specify your desired behavior for the final release.";
    const introLines = doc.splitTextToSize(intro, contentWidth);
    doc.text(introLines, margin, y);
    y += introLines.length * 12 + 12;

    // Helper for Section Titles
    function addSectionHeader(number, title) {
        checkPageBreak(40);
        doc.setFillColor(...colors.primary);
        doc.roundedRect(margin, y, contentWidth, 22, 3, 3, 'F');
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colors.white);
        doc.text(`${number}. ${title}`, margin + 10, y + 15);
        y += 28;
    }

    // Helper for Question Cards
    function addDecisionCard(title, currentBehavior, questions, options) {
        // Calculate needed height
        const pad = 10;
        let cardH = 20; // header height

        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'italic');
        const curLines = doc.splitTextToSize(`Current Functionality: ${currentBehavior}`, contentWidth - (pad * 2));
        cardH += curLines.length * 11 + 6;

        doc.setFont('helvetica', 'normal');
        const qLines = doc.splitTextToSize(`Decision Needed: ${questions}`, contentWidth - (pad * 2));
        cardH += qLines.length * 11 + 6;

        if (options && options.length > 0) {
            options.forEach(opt => {
                const optLines = doc.splitTextToSize(`• ${opt}`, contentWidth - (pad * 2) - 10);
                cardH += optLines.length * 10.5 + 3;
            });
        }
        cardH += 8;

        checkPageBreak(cardH + 10);

        // Draw Card Box
        doc.setFillColor(...colors.lightGray);
        doc.roundedRect(margin, y, contentWidth, cardH, 4, 4, 'F');
        doc.setDrawColor(...colors.borderGray);
        doc.setLineWidth(0.75);
        doc.roundedRect(margin, y, contentWidth, cardH, 4, 4, 'S');

        let innerY = y + 14;

        // Card Title
        doc.setFontSize(9.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colors.dark);
        doc.text(title, margin + pad, innerY);
        innerY += 14;

        // Current Functionality
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.textMuted);
        doc.text(curLines, margin + pad, innerY);
        innerY += curLines.length * 11 + 5;

        // Question / Decision Needed
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colors.accent);
        doc.text('Key Questions for PRD:', margin + pad, innerY);
        innerY += 11;

        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.dark);
        doc.text(qLines, margin + pad, innerY);
        innerY += qLines.length * 11 + 5;

        // Options
        if (options && options.length > 0) {
            options.forEach(opt => {
                const optLines = doc.splitTextToSize(`[  ]  ${opt}`, contentWidth - (pad * 2) - 8);
                doc.setFontSize(8);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(...colors.primaryLight);
                doc.text(optLines, margin + pad + 6, innerY);
                innerY += optLines.length * 10.5 + 2;
            });
        }

        y += cardH + 10;
    }

    // ==========================================
    // SECTION 1: KNOWLEDGE BASE & LEGAL CONTENT
    // ==========================================
    addSectionHeader('1', 'Knowledge Base & Legal Document Management');

    addDecisionCard(
        '1.1 Shared Central Law Library vs. Private Client Cases',
        'System maintains a global Shared Legal Library (Acts, Statutes, Judgements) accessible across all meetings, plus isolated private folders for individual client matters.',
        'How should the global legal library be updated in production, and how strict should client case isolation be?',
        [
            'Option A: Cloud-Managed Library — Updates to Acts & Judgements are automatically synced from our secure cloud server.',
            'Option B: Admin Ingestion Portal — Law firm administrators upload their firm’s knowledge base via an in-app management screen.',
            'Option C: Static Local Bundle — Shipped with pre-loaded Acts/Codes and updated only via app version releases.'
        ]
    );

    addDecisionCard(
        '1.2 Supported File Formats & Case Upload Limits',
        'Supports standard PDF, Word (.docx), and text files uploaded into a client case.',
        'What file types and limits should be supported per client case?',
        [
            'Supported file types: PDF, Word (.docx), Scanned Court Petitions (OCR required?), Audio recordings of past hearings?',
            'Capacity limits: Max file size (e.g. 50 MB / file) and max document count per client case (e.g. up to 100 documents)?'
        ]
    );

    addDecisionCard(
        '1.3 Authority Hierarchy & Conflict Resolution',
        'Official Acts & Statutes are given top priority (1.4x boost), Judgements (1.3x), Commentaries (1.15x), and Secondary Articles/News are flagged with "⚠️ Needs Verification".',
        'When a recent Court Judgement conflicts with a statute or older commentary, how should the AI present it?',
        [
            'Option A: Explicitly present both authorities, clearly highlighting the conflict and legal precedence.',
            'Option B: Strictly present only the prevailing authoritative ruling and suppress contradictory secondary commentary.'
        ]
    );

    // ==========================================
    // SECTION 2: LIVE IN-MEETING COPILOT
    // ==========================================
    addSectionHeader('2', 'In-Meeting Live Copilot & Suggestion Engine');

    addDecisionCard(
        '2.1 Proactive Suggestion Triggers & Frequency',
        'The AI listens to client questions in real time and automatically creates a coaching card with direct spoken answers and statutory citations.',
        'What should trigger proactive suggestions during a live conversation?',
        [
            'Option A: High Proactivity — Triggers on every identified question or legal issue raised by the client.',
            'Option B: High Precision — Only triggers when a high-confidence legal query matching the knowledge base is detected.',
            'Option C: On-Demand Only — AI prepares suggestions quietly in the background and only reveals them when the lawyer clicks/prompts.'
        ]
    );

    addDecisionCard(
        '2.2 Suggestion Card Persistence & History Management',
        'Suggestion cards persist in a scrollable list during the meeting with a "Triggered by: [Client Question]" header and document source badges.',
        'How should suggestion cards be managed over long consultations (e.g. 45–60 min calls)?',
        [
            'Option A: Keep all cards in session history with quick "Copy to prompt" and "Pin to Notes" actions.',
            'Option B: Auto-dismiss/collapse older cards after 5 minutes of inactivity to keep the screen uncluttered.',
            'Option C: Provide a manual "Clear Suggestions" and "Export Cards" button.'
        ]
    );

    addDecisionCard(
        '2.3 Web Search Fallback during Confidential Consultations',
        'When the internal knowledge base does not contain an answer, the AI can optionally search the live web.',
        'Should live web search be permitted during confidential client consultations?',
        [
            'Option A: Allowed with explicit web citation badges and a clear disclaimer.',
            'Option B: Disabled by default for strict client confidentiality, enabled only via explicit lawyer toggle.'
        ]
    );

    // ==========================================
    // SECTION 3: AUDIO TRANSCRIPTION & SPEECH
    // ==========================================
    addSectionHeader('3', 'Audio Capture, Speech Recognition & Language');

    addDecisionCard(
        '3.1 Multi-Speaker Diarization (Who is Speaking)',
        'Captures system audio (client/meeting participants) and microphone audio (lawyer).',
        'Is multi-party speaker identification required for consultations involving multiple people?',
        [
            'Option A: Simple 2-way separation (Lawyer vs. Remote Meeting Audio).',
            'Option B: Full multi-speaker diarization identifying Client, Junior Counsel, Opposing Counsel, Judge.'
        ]
    );

    addDecisionCard(
        '3.2 Hinglish & Indian Legal Terminology Handling',
        'Standard speech-to-text models sometimes mishear Hindi/regional legal terms.',
        'How should mixed languages (Hinglish) and Indian legal vocabulary be handled?',
        [
            'Requirement: Custom legal vocabulary boosting for Indian legal terms (e.g. Vakalatnama, Bainama, Khatauni, Stay Order, Injunction, Anticipatory Bail).',
            'Specify whether regional language transcription (Hindi, Tamil, Marathi, Bengali) is in scope for v1.0 or v2.0.'
        ]
    );

    // ==========================================
    // SECTION 4: CITATION & ANSWER FORMATTING
    // ==========================================
    addSectionHeader('4', 'Answer Structuring & Citation Formats');

    addDecisionCard(
        '4.1 Legal Response Structure',
        'Structured in 3 tiers: 1. Direct Spoken Bottom Line (1–2 sentences), 2. Key Legal Points & Analysis (bullet points), 3. Next Action Step.',
        'Is this standard 3-tier structure sufficient, or do we need consultation-specific modes?',
        [
            'Option A: Universal 3-tier structure for all consultations.',
            'Option B: Specialized consultation modes (e.g. Quick Advisory Mode, Court Argument Mode, Drafting/Clause Analysis Mode).'
        ]
    );

    addDecisionCard(
        '4.2 Indian Legal Statutory Notation',
        'Strictly enforced Indian legal notation: "Sec. [Number]" or "Section [Number]" (e.g. Sec. 126 of Transfer of Property Act, 1882) and eliminated the US section symbol (§).',
        'Are there additional citation formats required for Case Laws & Court Orders?',
        [
            'Standard Case Law reporting format (e.g. AIR 2021 SC 450, (2019) 3 SCC 120)?',
            'Requirement for direct hyperlinking to original Act/Judgement text?'
        ]
    );

    // ==========================================
    // SECTION 5: UI/UX & SCREEN SHARING PRIVACY
    // ==========================================
    addSectionHeader('5', 'User Interface & Screen Sharing Privacy');

    addDecisionCard(
        '5.1 Transparent Glassmorphic Overlay',
        'Translucent frosted glass window allowing the lawyer to clearly see the client’s face on Zoom/Meet with docked transcript controls.',
        'What layout options should be available to the lawyer during a meeting?',
        [
            'Option A: Floating Bottom Modal (current default — centered with clear view of participant faces).',
            'Option B: Side-Docked Panel (vertical sidebar pinned beside the video window).',
            'Option C: Compact Teleprompter Mode (minimal single-line top/bottom bar).'
        ]
    );

    addDecisionCard(
        '5.2 Screen-Sharing Stealth / Invisibility',
        'Stealth window mechanisms prevent the Copilot from appearing in screen shares.',
        'Is 100% screen-share invisibility a mandatory requirement for v1.0 launch?',
        [
            'Requirement: When the lawyer shares their entire desktop or Chrome window during a call, the Copilot interface must remain 100% invisible to the client.'
        ]
    );

    // ==========================================
    // SECTION 6: POST-MEETING DELIVERABLES
    // ==========================================
    addSectionHeader('6', 'Post-Meeting Deliverables & Client Memory');

    addDecisionCard(
        '6.1 Automated Post-Meeting Documentation',
        'System records meeting transcripts and can generate summaries and action items.',
        'What automated documents should the system generate immediately after a consultation ends?',
        [
            'Document 1: Client Follow-up Email draft (summarizing key advice and next steps).',
            'Document 2: Formal Legal Case Note / Internal File Memo.',
            'Document 3: Action Item & Court Hearing Date checklist.',
            'Export Formats: PDF, Microsoft Word (.docx), or direct Copy-to-Clipboard?'
        ]
    );

    addDecisionCard(
        '6.2 Multi-Session Client Memory',
        'Transcripts and advice history are stored locally in the case database.',
        'Should the AI cross-reference previous consultations with the same client?',
        [
            'Option A: Yes — AI actively connects context across multiple meetings (e.g. "In our previous session on Aug 10, the client mentioned...").',
            'Option B: No — Treat each consultation independently for privacy/clarity.'
        ]
    );

    // ==========================================
    // SECTION 7: SCOPE, DEPLOYMENT & MVP
    // ==========================================
    addSectionHeader('7', 'Deployment Model & MVP Scope');

    addDecisionCard(
        '7.1 Target Customer Persona for v1.0 Launch',
        'Local desktop application for Mac and Windows.',
        'Who is the primary target user for the initial v1.0 commercial launch?',
        [
            'Option A: Solo Legal Practitioners & Independent Advocates (individual desktop license).',
            'Option B: Law Firms & Legal Teams (shared firm repository, multi-user permissions, central admin billing).'
        ]
    );

    addDecisionCard(
        '7.2 Offline / Low-Connectivity Requirements',
        'Can utilize local models and local vector indexing.',
        'Does the system need to operate 100% offline without internet in courtroom environments?',
        [
            'Option A: Hybrid Online/Offline — Uses cloud AI for maximum speed/quality, falls back to local storage.',
            'Option B: 100% Air-Gapped / Offline Capable — Full on-device transcription and local AI execution.'
        ]
    );

    // Final Page Footer
    drawFooter();

    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.textMuted);
        doc.setDrawColor(...colors.borderGray);
        doc.setLineWidth(0.5);
        doc.line(margin, pageHeight - 28, pageWidth - margin, pageHeight - 28);
        doc.text('Confidential — For Internal Product Management Review', margin, pageHeight - 16);
        doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin - 45, pageHeight - 16);

        if (i > 1) {
            drawHeader();
        }
    }

    const outputPath = path.join(process.cwd(), 'Legal_AI_Copilot_PRD_Clarification_Guide.pdf');
    const pdfData = doc.output('arraybuffer');
    fs.writeFileSync(outputPath, Buffer.from(pdfData));
    console.log(`[PRD Document Generator] PDF successfully created at: ${outputPath}`);
    return outputPath;
}

createPRDDocument();

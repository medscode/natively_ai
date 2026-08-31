const { jsPDF } = require('jspdf');
const fs = require('fs');
const path = require('path');

const datasetPath = path.join(__dirname, 'eval', 'golden-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

function createLawyerReviewPDF() {
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

    // Premium Color Palette
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
        easy: [22, 163, 74],        // Green
        medium: [217, 119, 6],      // Amber
        hard: [220, 38, 38]          // Red
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
        doc.text('LEGAL AI COPILOT — GOLDEN BENCHMARK DATASET REVIEW GUIDE', margin, 28);
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
        doc.text('Confidential — Legal Advisory Board Review Copy', margin, pageHeight - 16);
        doc.text(`Page ${pageCount}`, pageWidth - margin - 35, pageHeight - 16);
    }

    // --- Page 1 Header Banner ---
    drawHeader();
    doc.setFillColor(...colors.accentLight);
    doc.roundedRect(margin, y, contentWidth, 88, 6, 6, 'F');
    doc.setDrawColor(...colors.accentBorder);
    doc.setLineWidth(1);
    doc.roundedRect(margin, y, contentWidth, 88, 6, 6, 'S');

    doc.setFontSize(15);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.accent);
    doc.text('Legal AI Copilot — Golden Dataset Review Guide', margin + 16, y + 24);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.primary);
    doc.text('Instructions for verifying & expanding the AI meeting accuracy benchmarks under Indian Law.', margin + 16, y + 42);

    doc.setFontSize(7.5);
    doc.setTextColor(...colors.textMuted);
    doc.text(`Total Initial Scenarios: ${dataset.questions.length} Questions  •  Target: ZERO HALLUCINATION Precision Testing`, margin + 16, y + 70);

    y += 102;

    // --- Introduction & Executive Summary ---
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.dark);
    doc.text('1. Purpose of this Review', margin, y);
    y += 14;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.primaryLight);
    const introText = "We are engineering a real-time Legal AI Copilot that listens to live client consultation meetings. The AI assists the lawyer by retrieving the exact Indian Acts, statutory sections, and legal principles needed to answer client questions immediately. To guarantee zero hallucination and ensure the AI never cites incorrect or fictional sections, we test our AI against a benchmark 'Golden Dataset' of real-world consultation scenarios. Your review guarantees that our target answers and citations are 100% legally sound.";
    const introLines = doc.splitTextToSize(introText, contentWidth);
    doc.text(introLines, margin, y);
    y += introLines.length * 12 + 16;

    // --- Contribution Guidelines ---
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.dark);
    doc.text('2. Guidelines for Review & New Questions', margin, y);
    y += 14;

    const instructions = [
        "1. Review current questions: Verify if the statutory Acts and Sections are correct under current Indian Law.",
        "2. Wording: Write new client questions exactly how a layman client phrases them (confused, emotional, casual).",
        "3. Expected Acts: State the formal title of the Indian Statute / Act with year (e.g. Transfer of Property Act, 1882).",
        "4. Expected Sections: Specify the exact sections or orders using standard notation (e.g. Sec. 126, Order XXXIX).",
        "5. Lawyer Direct Answer: Write the immediate 1-2 sentence spoken response to comfort and guide the client first."
    ];

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.primary);
    instructions.forEach(ins => {
        const insLines = doc.splitTextToSize(ins, contentWidth - 20);
        doc.text(insLines, margin + 10, y);
        y += insLines.length * 12 + 4;
    });
    y += 12;

    // --- Golden Dataset Header ---
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.dark);
    doc.text('3. Current Golden Dataset (40 Scenarios)', margin, y);
    y += 16;

    // Questions list
    dataset.questions.forEach((q, idx) => {
        // Estimate height for this question block
        const questionText = `${idx + 1}. Client: "${q.clientQuestion}"`;
        const qLines = doc.splitTextToSize(questionText, contentWidth - 16);
        
        const detailsText = `Act/Sec: ${q.expectedActs.join(', ')} (${q.expectedSections.join(', ')})  •  Topics: ${q.expectedTopics.join(', ')}`;
        const detailsLines = doc.splitTextToSize(detailsText, contentWidth - 16);

        const answerText = `Suggested Answer: "${q.expectedBottomLine}"`;
        const answerLines = doc.splitTextToSize(answerText, contentWidth - 16);

        const blockHeight = (qLines.length + detailsLines.length + answerLines.length) * 11 + 22;

        checkPageBreak(blockHeight);

        // Draw background box for question
        doc.setFillColor(...colors.lightGray);
        doc.roundedRect(margin, y, contentWidth, blockHeight - 6, 4, 4, 'F');
        doc.setDrawColor(...colors.borderGray);
        doc.roundedRect(margin, y, contentWidth, blockHeight - 6, 4, 4, 'S');

        let innerY = y + 12;

        // Draw client question
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colors.dark);
        doc.text(qLines, margin + 8, innerY);
        innerY += qLines.length * 10.5 + 4;

        // Draw expected Acts & Sections
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.accent);
        doc.text(detailsLines, margin + 8, innerY);
        innerY += detailsLines.length * 10 + 4;

        // Draw suggested answer
        doc.setFontSize(8);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(...colors.primaryLight);
        doc.text(answerLines, margin + 8, innerY);

        y += blockHeight;
    });

    // --- Submission Form / Template ---
    checkPageBreak(120);
    y += 10;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.dark);
    doc.text('4. Submission Form for New Scenarios', margin, y);
    y += 14;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.primary);
    const formFields = [
        "Scenario #[___]",
        "Client Question: __________________________________________________________________________",
        "Category: [ ] Property Law  [ ] Succession/Wills  [ ] Civil Procedure  [ ] FEMA  [ ] Criminal  [ ] Family Law",
        "Relevant Act(s) & Section(s): _______________________________________________________________",
        "Core Legal Topics: _________________________________________________________________________",
        "Lawyer Direct Answer (Spoken): _____________________________________________________________",
        "Difficulty Level: [ ] Easy  [ ] Medium  [ ] Hard"
    ];

    formFields.forEach(f => {
        doc.text(f, margin + 10, y);
        y += 18;
    });

    drawFooter();

    const pdfPath = path.join(__dirname, '..', 'Legal_Golden_Dataset_Lawyer_Review_Guide.pdf');
    const pdfBuffer = doc.output('arraybuffer');
    fs.writeFileSync(pdfPath, Buffer.from(pdfBuffer));
    console.log(`✅ Lawyer Review PDF created successfully: ${pdfPath}`);
}

createLawyerReviewPDF();

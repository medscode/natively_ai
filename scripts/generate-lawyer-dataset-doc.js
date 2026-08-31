const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');

const datasetPath = path.join(__dirname, 'eval', 'golden-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

// 1. Generate HTML-based .DOC file (opens natively and cleanly in MS Word, Google Docs, Pages)
function generateWordDoc() {
    const docPath = path.join(__dirname, '..', 'Legal_Golden_Dataset_Lawyer_Review_Guide.doc');

    let rowsHtml = '';
    dataset.questions.forEach((q, idx) => {
        const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        const diffColor = q.difficulty === 'easy' ? '#16a34a' : q.difficulty === 'medium' ? '#d97706' : '#dc2626';
        rowsHtml += `
        <tr style="background-color: ${bg};">
            <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold; text-align: center;">#${idx + 1}</td>
            <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: 600; color: #1e293b;">
                ${escapeHtml(q.clientQuestion)}
                <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Category: <i>${q.category.replace('_', ' ')}</i></div>
            </td>
            <td style="padding: 10px; border: 1px solid #cbd5e1; color: #0f172a;">
                <b>${escapeHtml(q.expectedActs.join(', '))}</b><br/>
                <span style="display: inline-block; background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-top: 4px; font-weight: bold;">${escapeHtml(q.expectedSections.join(', '))}</span>
            </td>
            <td style="padding: 10px; border: 1px solid #cbd5e1; font-size: 12px; color: #334155;">
                ${escapeHtml(q.expectedTopics.join(', '))}
            </td>
            <td style="padding: 10px; border: 1px solid #cbd5e1; font-size: 12px; color: #0f172a;">
                ${escapeHtml(q.expectedBottomLine)}
            </td>
            <td style="padding: 10px; border: 1px solid #cbd5e1; text-align: center; font-weight: bold; color: ${diffColor}; font-size: 12px;">
                ${q.difficulty.toUpperCase()}
            </td>
        </tr>`;
    });

    const htmlContent = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head>
        <meta charset='utf-8'>
        <title>Legal AI Copilot — Golden Evaluation Dataset & Review Guide</title>
        <style>
            body {
                font-family: 'Calibri', 'Arial', sans-serif;
                font-size: 11pt;
                line-height: 1.5;
                color: #1e293b;
                margin: 30px;
            }
            h1 { color: #1e3a8a; font-size: 22pt; margin-bottom: 4px; }
            h2 { color: #1e40af; font-size: 15pt; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; margin-top: 24px; }
            h3 { color: #334155; font-size: 12pt; margin-top: 16px; }
            .header-banner {
                background-color: #f1f5f9;
                border-left: 5px solid #2563eb;
                padding: 14px 18px;
                margin-bottom: 24px;
            }
            .alert-box {
                background-color: #eff6ff;
                border: 1px solid #bfdbfe;
                padding: 12px 16px;
                border-radius: 6px;
                margin: 16px 0;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 14px;
                margin-bottom: 24px;
                font-size: 10.5pt;
            }
            th {
                background-color: #1e293b;
                color: #ffffff;
                padding: 10px;
                text-align: left;
                border: 1px solid #0f172a;
                font-size: 10pt;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .form-box {
                background: #f8fafc;
                border: 1.5px dashed #94a3b8;
                padding: 18px;
                border-radius: 8px;
                margin-top: 16px;
            }
        </style>
    </head>
    <body>
        <div class="header-banner">
            <h1>Legal AI Copilot — Golden Dataset & Review Guide</h1>
            <p style="margin: 4px 0 0 0; color: #475569; font-size: 11pt;">
                <b>Target:</b> Accuracy & Legal Precision Testing for Real-Time Lawyer Co-Counsel System<br/>
                <b>Version:</b> 1.0 &nbsp;|&nbsp; <b>Total Initial Scenarios:</b> 40 Consultation Questions
            </p>
        </div>

        <h2>1. Purpose of this Document</h2>
        <p>
            We are engineering a real-time <b>Legal AI Copilot</b> that listens to live client consultation meetings and assists the lawyer by retrieving the exact Indian Acts, statutory sections, and legal principles needed to answer client questions immediately without leaving the call.
        </p>
        <p>
            To guarantee <b>zero hallucination</b> and ensure the AI never cites incorrect or fictional sections, we test our AI against a benchmark <b>"Golden Dataset"</b> of real-world consultation scenarios. 
        </p>

        <div class="alert-box">
            <b>Your Role as Legal Expert:</b>
            <ul style="margin: 6px 0 0 0; padding-left: 20px;">
                <li><b>Review the 40 existing questions:</b> Check whether the expected Acts, Sections, and answers are 100% legally sound under Indian Law.</li>
                <li><b>Add 20–40 new consultation questions:</b> Provide scenarios from your real client meetings (layman wording, edge cases, tricky family/property disputes).</li>
            </ul>
        </div>

        <h2>2. Guidelines for Contributing Questions</h2>
        <table style="margin-top: 10px;">
            <tr style="background: #334155; color: white;">
                <th style="width: 25%;">Component</th>
                <th style="width: 40%;">How to Write It</th>
                <th style="width: 35%;">Example</th>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: bold;">Client Question</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;">Casual, emotional, or layman wording. Real clients do not know section numbers or formal terminology.</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;"><i>"My brother grabbed the ancestral land, what can I do?"</i></td>
            </tr>
            <tr style="background: #f8fafc;">
                <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: bold;">Applicable Act(s)</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;">Formal title of the Indian Statute / Act with year.</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;">Hindu Succession Act, 1956</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: bold;">Statutory Section(s)</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;">Exact statutory section or order (using <code>Sec.</code> or <code>Order</code> notation).</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;"><b>Sec. 6</b></td>
            </tr>
            <tr style="background: #f8fafc;">
                <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: bold;">Key Legal Topics</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;">3 to 5 core legal concepts that must be covered.</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;">partition, coparcenary, ancestral property, joint family</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #cbd5e1; font-weight: bold;">Lawyer Direct Answer</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;">The bottom-line 1-2 sentence spoken response to comfort and guide the client first.</td>
                <td style="padding: 8px; border: 1px solid #cbd5e1;"><i>"You have a legal right as a coparcener to file a suit for partition."</i></td>
            </tr>
        </table>

        <h2>3. Current Golden Dataset (40 Scenarios)</h2>
        <p>Please review the table below. If you notice any incorrect section numbers or better statutory citations, mark your comments directly.</p>

        <table>
            <thead>
                <tr>
                    <th style="width: 4%;">#</th>
                    <th style="width: 28%;">Client Question</th>
                    <th style="width: 22%;">Expected Act & Section</th>
                    <th style="width: 20%;">Key Legal Topics</th>
                    <th style="width: 20%;">Lawyer Direct Answer</th>
                    <th style="width: 6%;">Diff.</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>

        <h2>4. Submission Form for New Scenarios (Please Add Below)</h2>
        <p>You can duplicate the block below or write in a separate table/sheet to send your scenarios:</p>

        <div class="form-box">
            <p><b>[New Scenario #___]</b></p>
            <p><b>Client Question:</b> __________________________________________________________________________</p>
            <p><b>Category:</b> [ ] Property Law &nbsp; [ ] Succession/Wills &nbsp; [ ] Civil Procedure &nbsp; [ ] Trusts &nbsp; [ ] FEMA &nbsp; [ ] Criminal (BNS/BSA) &nbsp; [ ] Family Law &nbsp; [ ] Corporate</p>
            <p><b>Relevant Act(s):</b> __________________________________________________________________________</p>
            <p><b>Relevant Section(s):</b> Sec. _________</p>
            <p><b>Key Legal Concepts:</b> ______________________________________________________________________</p>
            <p><b>Lawyer's Spoken Answer (Bottom Line):</b> _____________________________________________________</p>
            <p><b>Difficulty Level:</b> [ ] Easy &nbsp; [ ] Medium &nbsp; [ ] Hard</p>
        </div>

        <div class="form-box" style="margin-top: 14px;">
            <p><b>[New Scenario #___]</b></p>
            <p><b>Client Question:</b> __________________________________________________________________________</p>
            <p><b>Category:</b> [ ] Property Law &nbsp; [ ] Succession/Wills &nbsp; [ ] Civil Procedure &nbsp; [ ] Trusts &nbsp; [ ] FEMA &nbsp; [ ] Criminal (BNS/BSA) &nbsp; [ ] Family Law &nbsp; [ ] Corporate</p>
            <p><b>Relevant Act(s):</b> __________________________________________________________________________</p>
            <p><b>Relevant Section(s):</b> Sec. _________</p>
            <p><b>Key Legal Concepts:</b> ______________________________________________________________________</p>
            <p><b>Lawyer's Spoken Answer (Bottom Line):</b> _____________________________________________________</p>
            <p><b>Difficulty Level:</b> [ ] Easy &nbsp; [ ] Medium &nbsp; [ ] Hard</p>
        </div>
    </body>
    </html>
    `;

    fs.writeFileSync(docPath, htmlContent, 'utf8');
    console.log(`✅ Word Document created: ${docPath}`);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

generateWordDoc();

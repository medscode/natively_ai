// scripts/generate-smith-will-template.js
// Creates a sample will template PDF (Smith Estate) for testing the live
// KB-grounded suggestion flow. Saves to <repo>/smith-will-template.pdf.
//
// Usage: node scripts/generate-smith-will-template.js

const { jsPDF } = require('jspdf');
const path = require('fs');

const doc = new jsPDF({ unit: 'pt', format: 'letter' });
const margin = 56; // 0.75"
const pageWidth = doc.internal.pageSize.getWidth();
const pageHeight = doc.internal.pageSize.getHeight();
const usable = pageWidth - margin * 2;
let y = margin;

function addHeading(text) {
    if (y > pageHeight - 80) { doc.addPage(); y = margin; }
    doc.setFont('times', 'bold');
    doc.setFontSize(12);
    doc.text(text, margin, y);
    y += 18;
    doc.setFont('times', 'normal');
    doc.setFontSize(11);
}

function addParagraph(text) {
    doc.setFont('times', 'normal');
    doc.setFontSize(11);
    const lines = doc.splitTextToSize(text, usable);
    const lineHeight = 14;
    for (const line of lines) {
        if (y > pageHeight - margin) { doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += lineHeight;
    }
    y += 10; // paragraph spacing
}

// Title
doc.setFont('times', 'bold');
doc.setFontSize(16);
doc.text('LAST WILL AND TESTAMENT OF JOHN A. SMITH', pageWidth / 2, y, { align: 'center' });
y += 28;

// Articles
addHeading('ARTICLE I - IDENTIFICATION');
addParagraph('I, JOHN A. SMITH, residing at 1247 Maplewood Avenue, Springfield, Illinois, being of sound mind and memory, do hereby make, publish, and declare this to be my Last Will and Testament, hereby revoking any and all wills and codicils previously made by me.');

addHeading('ARTICLE II - REVOCATION OF PRIOR WILLS');
addParagraph('I hereby revoke any and all wills, codicils, and other testamentary instruments made by me at any time prior to the execution of this Will.');

addHeading('ARTICLE III - PAYMENT OF DEBTS AND EXPENSES');
addParagraph('I direct that all my legally enforceable debts, the expenses of my last illness, my funeral expenses, and the costs of administration of my estate be paid from my residuary estate as soon as practicable after my death.');

addHeading('ARTICLE IV - DISPOSITION OF REAL AND PERSONAL PROPERTY');
addParagraph('I give, devise, and bequeath all of my right, title, and interest in the real property located at 1247 Maplewood Avenue, Springfield, Illinois (the "Maplewood Residence"), together with all improvements thereon and appurtenances thereunto belonging, to my spouse, MARY E. SMITH, and my child, ROBERT J. SMITH, as joint tenants with right of survivorship, and not as tenants in common.');
addParagraph('In the event that both MARY E. SMITH and ROBERT J. SMITH predecease me, or fail to survive me by thirty (30) days, I direct that the Maplewood Residence pass to my secondary beneficiary, namely the Springfield Community Trust, to be held, administered, and distributed for charitable purposes consistent with the Trust\'s stated mission.');

addHeading('ARTICLE V - RESIDUARY ESTATE');
addParagraph('All the rest, residue, and remainder of my estate, of every kind, character, and description, including all real and personal property, tangible and intangible, and including any property over which I may have a power of appointment (my "Residuary Estate"), I give, devise, and bequeath to my spouse, MARY E. SMITH, if she survives me by thirty (30) days. If MARY E. SMITH does not so survive me, I give my Residuary Estate to my child, ROBERT J. SMITH, or if he does not survive me by thirty (30) days, to my sibling, PATRICIA L. SMITH.');

addHeading('ARTICLE VI - SIMULTANEOUS DEATH');
addParagraph('If any beneficiary under this Will, including any beneficiary of the Maplewood Residence or the Residuary Estate, and I shall die under such circumstances that there is no sufficient evidence to determine that we died otherwise than simultaneously, or if it shall be impossible or impractical to determine the order of our deaths, then for all purposes of this Will I shall be conclusively presumed to have survived such beneficiary, and this Will shall be construed accordingly.');

addHeading('ARTICLE VII - APPOINTMENT OF EXECUTOR');
addParagraph('I hereby nominate, constitute, and appoint my spouse, MARY E. SMITH, to be the Executor of this Will and of my estate. If MARY E. SMITH is unable or unwilling to serve as Executor, I appoint my sibling, PATRICIA L. SMITH, as alternate Executor. The Executor shall serve without bond and shall be entitled to statutory compensation for services rendered.');

addHeading('ARTICLE VIII - GUARDIAN OF MINOR CHILDREN');
addParagraph('If at the time of my death any of my children are minors, I nominate my spouse, MARY E. SMITH, to be the Guardian of the person and estate of each such minor child. If MARY E. SMITH is unable or unwilling to serve, I appoint my sibling, PATRICIA L. SMITH, as alternate Guardian.');

addHeading('ARTICLE IX - SURVIVORSHIP REQUIREMENT');
addParagraph('For all purposes of this Will, no beneficiary shall be deemed to have survived me unless such beneficiary is living on the date that is thirty (30) days following the date of my death. Any beneficiary who fails to survive me by such thirty (30) day period shall be treated for all purposes of this Will as if such beneficiary had predeceased me.');

addHeading('ARTICLE X - TAX APPORTIONMENT');
addParagraph('All estate, inheritance, succession, and similar death taxes (collectively, "Death Taxes") imposed by reason of my death shall be paid out of my Residuary Estate, without apportionment against any beneficiary and without right of reimbursement from any beneficiary.');

addHeading('ARTICLE XI - GOVERNING LAW');
addParagraph('This Will shall be governed by, and construed and administered in accordance with, the laws of the State of Illinois, without regard to its conflict-of-laws principles. The probate of this Will shall be in the appropriate court of Sangamon County, Illinois.');

// Execution block
if (y > pageHeight - 200) { doc.addPage(); y = margin; }
y += 8;
doc.setFont('times', 'bold');
doc.setFontSize(11);
doc.text('IN WITNESS WHEREOF, I have hereunto set my hand this ___ day of __________, 20__.', margin, y);
y += 32;
doc.text('_____________________________________', margin, y); y += 14;
doc.setFont('times', 'normal');
doc.text('JOHN A. SMITH, Testator', margin, y); y += 22;

// Attestation
doc.setFont('times', 'bold');
doc.text('ATTESTATION OF WITNESSES', margin, y); y += 18;
doc.setFont('times', 'normal');
const attest = 'The foregoing instrument was signed, published, and declared by JOHN A. SMITH as and for his Last Will and Testament, in our presence, and we, at his request, in his presence, and in the presence of each other, have hereunto subscribed our names as attesting witnesses on the date last above written.';
const attestLines = doc.splitTextToSize(attest, usable);
for (const line of attestLines) {
    if (y > pageHeight - margin) { doc.addPage(); y = margin; }
    doc.text(line, margin, y);
    y += 14;
}
y += 16;

doc.text('_____________________________________       _____________________________________', margin, y); y += 14;
doc.text('Witness 1 (name and address)                    Witness 2 (name and address)', margin, y);

const outPath = require('path').join(__dirname, '..', 'smith-will-template.pdf');
doc.save(outPath);
console.log('Generated: ' + outPath);
console.log('File size: ' + require('fs').statSync(outPath).size + ' bytes');

# Instructions for Legal Expert — Reviewing & Expanding Golden Evaluation Dataset

## 1. Executive Summary

We are developing a real-time **Legal AI Copilot** designed to assist lawyers during live client consultations. The AI listens to the conversation, identifies the legal issue in real time, and retrieves the exact statutory provisions (Acts, Sections, Provisos) to give the lawyer an instantaneous, accurate answer.

To ensure **zero hallucination** (never citing non-existent sections or incorrect laws), we evaluate the entire AI pipeline against a **Golden Evaluation Dataset**.

---

## 2. What We Need From You

1. **Review Existing 40 Scenarios:**
   - Verify whether the statutory Acts and Sections listed are accurate under current Indian Law.
   - Flag any outdated or nuanced points (e.g. 2005 Hindu Succession Act amendment, repeal under BNS/BSA, etc.).

2. **Add 20 to 40 New Consultation Questions:**
   - Real-world questions that clients ask when they walk into your office.
   - Write client questions in **casual, emotional, or layman language** (e.g., *"My brother grabbed my land"*, not *"Suit for partition under Section 6"*).
   - Provide the exact Indian Act, Section, key topics, and direct 1-2 sentence spoken answer.

---

## 3. Structure for Contributing Questions

| Field | Description | Example |
|---|---|---|
| **Client Question** | Layman / casual wording from a real meeting. | *"Can I take back the flat I gifted to my son last year?"* |
| **Applicable Act(s)** | Official title of Indian Statute / Act with year. | Transfer of Property Act, 1882 |
| **Statutory Section(s)** | Specific section using `Sec.` notation. | `Sec. 126` |
| **Key Legal Topics** | 3-5 core legal topics. | revocation of gift, conditions, donee consent, fraud |
| **Lawyer Direct Answer** | Immediate spoken 1-2 sentence answer. | *"A registered gift deed can only be revoked if there was a pre-agreed condition or fraud."* |
| **Difficulty** | Easy / Medium / Hard | Medium |

---

## 4. Categories & Gaps We Want to Expand

- **Property Law (TPA, 1882):** Mortgages (Sec. 58-104), Lease vs License, Adverse Possession, Encroachment, Builder delay/RERA.
- **Succession & Wills (HSA 1956, ISA 1925):** Coparcenary rights, Intestate succession, Challenging wills, Nominee vs Legal heir.
- **Civil Procedure (CPC, 1908):** Injunctions (Order XXXIX), Execution of Decrees (Order XXI), Appeals, Summary Suits.
- **Trusts & Estates (Indian Trusts Act, 1882):** Private vs Public trusts, Trustee removal, Trustee duties.
- **FEMA (1999):** NRI real estate acquisition, Inward/Outward remittances, LRS limits.
- **Criminal & Evidence (BNS 2023, BSA 2023):** Cheating/Fraud, Defamation, Electronic evidence admissibility.
- **Family Law & Matrimonial:** Maintenance, Divorce grounds, Child custody, Streedhan.

---

## 5. Submission Format

You can review and fill out the attached file **`Legal_Golden_Dataset_Lawyer_Review_Guide.doc`** directly in Microsoft Word or Google Docs, or provide your questions in an Excel / CSV sheet.

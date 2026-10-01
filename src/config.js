// Every document type in one place. To add a new one, add a line here: `hint` is what the local AI
// is told the document looks like, so it can recognise it. No retraining needed.
//   multiple: students may upload more than one (each "Other certificate" gets its own name)
//   nameMayDiffer: often issued in a parent's name, so a name mismatch is only a warning
//   retired: kept so old uploads still show a name, but students can no longer choose it
//   required: every student must upload it (shown on the checklist)
//   ifApplicable: on the checklist, but not every student has one
const SEMESTER_TYPES = Array.from({ length: 8 }, (_, i) => ({
  key: `semester_${i + 1}`,
  label: `Semester ${i + 1} Result`,
  hint: `college/university semester grade sheet or statement of marks for semester ${i + 1} (may be written in Roman numerals, e.g. "${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][i]} Semester")`,
}));

export const DOCUMENTS = [
  { key: 'birth_certificate', label: 'Birth Certificate', required: true, hint: 'birth certificate issued by a municipality, panchayat or Registrar of Births and Deaths, with the child\'s name, date and place of birth and parents\' names' },
  // Key kept as 'aadhaar_masked' so existing uploads keep working; full Aadhaar cards are accepted.
  { key: 'aadhaar_masked', label: 'Aadhaar Card', required: true, hint: 'Aadhaar card issued by UIDAI, Government of India' },
  { key: 'marksheet_10', label: '10th Mark Sheet', required: true, hint: 'Class 10 / SSLC / secondary school (school board) mark sheet or statement of marks' },
  { key: 'marksheet_12', label: '12th Mark Sheet', required: true, hint: 'Class 12 / HSC / higher secondary (school board) mark sheet or statement of marks' },
  { key: 'community_certificate', label: 'Community Certificate', ifApplicable: true, hint: 'community / caste certificate issued by the Tahsildar or Revenue Department' },
  { key: 'income_certificate', label: 'Income Certificate', ifApplicable: true, hint: 'income certificate issued by the Tahsildar or Revenue Department, stating annual family income', nameMayDiffer: true },
  ...SEMESTER_TYPES,
  { key: 'transfer_certificate', label: 'Transfer Certificate (TC)', required: true, hint: 'school or college Transfer Certificate (TC) or leaving certificate' },
  { key: 'achievement_certificate', label: 'Hackathon / Achievement Certificate', hint: 'certificate of participation, merit, prize or achievement: hackathon, competition, workshop, sports, NSS/NCC and similar', multiple: true, retired: true },
  { key: 'driving_licence', label: 'Driving Licence', hint: 'driving licence', retired: true },
  // Any other certificate (hackathon, course, sports, NSS…). The student names each one; no type check.
  { key: 'other', label: 'Other certificate', multiple: true, named: true },
];

const byKey = Object.fromEntries(DOCUMENTS.map((d) => [d.key, d]));
export const docInfo = (key) => byKey[key];
export const DOC_TYPES = Object.fromEntries(DOCUMENTS.map((d) => [d.key, d.label])); // key -> label, incl. retired
export const UPLOADABLE_TYPES = DOCUMENTS.filter((d) => !d.retired);
export const isUploadable = (key) => Boolean(byKey[key] && !byKey[key].retired);
// What to call a document everywhere: its type, plus the student's own name for an "Other certificate".
export const documentLabel = (doc) => {
  const base = DOC_TYPES[doc.doc_type] ?? doc.doc_type;
  return doc.title ? `${base}: ${doc.title}` : base;
};

// College departments. Students pick one when they register; department staff only see their own
// department's students. Edit this list to match the college.
export const DEPARTMENTS = [
  { key: 'BSC-CS', label: 'B.Sc (Computer Science)' },
  { key: 'BCA', label: 'B.C.A' },
  { key: 'BBA', label: 'B.B.A' },
  { key: 'BCOM', label: 'B.Com' },
  { key: 'BA-ENG', label: 'B.A (English)' },
  { key: 'BSC-PHY', label: 'B.Sc (Physics)' },
  { key: 'BSC-CHEM', label: 'B.Sc (Chemistry)' },
  { key: 'BSC-MATH', label: 'B.Sc (Mathematics)' },
  { key: 'BCOM-HONS-PA', label: 'B.Com Honours (Professional Account)' },
  { key: 'BSC-HONS-DS', label: 'B.Sc Honours (Data Science)' },
];
export const ALL_DEPARTMENTS = 'ALL'; // staff who see every department (college office)
export const isDepartment = (key) => DEPARTMENTS.some((d) => d.key === key);
export const deptLabel = (key) =>
  key === ALL_DEPARTMENTS ? 'Admin (all departments)' : DEPARTMENTS.find((d) => d.key === key)?.label ?? (key || 'Not set');

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCS_PER_STUDENT = 40;
export const LOCK_AFTER_FAILS = 5;
export const LOCK_MINUTES = 15;
export const SESSION_MINUTES = 15;

// A student may swap in a new copy when staff rejected it, or when the AI check found a problem
// before staff looked at it.
export const canReplace = (doc) =>
  doc.status === 'rejected' || (doc.status === 'pending' && ['fail', 'warn'].includes(doc.ai_verdict));

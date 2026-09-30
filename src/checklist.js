// Which documents a student has, and in what state, for the student dashboard and the staff pages.
import { UPLOADABLE_TYPES } from './config.js';

const isSemester = (key) => /^semester_\d$/.test(key);

// verified > waiting for review > needs fixing > missing
function stateOf(docs) {
  if (!docs.length) return 'missing';
  if (docs.some((d) => d.status === 'verified')) return 'verified';
  if (docs.some((d) => d.status === 'rejected' || (d.status === 'pending' && ['fail', 'warn'].includes(d.ai_verdict)))) return 'attention';
  return 'pending';
}

export function buildChecklist(docs) {
  const byType = (key) => docs.filter((d) => d.doc_type === key);
  const item = (t) => ({ key: t.key, label: t.label, state: stateOf(byType(t.key)), docs: byType(t.key) });

  const required = UPLOADABLE_TYPES.filter((t) => t.required).map(item);
  const ifApplicable = UPLOADABLE_TYPES.filter((t) => t.ifApplicable).map(item);
  const semesters = UPLOADABLE_TYPES.filter((t) => isSemester(t.key)).map(item);
  const achievements = UPLOADABLE_TYPES.filter((t) => t.multiple).map(item);

  const requiredDone = required.filter((i) => i.state !== 'missing').length;
  return {
    required, ifApplicable, semesters, achievements,
    requiredDone,
    requiredTotal: required.length,
    missingRequired: required.filter((i) => i.state === 'missing'),
  };
}

export const REQUIRED_TOTAL = UPLOADABLE_TYPES.filter((t) => t.required).length;

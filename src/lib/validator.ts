export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type Rule = (text: string) => string | null;

const noEmDash: Rule = (t) =>
  t.includes('—') ? 'Contains em-dash (—), use hyphen instead' : null;

const noMarkdown: Rule = (t) =>
  /\*\*|##|```/.test(t) ? 'Contains markdown formatting (**, ##, ```)' : null;

const maxLength = (limit: number): Rule => (t) =>
  t.length > limit ? `Post too long: ${t.length} chars (max ${limit})` : null;

const chickenDistance = (minChars: number): Rule => (t) => {
  const idx: number[] = [];
  let i = -1;
  while ((i = t.indexOf('🐤', i + 1)) !== -1) idx.push(i);
  for (let k = 1; k < idx.length; k++) {
    const gap = idx[k] - idx[k - 1];
    if (gap < minChars) return `Two 🐤 too close: ${gap} chars apart (min ${minChars})`;
  }
  return null;
};

const requireDisclaimer: Rule = (t) =>
  /БОТ|УЧУСЬ/.test(t) ? null : 'Missing bot disclaimer (БОТ or УЧУСЬ in caps)';

const requireKesha: Rule = (t) =>
  t.includes('Кеша') ? null : 'Missing "Кеша" in text';

const requireChicken: Rule = (t) =>
  t.includes('🐤') ? null : 'Missing 🐤 emoji';

const requireSourceMarkers = (min: number): Rule => (t) => {
  const count = (t.match(/📎/g) ?? []).length;
  return count < min
    ? `Too few news items: ${count} source(s) found (min ${min} required)`
    : null;
};

// A linked source line: 📎 as the FIRST character, then text, then an http(s) URL.
// No trim — 📎 must be literally first (leading spaces do not count).
const LINKED_SOURCE_LINE = /^📎\s+\S.*https?:\/\/\S+/u;

export function countLinkedSources(t: string): number {
  return t.split('\n').filter((l) => LINKED_SOURCE_LINE.test(l)).length;
}

const requireLinkedSources = (min: number): Rule => (t) => {
  const n = countLinkedSources(t);
  return n < min ? `Too few linked sources: ${n} 📎+URL line(s) (min ${min})` : null;
};

const requireConclusion: Rule = (t) => {
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  let lastMarker = -1;
  lines.forEach((l, i) => { if (/^📎/u.test(l)) lastMarker = i; });
  if (lastMarker === -1) return null; // "no markers" is handled by requireLinkedSources
  const tail = lines.slice(lastMarker + 1).filter((l) => !/https?:\/\//.test(l));
  return tail.length === 0 ? 'Missing conclusion after last source line' : null;
};

const noListBullets: Rule = (t) =>
  t.split('\n').some((l) => /^\s*[-*•]\s/.test(l))
    ? 'Contains list bullets (-, * or •), use 📎 lines instead'
    : null;

function compose(...rules: Rule[]): (text: string) => ValidationResult {
  return (text) => {
    const errors = rules
      .map((r) => r(text))
      .filter((e): e is string => e !== null);
    return { valid: errors.length === 0, errors };
  };
}

export const validateWeekly = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  maxLength(4000),
  requireSourceMarkers(3),
  chickenDistance(500),
);

export const validateBoss = compose(
  noEmDash,
  noMarkdown,
  maxLength(4096),
);

export const validateStream = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  maxLength(4000),
  chickenDistance(500),
);

// Notes posts have two 🐤 in the mandatory header (< 500 chars apart by design).
export const validateNotes = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  maxLength(4000),
);

// Short digest: 📎-bulleted one-liners with source links + a short conclusion.
// chickenDistance is intentionally omitted (short post, one 🐤 in header is fine).
export const validateShort = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  noListBullets,
  maxLength(1500),
  requireLinkedSources(3),
  requireConclusion,
);

// Backward-compat aliases — existing callers keep working.
export const validatePost = validateWeekly;
export const validateBossPost = validateBoss;

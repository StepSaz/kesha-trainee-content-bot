export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePost(text: string): ValidationResult {
  const errors: string[] = [];

  const hasBot = /БОТ/.test(text);
  const hasLearning = /УЧУСЬ/.test(text);

  if (!hasBot && !hasLearning) {
    errors.push('Missing bot disclaimer (БОТ or УЧУСЬ in caps)');
  }

  if (!text.includes('Кеша')) {
    errors.push('Missing "Кеша" in text');
  }

  if (!text.includes('🐤')) {
    errors.push('Missing 🐤 emoji');
  }

  if (text.includes('\u2014')) {
    errors.push('Contains em-dash (—), use hyphen instead');
  }

  if (/\*\*|##|```/.test(text)) {
    errors.push('Contains markdown formatting (**, ##, ```)');
  }

  if (text.length > 4000) {
    errors.push(`Post too long: ${text.length} chars (max 4000)`);
  }

  const sourceCount = (text.match(/📎/g) ?? []).length;
  if (sourceCount < 3) {
    errors.push(`Too few news items: ${sourceCount} source(s) found (min 3 required)`);
  }

  return { valid: errors.length === 0, errors };
}

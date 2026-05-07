const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export function shouldSuppressCron(publishedAt: string | null, nowMs: number): boolean {
  if (!publishedAt) return false;
  return nowMs - new Date(publishedAt).getTime() < SEVEN_DAYS;
}

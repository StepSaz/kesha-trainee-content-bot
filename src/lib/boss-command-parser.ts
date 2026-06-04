export function parseCommand(text: string): { forceRaw: boolean; forceSkip: boolean; inputText: string } {
  const withoutCommand = text.replace(/^\/boss\S*\s*/, '');

  if (withoutCommand === '--raw' || withoutCommand.startsWith('--raw ')) {
    return { forceRaw: true, forceSkip: false, inputText: withoutCommand.slice(5).trim() };
  }
  if (withoutCommand === '--skip' || withoutCommand.startsWith('--skip ')) {
    return { forceRaw: false, forceSkip: true, inputText: withoutCommand.slice(6).trim() };
  }
  return { forceRaw: false, forceSkip: false, inputText: withoutCommand.trim() };
}

export function parseDigestVariant(text: string): 'full' | 'short' | null {
  // (?=$|\s) enforces a command boundary so /digestshort and /digest_x are NOT
  // treated as digest commands. /digest@bot is allowed (Telegram group syntax).
  const m = text.match(/^\/digest(@\w+)?(?=$|\s)/i);
  if (!m) return null;
  // Arguments are read from the first line only (newline is not an arg separator).
  const firstToken = text.slice(m[0].length).split('\n')[0].trim()
    .split(/\s+/)[0]?.toLowerCase() ?? '';
  return firstToken === 'short' ? 'short' : 'full';
}

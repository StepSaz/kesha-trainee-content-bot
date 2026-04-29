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

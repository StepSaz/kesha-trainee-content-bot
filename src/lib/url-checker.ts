export interface Citations {
  urls: string[];
  handles: string[];
}

const URL_REGEX = /https?:\/\/[^\s)\]'">,]+/g;
const HANDLE_REGEX = /@[\w_]+/g;

export function extractCitations(text: string): Citations {
  return {
    urls: [...new Set(text.match(URL_REGEX) ?? [])],
    handles: [...new Set(text.match(HANDLE_REGEX) ?? [])],
  };
}

// Returns citations in `post` that do not appear anywhere in `contexts`.
// Handles are included in the interface but callers decide whether to act on them.
export function findHallucinated(post: string, contexts: string[]): Citations {
  const { urls, handles } = extractCitations(post);
  const contextText = contexts.join('\n');
  return {
    urls: urls.filter(u => !contextText.includes(u)),
    handles: handles.filter(h => !contextText.includes(h)),
  };
}

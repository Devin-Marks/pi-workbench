/**
 * Console-compatible fuzzy matching for slash command names. Matches query
 * characters in order and ranks lower scores ahead of higher scores.
 */
export function fuzzyMatch(query: string, text: string): { matches: boolean; score: number } {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const matchQuery = (normalizedQuery: string): { matches: boolean; score: number } => {
    if (normalizedQuery.length === 0) return { matches: true, score: 0 };
    if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
      if (textLower[i] !== normalizedQuery[queryIndex]) continue;
      const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1] ?? "");
      if (lastMatchIndex === i - 1) {
        consecutiveMatches++;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
      }
      if (isWordBoundary) score -= 10;
      score += i * 0.1;
      lastMatchIndex = i;
      queryIndex++;
    }
    if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
    if (normalizedQuery === textLower) score -= 100;
    return { matches: true, score };
  };

  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) return primaryMatch;

  const alphaNumericMatch = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(queryLower);
  const numericAlphaMatch = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(queryLower);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
      : "";
  if (swappedQuery.length === 0) return primaryMatch;

  const swappedMatch = matchQuery(swappedQuery);
  return swappedMatch.matches ? { matches: true, score: swappedMatch.score + 5 } : primaryMatch;
}

/** Filter and rank slash commands by their name without the leading slash. */
export function fuzzyFilterSlashCommands<T extends { name: string }>(
  commands: readonly T[],
  query: string,
): T[] {
  if (query.trim().length === 0) return [...commands];

  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return [...commands];

  const results: { command: T; score: number }[] = [];
  for (const command of commands) {
    const commandName = command.name.startsWith("/") ? command.name.slice(1) : command.name;
    let score = 0;
    for (const token of tokens) {
      const match = fuzzyMatch(token, commandName);
      if (!match.matches) {
        score = Number.NaN;
        break;
      }
      score += match.score;
    }
    if (!Number.isNaN(score)) results.push({ command, score });
  }
  results.sort((a, b) => a.score - b.score);
  return results.map(({ command }) => command);
}

/** Console-style completion leaves the selected command ready for arguments. */
export function completeSlashCommand(name: string): string {
  return `${name} `;
}

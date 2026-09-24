import {
  MAX_MATCHES,
  type MatchResult,
  type SearchRow,
  type TextBlock,
} from "./types";

const escapeLiteral = (query: string): string =>
  query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const compileQuery = (row: SearchRow): RegExp => {
  const source = row.regex ? row.query : escapeLiteral(row.query);
  const expression = row.wholeWord
    ? `(?<![\\p{L}\\p{M}\\p{N}_])(?:${source})(?![\\p{L}\\p{M}\\p{N}_])`
    : source;
  return new RegExp(expression, `gmu${row.matchCase ? "" : "i"}`);
};

export const matchBlocks = (
  blocks: TextBlock[],
  row: SearchRow,
  limit = MAX_MATCHES,
): MatchResult => {
  const matches: MatchResult["matches"] = [];
  if (!row.query) return { matches, truncated: false };

  let expression: RegExp;
  try {
    expression = compileQuery(row);
  } catch (error) {
    return {
      matches,
      truncated: false,
      error:
        error instanceof Error ? error.message : "Invalid regular expression.",
    };
  }

  for (let block = 0; block < blocks.length; block++) {
    const text = blocks[block].text;
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (start === end) {
        const codepoint = text.codePointAt(end);
        expression.lastIndex =
          end + (codepoint !== undefined && codepoint > 0xffff ? 2 : 1);
        continue;
      }
      if (matches.length === limit) return { matches, truncated: true };
      matches.push({ block, start, end });
    }
  }

  return { matches, truncated: false };
};

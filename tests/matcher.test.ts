import { describe, expect, it } from "vitest";
import { matchBlocks } from "../src/matcher";
import { createSearch, type Search } from "../src/types";

const search = (
  text: string,
  query: string,
  options: Partial<Search> = {},
) => matchBlocks([{ text, order: 0 }], { ...createSearch(), query, ...options });
describe("matching options", () => {
  it.each([
    [false, false, false, 2],
    [false, false, true, 2],
    [false, true, false, 1],
    [false, true, true, 1],
    [true, false, false, 6],
    [true, false, true, 4],
    [true, true, false, 4],
    [true, true, true, 2],
  ])(
    "regex=%s case=%s wholeWord=%s → %s",
    (regex, matchCase, wholeWord, count) => {
      expect(
        search("Cat cat cats scatter c.t C.T", "c.t", {
          regex: !!regex,
          matchCase: !!matchCase,
          wholeWord: !!wholeWord,
        }).matches,
      ).toHaveLength(count as number);
    },
  );
  it("treats all metacharacters literally without regex", () => {
    expect(search("a [x]+ (x) $5 a.b \\x", "[x]+").matches).toHaveLength(1);
    expect(search("a [x]+ (x) $5 a.b \\x", "\\x").matches).toHaveLength(1);
  });
  it("uses Unicode letters, marks, numbers and underscore as word characters", () => {
    expect(
      search("cat cat2 _cat cat_ écat 你cat 𐐀cat cat\u0301 cat!", "cat", {
        wholeWord: true,
      }).matches,
    ).toHaveLength(2);
  });
  it("lets whole-word boundaries participate in regex backtracking", () => {
    expect(
      search("ab abc", "a|ab|abc", {
        regex: true,
        wholeWord: true,
      }).matches.map((match) => match.end - match.start),
    ).toEqual([2, 3]);
  });
  it("accepts punctuation-only whole words", () => {
    expect(
      search(" ++ a++ ++a", "++", { wholeWord: true }).matches,
    ).toHaveLength(1);
  });
  it("preserves regex lookbehind, groups and backreferences", () => {
    expect(
      search("foofoo foo bar", "(foo)\\1", { regex: true }).matches,
    ).toHaveLength(1);
    expect(
      search("a1 b2 a3", "(?<=a)\\d", { regex: true }).matches,
    ).toHaveLength(2);
  });
  it("uses multiline anchors", () => {
    expect(
      search("cat\ndog\ncat", "^cat$", { regex: true }).matches,
    ).toHaveLength(2);
  });
  it("skips zero-length matches without looping over Unicode surrogate pairs", () => {
    expect(search("😀abc", "(?:)", { regex: true }).matches).toEqual([]);
    expect(search("😀abc", "(?=a)|abc", { regex: true }).matches).toEqual([]);
  });
  it("returns a regex syntax error without throwing", () => {
    expect(search("hello", "[", { regex: true }).error).toContain(
      "Invalid regular expression",
    );
  });
  it("returns no matches for an empty query", () => {
    expect(search("hello", "").matches).toEqual([]);
  });
  it("does not match across blocks", () => {
    expect(
      matchBlocks(
        [
          { text: "hello", order: 0 },
          { text: "world", order: 1 },
        ],
        { ...createSearch(), query: "helloworld" },
      ).matches,
    ).toEqual([]);
  });
  it("finds non-overlapping matches", () => {
    expect(search("aaaaa", "aa").matches.map((match) => match.start)).toEqual([
      0, 2,
    ]);
  });
  it("reports truncation only when an additional match exists", () => {
    const search = { ...createSearch(), query: "a" };
    expect(matchBlocks([{ text: "aa", order: 0 }], search, 2).truncated).toBe(
      false,
    );
    const result = matchBlocks([{ text: "aaa", order: 0 }], search, 2);
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

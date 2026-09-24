import type { ToolbarState } from "./preferences";

export const MAX_MATCHES = 10_000;
export const MATCH_COLOUR = "#FFFF00";
export const CURRENT_MATCH_COLOUR = "#FF9632";
export const OWN_ATTRIBUTE = "data-better-chrome-find";

export interface Search {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface TabState {
  search: Search;
  open: boolean;
  revision: number;
}

export interface FrameIdentity {
  tabId: number;
  frameId: number;
  documentId: string;
}

export interface TextBlock {
  text: string;
  order: number;
}

export interface MatchOffset {
  block: number;
  start: number;
  end: number;
}

export interface MatchResult {
  matches: MatchOffset[];
  truncated: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface MatchRequest {
  search: Search;
  blocks: TextBlock[];
  queryRevision: number;
  indexRevision: number;
}

export interface MatchGroup {
  order: number;
  count: number;
  first: number;
}

export interface FrameSummary {
  identity: FrameIdentity;
  queryRevision: number;
  indexRevision: number;
  path: number[] | null;
  childDocuments: string[];
  groups: MatchGroup[];
  truncated: boolean;
  error?: string;
  pending: boolean;
}

export interface PaintRequest {
  queryRevision: number;
  indexRevision: number;
  count: number;
  current: number;
}

export interface SearchStatus {
  current: number;
  total: number;
  truncated: boolean;
  pending: boolean;
  error?: string;
}

export type BackgroundMessage =
  | { target: "background"; type: "HELLO" }
  | { target: "background"; type: "TOOLBAR_STATE"; tabId: number }
  | {
      target: "background";
      type: "SET_ENABLED";
      tabId: number;
      scope: "global" | "site";
      enabled: boolean;
    }
  | { target: "background"; type: "SAVE_STATE"; state: TabState }
  | { target: "background"; type: "OPEN"; seed?: string }
  | { target: "background"; type: "CLOSE" }
  | { target: "background"; type: "ACTIVATE"; tabId: number }
  | { target: "background"; type: "MATCH"; request: MatchRequest }
  | { target: "background"; type: "CANCEL" }
  | {
      target: "background";
      type: "SUMMARY";
      summary: Omit<FrameSummary, "identity">;
    }
  | {
      target: "background";
      type: "ROUTE";
      destination: FrameIdentity;
      message: ContentMessage;
    };

export type BackgroundMessageType = BackgroundMessage["type"];

/** Messages only the toolbar popup may send. Webpage frames send the rest. */
export type ExtensionPageMessageType = "TOOLBAR_STATE" | "SET_ENABLED" | "ACTIVATE";

export type MessageOf<T extends BackgroundMessageType> = Extract<
  BackgroundMessage,
  { type: T }
>;

export interface HelloResponse {
  enabled: boolean;
  identity: FrameIdentity;
  state: TabState;
}

export interface ActivateResponse {
  ok: boolean;
  error?: string;
}

export interface BackgroundReplies {
  HELLO: HelloResponse;
  TOOLBAR_STATE: ToolbarState;
  SET_ENABLED: ToolbarState;
  SAVE_STATE: TabState;
  OPEN: unknown;
  CLOSE: unknown;
  ACTIVATE: ActivateResponse;
  MATCH: MatchResult;
  CANCEL: { ok: true };
  SUMMARY: unknown;
  ROUTE: unknown;
}

export interface ErrorReply {
  error: string;
}

/** Sent instead of a reply when the sending document is no longer active. */
export interface IgnoredReply {
  ignored: true;
}

export type BackgroundReply<T extends BackgroundMessageType> =
  | BackgroundReplies[T]
  | ErrorReply
  | (T extends ExtensionPageMessageType ? never : IgnoredReply);

export type OffscreenMessage =
  | { target: "offscreen"; type: "MATCH"; key: string; request: MatchRequest }
  | { target: "offscreen"; type: "CANCEL"; key: string };

export type ContentMessage =
  | { target: "content"; type: "PING" }
  | { target: "content"; type: "ENABLEMENT"; enabled: boolean }
  | { target: "content"; type: "STATE"; state: TabState }
  | { target: "content"; type: "OPEN"; seed?: string; source?: FrameIdentity }
  | { target: "content"; type: "CLOSE" }
  | { target: "content"; type: "SUMMARY"; summary: FrameSummary }
  | { target: "content"; type: "PAINT"; request: PaintRequest }
  | {
      target: "content";
      type: "NAVIGATE";
      localIndex: number;
      queryRevision: number;
      indexRevision: number;
    }
  | { target: "content"; type: "RESTORE_FOCUS" };

export const createSearch = (): Search => ({
  query: "",
  matchCase: false,
  wholeWord: false,
  regex: false,
});

export const createState = (): TabState => ({
  search: createSearch(),
  open: false,
  revision: 0,
});

/** Returns a clean copy of a well-formed state, or undefined for anything else. */
export const readState = (value: unknown): TabState | undefined => {
  const state = value as Partial<TabState> | undefined;
  const search = state?.search;
  if (
    typeof search?.query !== "string" ||
    typeof search.matchCase !== "boolean" ||
    typeof search.wholeWord !== "boolean" ||
    typeof search.regex !== "boolean" ||
    typeof state?.open !== "boolean" ||
    typeof state.revision !== "number"
  ) {
    return undefined;
  }
  const { query, matchCase, wholeWord, regex } = search;
  return {
    search: { query, matchCase, wholeWord, regex },
    open: state.open,
    revision: state.revision,
  };
};

export const frameKey = (identity: FrameIdentity): string =>
  `${identity.tabId}/${identity.frameId}/${identity.documentId}`;

export const queryKey = (search: Search): string =>
  JSON.stringify([search.query, search.matchCase, search.wholeWord, search.regex]);

export const send = <M extends BackgroundMessage>(
  message: M,
): Promise<BackgroundReply<M["type"]>> => chrome.runtime.sendMessage(message);

export const focusedElement = (): HTMLElement | undefined =>
  document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined;

export const pause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export const comparePath = (left: number[], right: number[]): number => {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return left.length - right.length;
};

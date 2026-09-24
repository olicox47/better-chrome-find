export const MAX_MATCHES = 10_000;
export const MATCH_COLOUR = "#FFFF00";
export const CURRENT_MATCH_COLOUR = "#FF9632";
export const OWN_ATTRIBUTE = "data-better-chrome-find";

export interface SearchRow {
  id: string;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface TabState {
  rows: SearchRow[];
  activeRowId: string;
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
  row: SearchRow;
  blocks: TextBlock[];
  queryRevision: number;
  indexRevision: number;
}

export interface MatchGroup {
  order: number;
  count: number;
  first: number;
}

export interface RowSummary {
  id: string;
  groups: MatchGroup[];
  truncated: boolean;
  error?: string;
  pending?: boolean;
}

export interface FrameSummary {
  identity: FrameIdentity;
  queryRevision: number;
  indexRevision: number;
  path: number[] | null;
  childDocuments: string[];
  rows: RowSummary[];
}

export interface RowPaint {
  id: string;
  count: number;
  current: number;
}

export interface PaintRequest {
  queryRevision: number;
  indexRevision: number;
  rows: RowPaint[];
}

export interface RowStatus {
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
      rowId: string;
      localIndex: number;
      queryRevision: number;
      indexRevision: number;
    }
  | { target: "content"; type: "RESTORE_FOCUS" };

export interface HelloResponse {
  enabled: boolean;
  identity: FrameIdentity;
  state: TabState;
}

export const createRow = (): SearchRow => ({
  id: crypto.randomUUID(),
  query: "",
  matchCase: false,
  wholeWord: false,
  regex: false,
});

export const createState = (): TabState => {
  const row = createRow();
  return { rows: [row], activeRowId: row.id, open: false, revision: 0 };
};

export const singleSearchState = (state: TabState): TabState => {
  // Retain the active query if session data came from the multi-search version.
  const { id, query, matchCase, wholeWord, regex } =
    state.rows.find((row) => row.id === state.activeRowId) ??
    state.rows[0] ??
    createRow();
  return {
    rows: [{ id, query, matchCase, wholeWord, regex }],
    activeRowId: id,
    open: state.open,
    revision: state.revision,
  };
};

export const frameKey = (identity: FrameIdentity): string =>
  `${identity.tabId}/${identity.frameId}/${identity.documentId}`;

export const queryKey = (row: SearchRow): string =>
  JSON.stringify([row.query, row.matchCase, row.wholeWord, row.regex]);

export const send = <T = unknown>(message: BackgroundMessage): Promise<T> =>
  chrome.runtime.sendMessage(message);

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

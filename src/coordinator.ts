import { Panel } from "./panel";
import {
  comparePath,
  focusedElement,
  frameKey,
  MAX_MATCHES,
  send,
  type FrameIdentity,
  type FrameSummary,
  type PaintRequest,
  type Search,
  type SearchStatus,
  type TabState,
} from "./types";

interface NavigationGroup {
  identity: FrameIdentity;
  indexRevision: number;
  first: number;
  count: number;
  globalStart: number;
  path: number[];
}

const groupContaining = (
  groups: NavigationGroup[],
  index: number,
): NavigationGroup | undefined =>
  groups.find(
    (group) =>
      index >= group.globalStart && index < group.globalStart + group.count,
  );

const localIndex = (group: NavigationGroup, index: number): number =>
  group.first + index - group.globalStart;

export class Coordinator {
  private panel?: Panel;
  private summaries = new Map<string, FrameSummary>();
  private status?: SearchStatus;
  private selected = 0;
  private groups: NavigationGroup[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  private repaintTimer?: ReturnType<typeof setTimeout>;
  private previousFocus?: HTMLElement;
  private sourceFrame?: FrameIdentity;
  private pendingReveal = false;
  private pendingRevealRevision = -1;
  private lastPaint = new Map<string, string>();

  constructor(
    private identity: FrameIdentity,
    public state: TabState,
  ) {
    if (state.open) {
      this.ensurePanel().show();
      this.render();
    }
  }

  private ensurePanel(): Panel {
    return (this.panel ??= new Panel({
      change: (changes) => this.change(changes),
      navigate: (step) => this.navigate(step),
      close: () => this.close(),
    }));
  }

  handlePanelKeyboardEvent(event: KeyboardEvent): boolean {
    return this.state.open && (this.panel?.handleKeyboardEvent(event) ?? false);
  }

  open(seed?: string, source?: FrameIdentity): void {
    if (!this.state.open) {
      this.previousFocus = focusedElement();
      this.sourceFrame = source;
    }
    const panel = this.ensurePanel();
    const { search } = this.state;
    if (!search.query && seed) {
      search.query = seed;
      this.pendingReveal = true;
    }
    this.state.open = true;
    panel.show();
    this.commit();
    panel.focus();
  }

  close(): void {
    this.state.open = false;
    this.pendingReveal = false;
    this.summaries.clear();
    this.lastPaint.clear();
    this.panel?.hide();
    this.commit();
    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus({ preventScroll: true });
    }
    if (this.sourceFrame && this.sourceFrame.frameId !== 0) {
      void send({
        target: "background",
        type: "ROUTE",
        destination: this.sourceFrame,
        message: { target: "content", type: "RESTORE_FOCUS" },
      });
    }
  }

  receiveState(state: TabState): void {
    if (state.revision <= this.state.revision) return;

    this.state = state;
    if (state.open) {
      this.ensurePanel().show();
    } else {
      this.panel?.hide();
    }
    this.render();
  }

  private commit(): void {
    clearTimeout(this.debounce);
    this.state.revision++;
    if (this.pendingReveal) this.pendingRevealRevision = this.state.revision;
    this.state = structuredClone(this.state);
    this.render();
    void send({
      target: "background",
      type: "SAVE_STATE",
      state: this.state,
    }).catch(() => {});
  }

  private change(changes: Partial<Search>): void {
    const { search } = this.state;
    Object.assign(search, changes);
    if (
      "query" in changes ||
      "matchCase" in changes ||
      "wholeWord" in changes ||
      "regex" in changes
    ) {
      this.selected = 0;
      this.pendingReveal = true;
      this.pendingRevealRevision = -1;
      this.status = {
        current: 0,
        total: 0,
        truncated: false,
        pending: !!search.query,
      };
    }
    this.render();
    clearTimeout(this.debounce);
    if ("query" in changes) {
      this.debounce = setTimeout(() => this.commit(), 150);
    } else {
      this.commit();
    }
  }

  receiveSummary(summary: FrameSummary): void {
    if (
      !this.state.open ||
      summary.queryRevision !== this.state.revision ||
      summary.identity.tabId !== this.identity.tabId
    ) {
      return;
    }
    const key = frameKey(summary.identity);
    const previous = this.summaries.get(key);
    if (previous && previous.indexRevision > summary.indexRevision) return;

    for (const [oldKey, old] of this.summaries) {
      if (old.identity.frameId === summary.identity.frameId && oldKey !== key) {
        this.summaries.delete(oldKey);
      }
    }
    this.summaries.set(key, summary);
    clearTimeout(this.repaintTimer);
    this.repaintTimer = setTimeout(() => this.reconcile(), 20);
  }

  private reconcile(): void {
    if (!this.state.open) return;

    const byDocument = new Map(
      [...this.summaries.values()]
        .filter((frame) => frame.queryRevision === this.state.revision)
        .map((frame) => [frame.identity.documentId, frame]),
    );
    const reachable: FrameSummary[] = [];
    const visited = new Set<string>();
    let pending = false;
    const visit = (documentId: string): void => {
      if (visited.has(documentId)) return;

      visited.add(documentId);
      const frame = byDocument.get(documentId);
      if (!frame || frame.path === null) {
        pending = true;
        return;
      }
      reachable.push(frame);
      frame.childDocuments.forEach(visit);
    };
    visit(this.identity.documentId);

    const candidates: NavigationGroup[] = [];
    let truncated = false;
    const errors = new Set<string>();
    for (const frame of reachable) {
      pending ||= frame.pending;
      truncated ||= frame.truncated;
      if (frame.error) errors.add(frame.error);
      for (const group of frame.groups) {
        candidates.push({
          identity: frame.identity,
          indexRevision: frame.indexRevision,
          first: group.first,
          count: group.count,
          globalStart: 0,
          path: [...frame.path!, group.order],
        });
      }
    }
    const error = [...errors].join(" · ") || undefined;

    if (this.state.search.query && pending) {
      // Partial frame results must not reset the selected match or replace a
      // complete highlight set with an empty or incomplete one.
      this.status = {
        current: this.status?.current ?? 0,
        total: this.status?.total ?? 0,
        truncated: this.status?.truncated ?? false,
        pending: true,
        error,
      };
    } else {
      this.paint(candidates, reachable, truncated, error);
    }

    this.render();
    if (
      this.pendingReveal &&
      this.pendingRevealRevision === this.state.revision &&
      this.status &&
      !this.status.pending
    ) {
      this.pendingReveal = false;
      if (this.status.total) this.reveal();
    }
  }

  private paint(
    candidates: NavigationGroup[],
    reachable: FrameSummary[],
    truncated: boolean,
    error: string | undefined,
  ): void {
    candidates.sort((a, b) => comparePath(a.path, b.path));
    const groups: NavigationGroup[] = [];
    let total = 0;
    for (const candidate of candidates) {
      const count = Math.min(candidate.count, MAX_MATCHES - total);
      if (count < candidate.count) truncated = true;
      if (count > 0) groups.push({ ...candidate, count, globalStart: total });
      total += count;
    }
    this.groups = groups;
    const current = Math.min(this.selected, Math.max(0, total - 1));
    this.selected = current;
    this.status = { current, total, truncated, pending: false, error };

    for (const frame of reachable) {
      const key = frameKey(frame.identity);
      const ownGroups = groups.filter(
        (group) => frameKey(group.identity) === key,
      );
      const activeGroup = groupContaining(ownGroups, current);
      const request: PaintRequest = {
        queryRevision: this.state.revision,
        indexRevision: frame.indexRevision,
        count: ownGroups.reduce((sum, group) => sum + group.count, 0),
        current: activeGroup ? localIndex(activeGroup, current) : -1,
      };
      const signature = JSON.stringify(request);
      if (this.lastPaint.get(key) === signature) continue;

      this.lastPaint.set(key, signature);
      void send({
        target: "background",
        type: "ROUTE",
        destination: frame.identity,
        message: { target: "content", type: "PAINT", request },
      });
    }
  }

  private navigate(step: number): void {
    const status = this.status;
    if (!status?.total || status.pending) return;

    this.selected = (this.selected + step + status.total) % status.total;
    this.reconcile();
    this.reveal();
  }

  private reveal(): void {
    const group = groupContaining(this.groups, this.selected);
    if (!group) return;

    void send({
      target: "background",
      type: "ROUTE",
      destination: group.identity,
      message: {
        target: "content",
        type: "NAVIGATE",
        localIndex: localIndex(group, this.selected),
        queryRevision: this.state.revision,
        indexRevision: group.indexRevision,
      },
    });
  }

  private render(): void {
    this.panel?.update(this.state.search, this.status);
  }
}

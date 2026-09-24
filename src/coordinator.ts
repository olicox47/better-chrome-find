import { Panel } from "./panel";
import {
  comparePath,
  focusedElement,
  frameKey,
  MAX_MATCHES,
  send,
  type FrameIdentity,
  type FrameSummary,
  type RowPaint,
  type RowStatus,
  type SearchRow,
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
  private statuses = new Map<string, RowStatus>();
  private selected = new Map<string, number>();
  private groups = new Map<string, NavigationGroup[]>();
  private debounce?: ReturnType<typeof setTimeout>;
  private repaintTimer?: ReturnType<typeof setTimeout>;
  private previousFocus?: HTMLElement;
  private sourceFrame?: FrameIdentity;
  private pendingReveal?: string;
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
      change: (change) => this.change(this.state.rows[0].id, change),
      navigate: (step) => this.navigate(this.state.rows[0].id, step),
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
    const row = this.state.rows[0];
    if (!row.query && seed) {
      row.query = seed;
      this.pendingReveal = row.id;
    }
    this.state.open = true;
    this.state.activeRowId = row.id;
    panel.show();
    this.commit();
    panel.focus();
  }

  close(): void {
    this.state.open = false;
    this.pendingReveal = undefined;
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

  private change(id: string, changes: Partial<SearchRow>): void {
    const row = this.state.rows.find((row) => row.id === id);
    if (!row) return;

    Object.assign(row, changes);
    this.state.activeRowId = id;
    if (
      "query" in changes ||
      "matchCase" in changes ||
      "wholeWord" in changes ||
      "regex" in changes
    ) {
      this.selected.set(id, 0);
      this.pendingReveal = id;
      this.pendingRevealRevision = -1;
      this.statuses.set(id, {
        current: 0,
        total: 0,
        truncated: false,
        pending: !!row.query,
      });
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
    let waiting = false;
    const visit = (documentId: string): void => {
      if (visited.has(documentId)) return;

      visited.add(documentId);
      const frame = byDocument.get(documentId);
      if (!frame || frame.path === null) {
        waiting = true;
        return;
      }
      reachable.push(frame);
      frame.childDocuments.forEach(visit);
    };
    visit(this.identity.documentId);
    const paint = new Map<string, RowPaint[]>();
    for (const row of this.state.rows) {
      const candidates: NavigationGroup[] = [];
      let pending = waiting;
      let truncated = false;
      const errors = new Set<string>();
      for (const frame of reachable) {
        const result = frame.rows.find((result) => result.id === row.id);
        if (!result) {
          pending = true;
          continue;
        }
        pending ||= result.pending ?? false;
        truncated ||= result.truncated;
        if (result.error) errors.add(result.error);
        for (const group of result.groups) {
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
      if (row.query && pending) {
        // Partial frame results must not reset the selected match or replace a
        // complete highlight set with an empty or incomplete one.
        const previous = this.statuses.get(row.id);
        this.statuses.set(row.id, {
          current: previous?.current ?? 0,
          total: previous?.total ?? 0,
          truncated: previous?.truncated ?? false,
          pending: true,
          error,
        });
        continue;
      }
      candidates.sort((a, b) => comparePath(a.path, b.path));
      const groups: NavigationGroup[] = [];
      let total = 0;
      for (const candidate of candidates) {
        const count = Math.min(candidate.count, MAX_MATCHES - total);
        if (count < candidate.count) truncated = true;
        if (count > 0) groups.push({ ...candidate, count, globalStart: total });
        total += count;
      }
      this.groups.set(row.id, groups);
      const current = Math.min(
        this.selected.get(row.id) ?? 0,
        Math.max(0, total - 1),
      );
      this.selected.set(row.id, current);
      this.statuses.set(row.id, {
        current,
        total,
        truncated,
        pending: false,
        error,
      });
      for (const frame of reachable) {
        const key = frameKey(frame.identity);
        const ownGroups = groups.filter(
          (group) => frameKey(group.identity) === key,
        );
        const activeGroup = groupContaining(ownGroups, current);
        const list = paint.get(key) ?? [];
        list.push({
          id: row.id,
          count: ownGroups.reduce((sum, group) => sum + group.count, 0),
          current: activeGroup ? localIndex(activeGroup, current) : -1,
        });
        paint.set(key, list);
      }
    }
    for (const frame of reachable) {
      const key = frameKey(frame.identity);
      const rows = paint.get(key);
      if (!rows) continue;

      const request = {
        queryRevision: this.state.revision,
        indexRevision: frame.indexRevision,
        rows,
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
    this.render();
    if (
      this.pendingReveal &&
      this.pendingRevealRevision === this.state.revision
    ) {
      const status = this.statuses.get(this.pendingReveal);
      if (status && !status.pending) {
        const id = this.pendingReveal;
        this.pendingReveal = undefined;
        if (status.total) this.reveal(id);
      }
    }
  }

  private navigate(id: string, step: number): void {
    const status = this.statuses.get(id);
    if (!status?.total || status.pending) return;

    this.selected.set(
      id,
      ((this.selected.get(id) ?? 0) + step + status.total) % status.total,
    );
    this.reconcile();
    this.reveal(id);
  }

  private reveal(id: string): void {
    const current = this.selected.get(id) ?? 0;
    const group = groupContaining(this.groups.get(id) ?? [], current);
    if (!group) return;

    void send({
      target: "background",
      type: "ROUTE",
      destination: group.identity,
      message: {
        target: "content",
        type: "NAVIGATE",
        rowId: id,
        localIndex: localIndex(group, current),
        queryRevision: this.state.revision,
        indexRevision: group.indexRevision,
      },
    });
  }

  private render(): void {
    const row = this.state.rows[0];
    this.panel?.update(row, this.statuses.get(row.id));
  }
}

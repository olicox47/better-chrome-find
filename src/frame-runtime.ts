import { indexPage, rangeFor, scrollRange, type PageIndex } from "./indexer";
import {
  CURRENT_MATCH_COLOUR,
  MATCH_COLOUR,
  OWN_ATTRIBUTE,
  pause,
  queryKey,
  send,
  type FrameIdentity,
  type MatchResult,
  type PaintRequest,
  type RowSummary,
  type TabState,
} from "./types";

interface CachedMatches {
  key: string;
  result?: MatchResult;
  pending?: Promise<void>;
}

interface ChildFrame {
  token: string;
  documentId: string;
  source: Window;
  element: HTMLIFrameElement | HTMLFrameElement;
}

const post = (target: Window, data: Record<string, unknown>): void =>
  target.postMessage({ source: "better-chrome-find", ...data }, "*");

export class FrameRuntime {
  private state?: TabState;
  private index?: PageIndex;
  private generation = 0;
  private indexRevision = 0;
  private building = false;
  private cache = new Map<string, CachedMatches>();
  private observer?: MutationObserver;
  private mutationTimer?: ReturnType<typeof setTimeout>;
  private maxMutationTimer?: ReturnType<typeof setTimeout>;
  private discoveryTimer?: ReturnType<typeof setInterval>;
  private sheets: HTMLStyleElement[] = [];
  private styleText = "";
  private highlights = new Set<string>();
  private paintGeneration = 0;
  private path: number[] | null = window === window.top ? [] : null;
  private children = new Map<Window, ChildFrame>();
  private token = crypto.randomUUID();
  private prefix = `better-chrome-find-${this.token}`;

  constructor(readonly identity: FrameIdentity) {
    window.addEventListener("message", (event) => this.frameMessage(event));
    window.addEventListener("resize", () => {
      if (this.state?.open) this.scheduleIndex();
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && this.state?.open) void this.rebuild();
    });
    if (window !== window.top) this.announceFrame();
  }

  setState(state: TabState): void {
    if (this.state?.revision !== state.revision) this.paintGeneration++;
    this.state = state;
    if (!state.open) {
      this.dispose();
      return;
    }

    if (state.rows.every((row) => !row.query)) this.clearHighlights();

    if (!this.index && !this.building) {
      void this.rebuild();
    } else if (this.index) void this.searchRows();
  }

  private announceFrame(): void {
    post(window.parent, {
      type: "FRAME_READY",
      token: this.token,
      documentId: this.identity.documentId,
    });
  }

  private findFrames(): (HTMLIFrameElement | HTMLFrameElement)[] {
    const result: (HTMLIFrameElement | HTMLFrameElement)[] = [];
    const visit = (root: Document | ShadowRoot): void => {
      for (const element of root.querySelectorAll("*")) {
        if (
          element instanceof HTMLIFrameElement ||
          element instanceof HTMLFrameElement
        ) {
          result.push(element);
        }
        if (element.shadowRoot && !element.hasAttribute(OWN_ATTRIBUTE)) {
          visit(element.shadowRoot);
        }
      }
    };
    visit(document);

    return result;
  }

  private frameMessage(event: MessageEvent): void {
    const data = event.data;
    if (!data || data.source !== "better-chrome-find" || !event.source) return;

    if (
      data.type === "FRAME_READY" &&
      typeof data.token === "string" &&
      typeof data.documentId === "string"
    ) {
      const element = this.findFrames().find(
        (frame) => frame.contentWindow === event.source,
      );
      if (!element) return;

      this.children.set(event.source as Window, {
        element,
        source: event.source as Window,
        token: data.token,
        documentId: data.documentId,
      });
      this.positionChildren();
      if (this.state?.open) this.report();
    } else if (
      data.type === "FRAME_LOCATION" &&
      event.source === window.parent &&
      data.token === this.token
    ) {
      if (
        !Array.isArray(data.path) ||
        !data.path.every((entry: unknown) => Number.isInteger(entry))
      ) {
        return;
      }

      this.path = data.path;
      this.positionChildren();

      if (this.state?.open) this.report();
    } else if (data.type === "DISCOVER" && event.source === window.parent) {
      this.announceFrame();
    } else if (data.type === "REVEAL") {
      const child = this.children.get(event.source as Window);
      if (!child || child.token !== data.token || !child.element.isConnected) {
        return;
      }

      child.element.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      this.revealParent();
    }
  }

  private positionChildren(): void {
    for (const [source, child] of this.children) {
      if (
        !child.element.isConnected ||
        child.element.contentWindow !== source
      ) {
        this.children.delete(source);
        continue;
      }

      const frame = this.index?.frames.find(
        (frame) => frame.element === child.element,
      );
      if (frame && this.path) {
        post(source, {
          type: "FRAME_LOCATION",
          token: child.token,
          path: [...this.path, frame.order],
        });
      }
    }
  }

  private revealParent(): void {
    if (window !== window.top) {
      post(window.parent, { type: "REVEAL", token: this.token });
    }
  }

  private scheduleIndex(): void {
    if (!this.state?.open) return;

    clearTimeout(this.mutationTimer);
    this.mutationTimer = setTimeout(() => void this.rebuild(), 200);
    this.maxMutationTimer ??= setTimeout(() => void this.rebuild(), 1000);
  }

  private observe(): void {
    this.observer?.disconnect();
    this.observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        if (target?.closest(`[${OWN_ATTRIBUTE}]`)) return false;

        if (
          record.type === "childList" &&
          [...record.addedNodes, ...record.removedNodes].every(
            (node) =>
              node instanceof Element && node.hasAttribute(OWN_ATTRIBUTE),
          )
        ) {
          return false;
        }

        return true;
      });
      if (relevant) this.scheduleIndex();
    });
    for (const root of this.index?.roots ?? [document]) {
      this.observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "open", "slot"],
      });
    }
    if (!this.discoveryTimer) {
      this.discoveryTimer = setInterval(() => {
        // Shadow-root attachment itself does not create a mutation record.
        let rootCount = 1;
        for (const root of this.index?.roots ?? []) {
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot && !element.hasAttribute(OWN_ATTRIBUTE)) {
              rootCount++;
            }
          }
        }
        if (rootCount !== this.index?.roots.length) this.scheduleIndex();
      }, 1500);
    }
  }

  private clearMutationTimers(): void {
    clearTimeout(this.mutationTimer);
    clearTimeout(this.maxMutationTimer);
    this.maxMutationTimer = undefined;
  }

  private async rebuild(): Promise<void> {
    this.clearMutationTimers();
    if (!this.state?.open) return;

    const generation = ++this.generation;
    this.indexRevision++;
    this.building = true;
    this.cache.clear();
    this.paintGeneration++;
    this.report();
    await send({ target: "background", type: "CANCEL" }).catch(() => {});

    try {
      const index = await indexPage(
        document,
        () => generation !== this.generation || !this.state?.open,
      );
      if (generation !== this.generation) return;

      this.index = index;
      this.building = false;
      this.positionChildren();
      for (const frame of index.frames) {
        const target = frame.element.contentWindow;
        if (target) post(target, { type: "DISCOVER" });
      }
      if (window !== window.top) this.announceFrame();
      this.observe();
      await this.searchRows();
    } catch (error) {
      if (generation !== this.generation) return;

      this.building = false;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        for (const row of this.state?.rows ?? []) {
          this.cache.set(row.id, {
            key: "",
            result: {
              matches: [],
              truncated: false,
              error:
                "This page changed before it could be indexed. Edit a search to retry.",
            },
          });
        }
        this.report();
      }
    }
  }

  private async searchRows(): Promise<void> {
    if (!this.state?.open || !this.index || this.building) return;

    const generation = this.generation;
    const index = this.index;
    for (const key of this.cache.keys()) {
      if (!this.state.rows.some((row) => row.id === key)) {
        this.cache.delete(key);
      }
    }

    const promises = this.state.rows.map(async (row) => {
      const key = queryKey(row);
      const existing = this.cache.get(row.id);
      if (existing?.key === key) return existing.pending;

      const cached: CachedMatches = { key };
      this.cache.set(row.id, cached);
      if (!row.query) {
        cached.result = { matches: [], truncated: false };
        return;
      }

      cached.pending = (async () => {
        const result = await send<MatchResult>({
          target: "background",
          type: "MATCH",
          request: {
            row,
            blocks: index.blocks.map(({ text, order }) => ({ text, order })),
            queryRevision: this.state!.revision,
            indexRevision: this.indexRevision,
          },
        }).catch(
          (): MatchResult => ({
            matches: [],
            truncated: false,
            error: "Search connection lost. Edit the query to retry.",
          }),
        );
        if (
          generation !== this.generation ||
          this.cache.get(row.id) !== cached ||
          !this.state?.open
        ) {
          return;
        }

        if (result.cancelled) {
          this.cache.delete(row.id);
          return;
        }

        cached.result = result;
        cached.pending = undefined;
        this.report();
      })();

      return cached.pending;
    });
    this.report();
    await Promise.all(promises);
  }

  private report(): void {
    if (!this.state?.open) return;

    const rows: RowSummary[] = this.state.rows.map((row) => {
      const cached = this.cache.get(row.id);
      const groups: RowSummary["groups"] = [];
      if (!this.building && cached?.result) {
        cached.result.matches?.forEach((match, first) => {
          const order = this.index?.blocks[match.block]?.order;
          if (order === undefined) return;

          const last = groups.at(-1);
          if (last?.order === order) {
            last.count++;
          } else {
            groups.push({ order, count: 1, first });
          }
        });
      }
      return {
        id: row.id,
        groups,
        truncated: cached?.result?.truncated ?? false,
        error: cached?.result?.error,
        pending: this.building || (!!row.query && !cached?.result),
      };
    });

    const childDocuments = [...this.children.values()]
      .filter(
        (child) =>
          child.element.isConnected &&
          this.index?.frames.some((frame) => frame.element === child.element),
      )
      .map((child) => child.documentId);

    void send({
      target: "background",
      type: "SUMMARY",
      summary: {
        queryRevision: this.state.revision,
        indexRevision: this.indexRevision,
        path: this.path,
        childDocuments,
        rows,
      },
    }).catch(() => {});
  }

  private clearHighlights(): void {
    this.paintGeneration++;

    for (const key of this.highlights) CSS.highlights.delete(key);
    this.highlights.clear();

    for (const sheet of this.sheets) sheet.remove();
    this.sheets = [];

    this.styleText = "";
  }

  private isCurrent(queryRevision: number, indexRevision: number): boolean {
    return (
      !!this.state?.open &&
      !!this.index &&
      !this.building &&
      queryRevision === this.state.revision &&
      indexRevision === this.indexRevision
    );
  }

  async paint(request: PaintRequest): Promise<void> {
    if (!this.isCurrent(request.queryRevision, request.indexRevision)) return;

    const generation = ++this.paintGeneration;
    const index = this.index!;
    const currentRequest = (): boolean =>
      generation === this.paintGeneration &&
      this.isCurrent(request.queryRevision, request.indexRevision);
    const rules: string[] = [];
    const prepared: [string, Highlight][] = [];
    let tick = performance.now();
    for (const row of request.rows) {
      const matches = this.cache.get(row.id)?.result?.matches ?? [];
      const name = `${this.prefix}-${row.id}`;
      const highlight = new Highlight();
      highlight.priority = 20;
      for (let i = 0; i < Math.min(row.count, matches.length); i++) {
        if (performance.now() - tick > 8) {
          await pause();
          tick = performance.now();
        }
        if (!currentRequest()) return;

        const range = rangeFor(index, matches[i]);
        if (range) highlight.add(range);
      }
      prepared.push([name, highlight]);
      rules.push(
        `::highlight(${name}){background-color:${MATCH_COLOUR};color:#000000;}`,
      );
      rules.push(
        `::highlight(${name}-current){background-color:${CURRENT_MATCH_COLOUR};color:#000000;text-decoration:underline solid #000000 2px;}`,
      );
      if (row.current >= 0 && row.current < row.count && matches[row.current]) {
        const range = rangeFor(index, matches[row.current]);
        if (range) {
          const current = new Highlight(range);
          current.priority = 100;
          prepared.push([`${name}-current`, current]);
        }
      }
    }
    if (!currentRequest()) return;

    // Keep the previous paint through chunked range creation. Publish styles and
    // ranges together without yielding, so there is no unhighlighted frame.
    const styleText = rules.join("\n");
    if (
      this.styleText !== styleText ||
      this.sheets.length !== index.roots.length ||
      this.sheets.some(
        (sheet, position) =>
          !sheet.isConnected || sheet.getRootNode() !== index.roots[position],
      )
    ) {
      const sheets = index.roots.map((root) => {
        const sheet = document.createElement("style");
        sheet.setAttribute(OWN_ATTRIBUTE, "highlights");
        sheet.textContent = styleText;
        (root instanceof Document ? root.documentElement : root).append(sheet);
        return sheet;
      });
      for (const sheet of this.sheets) sheet.remove();
      this.sheets = sheets;
      this.styleText = styleText;
    }
    const names = new Set(prepared.map(([key]) => key));
    for (const [key, highlight] of prepared) CSS.highlights.set(key, highlight);
    for (const key of this.highlights) {
      if (!names.has(key)) CSS.highlights.delete(key);
    }
    this.highlights = names;
  }

  navigate(
    rowId: string,
    localIndex: number,
    queryRevision: number,
    indexRevision: number,
  ): void {
    if (!this.isCurrent(queryRevision, indexRevision)) return;

    const match = this.cache.get(rowId)?.result?.matches?.[localIndex];
    const range = match && rangeFor(this.index!, match);
    if (range) {
      scrollRange(range);
      this.revealParent();
    }
  }

  dispose(): void {
    this.generation++;
    this.building = false;
    this.clearMutationTimers();
    clearInterval(this.discoveryTimer);
    this.discoveryTimer = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.index = undefined;
    this.cache.clear();
    this.clearHighlights();
    void send({ target: "background", type: "CANCEL" }).catch(() => {});
  }
}

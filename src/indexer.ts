import {
  OWN_ATTRIBUTE,
  pause,
  type MatchOffset,
  type TextBlock,
} from "./types";

export interface TextSpan {
  node: Text | Element;
  start: number;
  end: number;
  offsets?: number[];
}

export interface IndexedBlock extends TextBlock {
  spans: TextSpan[];
}

export interface IndexedFrame {
  element: HTMLIFrameElement | HTMLFrameElement;
  order: number;
}

export interface PageIndex {
  blocks: IndexedBlock[];
  frames: IndexedFrame[];
  roots: (Document | ShadowRoot)[];
}

const excluded = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "CANVAS",
  "SVG",
  "VIDEO",
  "AUDIO",
  "OBJECT",
  "EMBED",
]);

export const indexPage = async (
  document: Document,
  cancelled: () => boolean = () => false,
): Promise<PageIndex> => {
  const blocks: IndexedBlock[] = [];
  const frames: IndexedFrame[] = [];
  const roots: (Document | ShadowRoot)[] = [document];
  let text = "";
  let spans: TextSpan[] = [];
  let order = 0;
  let tick = performance.now();
  let blockRoot: Node | null = null;

  const flush = (): void => {
    if (text.length) blocks.push({ text, spans, order: order++ });

    text = "";
    spans = [];
    blockRoot = null;
  };

  const enterRoot = (node: Node): void => {
    const root = node.getRootNode();
    if (blockRoot && blockRoot !== root) flush();
    blockRoot = root;
  };

  const checkCancelled = (): void => {
    if (cancelled()) throw new DOMException("Index cancelled", "AbortError");
  };

  const append = async (node: Text, preserve: boolean): Promise<void> => {
    if (!node.data) return;

    enterRoot(node);

    if (preserve) {
      spans.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
      return;
    }

    let normalized = "";
    const offsets: number[] = [];
    const source = node.data;

    for (let i = 0; i < source.length; ) {
      if (i % 4096 === 0 && performance.now() - tick > 8) {
        await pause();
        tick = performance.now();
        checkCancelled();
      }

      const start = i;
      if (/[\t\n\r\f ]/.test(source[i])) {
        while (i < source.length && /[\t\n\r\f ]/.test(source[i])) i++;
        if ((!text && !normalized) || (normalized || text).endsWith(" ")) {
          continue;
        }
        offsets.push(start);
        normalized += " ";
      } else {
        offsets.push(i++);
        normalized += source[start];
      }
    }

    if (!normalized) return;

    offsets.push(source.length);
    spans.push({
      node,
      start: text.length,
      end: text.length + normalized.length,
      offsets: normalized === source ? undefined : offsets,
    });
    text += normalized;
  };

  const visit = async (node: Node, preserve = false): Promise<void> => {
    checkCancelled();

    if (performance.now() - tick > 8) {
      await pause();
      tick = performance.now();
    }

    if (node.nodeType === Node.TEXT_NODE) {
      await append(node as Text, preserve);
      return;
    }

    if (!(node instanceof Element)) return;

    if (node.hasAttribute(OWN_ATTRIBUTE) || excluded.has(node.tagName)) {
      flush();
      return;
    }

    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.contentVisibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      flush();
      return;
    }

    if (node.tagName === "BR") {
      enterRoot(node);
      spans.push({
        node,
        start: text.length,
        end: text.length + 1,
        offsets: [0, 0],
      });
      text += "\n";
      return;
    }

    const boundary = !["inline", "contents"].includes(style.display);
    if (boundary) flush();

    const hidden =
      style.visibility === "hidden" || style.visibility === "collapse";
    if (node instanceof HTMLIFrameElement || node instanceof HTMLFrameElement) {
      if (!hidden) frames.push({ element: node, order: order++ });
      return;
    }

    preserve = /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace);
    let children: Node[];
    if (node.shadowRoot) {
      roots.push(node.shadowRoot);
      children = [...node.shadowRoot.childNodes];
    } else if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      children = assigned.length ? assigned : [...node.childNodes];
    } else {
      children = [...node.childNodes];
    }

    for (const child of children) {
      if (hidden && child.nodeType === Node.TEXT_NODE) continue;

      await visit(child, preserve);
    }

    if (boundary) flush();
  };

  if (document.body) await visit(document.body);

  flush();
  return { blocks, frames, roots };
};

export const rangeFor = (
  index: PageIndex,
  match: MatchOffset,
): Range | null => {
  const block = index.blocks[match.block];
  if (!block) return null;

  const findSpan = (offset: number, end: boolean): TextSpan | undefined => {
    let low = 0;
    let high = block.spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (
        end
          ? block.spans[middle].end >= offset
          : block.spans[middle].end > offset
      ) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    return block.spans[low];
  };

  const first = findSpan(match.start, false);
  const last = findSpan(match.end, true);
  if (!first?.node.isConnected || !last?.node.isConnected) return null;

  const start =
    first.offsets?.[match.start - first.start] ?? match.start - first.start;
  const end = last.offsets?.[match.end - last.start] ?? match.end - last.start;
  const length = (node: Text | Element): number =>
    node instanceof Text ? node.length : node.childNodes.length;
  if (start > length(first.node) || end > length(last.node)) return null;

  const range = document.createRange();
  range.setStart(first.node, start);
  range.setEnd(last.node, end);
  return range;
};

export const scrollRange = (range: Range): void => {
  let element =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  while (element) {
    const rect = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      element.scrollHeight > element.clientHeight
    ) {
      element.scrollTop +=
        rect.top + rect.height / 2 - box.top - element.clientHeight / 2;
    }
    if (
      /(auto|scroll)/.test(style.overflowX) &&
      element.scrollWidth > element.clientWidth
    ) {
      element.scrollLeft +=
        rect.left + rect.width / 2 - box.left - element.clientWidth / 2;
    }
    element =
      element.parentElement ??
      (element.getRootNode() instanceof ShadowRoot
        ? (element.getRootNode() as ShadowRoot).host
        : null);
  }

  const rect = range.getBoundingClientRect();
  window.scrollBy({
    top: rect.top + rect.height / 2 - innerHeight / 2,
    left:
      rect.left < 0 || rect.right > innerWidth
        ? rect.left + rect.width / 2 - innerWidth / 2
        : 0,
    behavior: "instant",
  });
};

import styles from "./panel.css?inline";
import {
  MAX_MATCHES,
  OWN_ATTRIBUTE,
  type RowStatus,
  type SearchRow,
} from "./types";

interface Callbacks {
  change: (changes: Partial<SearchRow>) => void;
  navigate: (step: number) => void;
  close: () => void;
}

const toggleOptions = [
  ["matchCase", "Match case", "Aa"],
  ["wholeWord", "Match whole word", "ab"],
  ["regex", "Use regular expression", ".*"],
] as const;

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};

const button = (
  label: string,
  text: string,
  handler: () => void,
  className = "",
): HTMLButtonElement => {
  const value = element("button", className, text);
  value.type = "button";
  value.title = label;
  value.setAttribute("aria-label", label);
  value.addEventListener("click", handler);
  return value;
};

export class Panel {
  readonly host = element("div");
  readonly shadow = this.host.attachShadow({ mode: "open" });
  private input = element("input", "query");
  private count = element("span", "count");
  private countValue = element("span", "", "0 / 0");
  private error = element("p", "error");
  private announcer = element("div", "sr-only");
  private toggles: HTMLButtonElement[];
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private row?: SearchRow;
  private announceTimer?: ReturnType<typeof setTimeout>;

  constructor(private callbacks: Callbacks) {
    this.host.setAttribute(OWN_ATTRIBUTE, "panel");
    this.host.style.cssText =
      "all:initial;display:none;position:fixed;inset:auto 12px auto auto;top:12px;width:min(378px,calc(100vw - 24px));height:auto;max-height:calc(100vh - 24px);overflow:auto;margin:0;padding:0;border:0;background:transparent;z-index:2147483647;color-scheme:light;border-radius:6px;box-shadow:0 2px 8px #00000026;";
    this.host.setAttribute("popover", "manual");

    const style = element("style");
    style.textContent = styles;

    const panel = element("section", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Page search");

    const row = element("div", "row");

    const controls = element("div", "controls");

    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.placeholder = "Find on page…";
    this.input.setAttribute("aria-label", "Find on page");
    this.input.addEventListener("input", () =>
      callbacks.change({ query: this.input.value }),
    );

    this.toggles = toggleOptions.map(([key, label, text]) =>
      button(
        label,
        text,
        () => {
          if (this.row) callbacks.change({ [key]: !this.row[key] });
          this.focus(false);
        },
        `toggle ${key === "wholeWord" ? "whole" : ""}`,
      ),
    );
    const toggleGroup = element("div", "toggles");
    toggleGroup.append(...this.toggles);

    this.count.dataset.reservedCount = `${MAX_MATCHES.toLocaleString()} / ${MAX_MATCHES.toLocaleString()}+`;
    this.count.title = "Current match / total matches";
    this.count.append(this.countValue);

    this.previous = button("Previous match (Shift+Enter)", "↑", () => {
      callbacks.navigate(-1);
      this.focus(false);
    });

    this.next = button("Next match (Enter)", "↓", () => {
      callbacks.navigate(1);
      this.focus(false);
    });

    this.error.id = "search-error";
    this.input.setAttribute("aria-describedby", this.error.id);

    controls.append(
      this.input,
      toggleGroup,
      this.count,
      this.previous,
      this.next,
      button("Close search (Escape)", "×", callbacks.close),
    );
    row.append(controls, this.error);

    this.announcer.setAttribute("role", "status");
    this.announcer.setAttribute("aria-live", "polite");
    panel.append(row, this.announcer);
    this.shadow.append(style, panel);

    document.documentElement.append(this.host);
  }

  show(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
    this.host.style.display = "block";
    if (!this.host.matches(":popover-open")) this.host.showPopover();
  }

  hide(): void {
    if (this.host.matches(":popover-open")) this.host.hidePopover();
    this.host.style.display = "none";
  }

  handleKeyboardEvent(event: KeyboardEvent): boolean {
    if (!event.composedPath().includes(this.host)) return false;

    // Window capture keeps page shortcut handlers from seeing these events.
    // Ordinary editing retains its browser default.
    if (event.type !== "keydown" || event.isComposing) return true;

    if (event.key === "Escape") {
      event.preventDefault();
      this.callbacks.close();
    } else if (
      event.key.toLowerCase() === "f" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      this.focus();
    } else if (
      event.key === "Enter" &&
      event.composedPath()[0] === this.input
    ) {
      event.preventDefault();
      if (!event.ctrlKey && !event.metaKey) {
        this.callbacks.navigate(event.shiftKey ? -1 : 1);
      }
    }

    return true;
  }

  focus(select = true): void {
    this.input.focus({ preventScroll: true });
    if (select) this.input.select();
  }

  update(row: SearchRow, status?: RowStatus): void {
    this.row = row;
    if (this.input.value !== row.query) this.input.value = row.query;
    toggleOptions.forEach(([key], index) =>
      this.toggles[index].setAttribute("aria-pressed", String(row[key])),
    );
    const total = status?.total ?? 0;
    const current = status?.total ? status.current + 1 : 0;
    if (!status?.pending) {
      this.countValue.textContent = `${current.toLocaleString()} / ${total.toLocaleString()}${status?.truncated ? "+" : ""}`;
      this.count.title = status?.truncated
        ? "Showing the first 10,000 matches across this tab."
        : "Current match / total matches";
    }
    this.error.textContent = status?.error ?? "";
    this.input.setAttribute("aria-invalid", String(Boolean(status?.error)));
    this.previous.disabled = this.next.disabled =
      !status?.total || !!status.pending;
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      this.announcer.textContent =
        status?.error ||
        (status?.pending
          ? "Searching"
          : `${current} of ${total}${status?.truncated ? " or more" : ""} matches`);
    }, 250);
  }
}

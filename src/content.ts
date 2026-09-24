import { Coordinator } from "./coordinator";
import { FrameRuntime } from "./frame-runtime";
import {
  focusedElement,
  send,
  type ContentMessage,
  type TabState,
} from "./types";

const global = globalThis as typeof globalThis & {
  __betterChromeFindInstalled?: boolean;
};
if (
  !global.__betterChromeFindInstalled &&
  document.contentType !== "application/pdf"
) {
  global.__betterChromeFindInstalled = true;
  let state: TabState | undefined;
  let coordinator: Coordinator | undefined;
  let previousFocus: HTMLElement | undefined;
  let initialised = false;
  let enabled = false;
  let enablementReceived = false;
  let runtimeInstance: FrameRuntime | undefined;
  const gated = (next: TabState): TabState =>
    enabled ? next : { ...next, open: false };
  const ready = (async () => {
    const hello = await send({ target: "background", type: "HELLO" });
    if (!("identity" in hello)) {
      throw new Error("Extension connection unavailable.");
    }

    if (!enablementReceived) enabled = hello.enabled;
    state = gated(hello.state);
    initialised = true;
    if (!document.body) {
      await new Promise<void>((resolve) =>
        document.addEventListener("DOMContentLoaded", () => resolve(), {
          once: true,
        }),
      );
    }
    const runtime = (runtimeInstance = new FrameRuntime(hello.identity));
    if (window === window.top) {
      coordinator = new Coordinator(hello.identity, state);
    }
    runtime.setState(state);
    return runtime;
  })();
  void ready.catch(() => {
    initialised = false;
  });

  chrome.runtime.onMessage.addListener(
    (message: ContentMessage, _sender, reply) => {
      if (message?.target !== "content") return;

      // Preference changes must not wait for a loading page's DOMContentLoaded.
      if (message.type === "ENABLEMENT") {
        enablementReceived = true;
        enabled = message.enabled;
        if (!enabled) {
          if (coordinator?.state.open) coordinator.close();
          if (state) {
            state = { ...state, open: false };
            runtimeInstance?.setState(state);
          }
        }
        reply({ ok: true });
        return;
      }
      void ready
        .then(async (runtime) => {
          switch (message.type) {
            case "PING":
              break;
            case "STATE":
              if (state && state.revision > message.state.revision) break;
              state = gated(message.state);
              coordinator?.receiveState(state);
              runtime.setState(state);
              break;
            case "OPEN":
              if (!enabled) break;
              coordinator?.open(
                message.seed ?? window.getSelection()?.toString(),
                message.source,
              );
              break;
            case "CLOSE":
              coordinator?.close();
              break;
            case "SUMMARY":
              coordinator?.receiveSummary(message.summary);
              break;
            case "PAINT":
              await runtime.paint(message.request);
              break;
            case "NAVIGATE":
              runtime.navigate(
                message.localIndex,
                message.queryRevision,
                message.indexRevision,
              );
              break;
            case "RESTORE_FOCUS":
              previousFocus?.focus({ preventScroll: true });
              break;
          }
          reply({ ok: true });
        })
        .catch(() =>
          reply({ error: "Reload this page to reconnect Better Chrome Find." }),
        );
      return true;
    },
  );
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const panelKeys = new Set<string>();
  // Capture before page listeners: Shadow DOM retargets inputs to the panel host,
  // so sites cannot reliably recognise them as editable fields themselves.
  for (const type of ["keydown", "keypress", "keyup"] as const) {
    window.addEventListener(
      type,
      (event) => {
        if (!chrome.runtime?.id || !initialised) return;

        const owned = coordinator?.handlePanelKeyboardEvent(event);
        const finishing =
          event.type === "keyup" && panelKeys.delete(event.code);
        if (owned || finishing) {
          if (event.type === "keydown") panelKeys.add(event.code);
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }
  window.addEventListener("blur", () => panelKeys.clear());
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.isComposing ||
        !chrome.runtime?.id ||
        !initialised ||
        !enabled
      ) {
        return;
      }
      const find =
        event.key.toLowerCase() === "f" &&
        (isMac
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) &&
        !event.altKey &&
        !event.shiftKey;
      if (find) {
        event.preventDefault();
        event.stopImmediatePropagation();
        previousFocus = focusedElement();
        void send({
          target: "background",
          type: "OPEN",
          seed: window.getSelection()?.toString(),
        }).catch(() => {});
      } else if (
        event.key === "Escape" &&
        (coordinator?.state.open ?? state?.open)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (coordinator) {
          coordinator.close();
        } else {
          void send({ target: "background", type: "CLOSE" });
        }
      }
    },
    true,
  );
  window.addEventListener("pagehide", () => {
    void ready.then((runtime) => runtime.dispose());
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      void ready.then(async (runtime) => {
        const hello = await send({ target: "background", type: "HELLO" });
        if (!("identity" in hello)) return;

        enabled = hello.enabled;
        state = hello.state;
        coordinator?.receiveState(state);
        runtime.setState(state);
      });
    }
  });
}

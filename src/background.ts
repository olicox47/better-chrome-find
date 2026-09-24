import {
  createState,
  frameKey,
  singleSearchState,
  type BackgroundMessage,
  type ContentMessage,
  type FrameIdentity,
  type TabState,
} from "./types";

import {
  enabledOn,
  hostnameOf,
  readPreferences,
  supportedPage,
  type ToolbarState,
} from "./preferences";

let preferenceQueue: Promise<unknown> = Promise.resolve();

const toolbarState = async (tabId: number): Promise<ToolbarState> => {
  const [tab, preferences] = await Promise.all([
    chrome.tabs.get(tabId),
    readPreferences(),
  ]);
  return {
    preferences,
    hostname: hostnameOf(tab.url),
    supported: supportedPage(tab.url),
    enabled: enabledOn(preferences, tab.url),
  };
};

const setEnabled = async (
  tabId: number,
  scope: "global" | "site",
  enabled: boolean,
): Promise<ToolbarState> => {
  const next = preferenceQueue
    .catch(() => {})
    .then(async () => {
      const menu = await toolbarState(tabId);
      if (scope === "global") {
        menu.preferences.enabled = enabled;
      } else {
        if (!menu.hostname || !menu.supported) {
          throw new Error("Site controls are available on regular webpages.");
        }
        const sites = new Set(menu.preferences.disabledSites);
        if (enabled) {
          sites.delete(menu.hostname);
        } else {
          sites.add(menu.hostname);
        }
        menu.preferences.disabledSites = [...sites];
      }
      await chrome.storage.local.set({ enablement: menu.preferences });
      const tabs = await chrome.tabs.query({});
      await Promise.all(
        tabs.map((tab) =>
          tab.id === undefined
            ? undefined
            : deliver(tab.id, {
                target: "content",
                type: "ENABLEMENT",
                enabled: enabledOn(menu.preferences, tab.url),
              }).catch(() => {}),
        ),
      );
      return toolbarState(tabId);
    });
  preferenceQueue = next;
  return next;
};

const tabQueues = new Map<number, Promise<unknown>>();
let creatingOffscreen: Promise<void> | undefined;

const sessionKey = (tabId: number): string => `tab:${tabId}`;

const closeIfDisabled = async (
  tabId: number,
  value: TabState,
): Promise<void> => {
  if (value.open && !(await toolbarState(tabId)).enabled) {
    value.open = false;
    value.revision++;
  }
};

const state = async (tabId: number): Promise<TabState> => {
  const saved = (await chrome.storage.session.get(sessionKey(tabId)))[
    sessionKey(tabId)
  ] as TabState | undefined;
  const value = saved ? singleSearchState(saved) : createState();
  await closeIfDisabled(tabId, value);
  if (JSON.stringify(value) !== JSON.stringify(saved)) {
    await chrome.storage.session.set({ [sessionKey(tabId)]: value });
  }
  return value;
};

const serial = <T>(tabId: number, task: () => Promise<T>): Promise<T> => {
  const next = (tabQueues.get(tabId) ?? Promise.resolve())
    .catch(() => {})
    .then(task);
  tabQueues.set(tabId, next);
  void next
    .finally(() => {
      if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
    })
    .catch(() => {});
  return next;
};

const hasOffscreen = async (): Promise<boolean> =>
  (
    await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    })
  ).length > 0;

const ensureOffscreen = async (): Promise<void> => {
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    if (!(await hasOffscreen())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          "Run page searches in terminable workers so regular expressions cannot freeze webpages.",
      });
    }
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = undefined;
  }
};

const deliver = async (
  tabId: number,
  message: ContentMessage,
  frameId?: number,
  documentId?: string,
): Promise<unknown> => {
  return chrome.tabs.sendMessage(
    tabId,
    message,
    documentId
      ? { documentId }
      : frameId === undefined
        ? undefined
        : { frameId },
  );
};

const activate = async (
  tabId: number,
): Promise<{ ok: boolean; error?: string }> => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!supportedPage(tab.url)) {
      return {
        ok: false,
        error:
          "Better Chrome Find searches regular webpages. Chrome internal pages, the Web Store and built-in document viewers use native Find.",
      };
    }
    if (!(await toolbarState(tabId)).enabled) {
      return {
        ok: false,
        error:
          "Better Chrome Find is disabled here. Enable it in the toolbar menu to search.",
      };
    }
    try {
      await deliver(tabId, { target: "content", type: "OPEN" }, 0);
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"],
      });
      await deliver(tabId, { target: "content", type: "OPEN" }, 0);
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        "This page cannot be searched. PDFs and restricted browser pages use native Find. For webpages, allow site access for Better Chrome Find and reload the page.",
    };
  }
};

const identityOf = (sender: chrome.runtime.MessageSender): FrameIdentity => {
  if (
    sender.tab?.id === undefined ||
    sender.frameId === undefined ||
    !sender.documentId
  ) {
    throw new Error("A webpage sender is required.");
  }
  return {
    tabId: sender.tab.id,
    frameId: sender.frameId,
    documentId: sender.documentId,
  };
};

const handle = async (
  message: BackgroundMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> => {
  if (message.type === "TOOLBAR_STATE" || message.type === "SET_ENABLED") {
    if (!sender.url?.startsWith(chrome.runtime.getURL(""))) {
      throw new Error("Only extension pages can change enablement.");
    }
    if (message.type === "TOOLBAR_STATE") return toolbarState(message.tabId);

    if (
      typeof message.enabled !== "boolean" ||
      !["global", "site"].includes(message.scope)
    ) {
      throw new Error("Invalid enablement preference.");
    }
    return setEnabled(message.tabId, message.scope, message.enabled);
  }
  if (message.type === "ACTIVATE") {
    if (!sender.url?.startsWith(chrome.runtime.getURL(""))) {
      throw new Error("Only extension pages can activate tabs.");
    }
    return activate(message.tabId);
  }
  const identity = identityOf(sender);
  const { tabId, frameId } = identity;
  if (sender.documentLifecycle && sender.documentLifecycle !== "active") {
    return { ignored: true };
  }
  switch (message.type) {
    case "HELLO":
      return serial(tabId, async () => ({
        identity,
        state: await state(tabId),
        enabled: (await toolbarState(tabId)).enabled,
      }));
    case "SAVE_STATE":
      return serial(tabId, async () => {
        if (frameId !== 0) {
          throw new Error("Only the top frame controls tab state.");
        }
        const current = await state(tabId);
        if (message.state.revision < current.revision) return current;

        if (
          !Array.isArray(message.state.rows) ||
          message.state.rows.length !== 1
        ) {
          throw new Error("Exactly one search is supported.");
        }
        const value = singleSearchState(message.state);
        await closeIfDisabled(tabId, value);
        await chrome.storage.session.set({ [sessionKey(tabId)]: value });
        await deliver(tabId, {
          target: "content",
          type: "STATE",
          state: value,
        }).catch(() => {});
        return value;
      });
    case "OPEN":
      if (!(await toolbarState(tabId)).enabled) return { ok: false };
      return deliver(
        tabId,
        {
          target: "content",
          type: "OPEN",
          seed: message.seed,
          source: identity,
        },
        0,
      );
    case "CLOSE":
      return deliver(tabId, { target: "content", type: "CLOSE" }, 0);
    case "MATCH": {
      await ensureOffscreen();
      return chrome.runtime.sendMessage({
        target: "offscreen",
        type: "MATCH",
        key: `${frameKey(identity)}/${message.request.row.id}`,
        prefix: frameKey(identity),
        request: message.request,
      });
    }
    case "CANCEL": {
      if (await hasOffscreen()) {
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "CANCEL",
          prefix: frameKey(identity),
        });
      }
      return { ok: true };
    }
    case "SUMMARY":
      return deliver(
        tabId,
        {
          target: "content",
          type: "SUMMARY",
          summary: { ...message.summary, identity },
        },
        0,
      ).catch(() => {});
    case "ROUTE": {
      if (frameId !== 0 || message.destination.tabId !== tabId) {
        throw new Error("Invalid frame route.");
      }
      return deliver(
        tabId,
        message.message,
        undefined,
        message.destination.documentId,
      ).catch(() => ({ missing: true }));
    }
  }
};

chrome.runtime.onMessage.addListener(
  (message: BackgroundMessage, sender, reply) => {
    if (message?.target !== "background" || sender.id !== chrome.runtime.id) {
      return;
    }
    void handle(message, sender).then(reply, (error) =>
      reply({
        error:
          error instanceof Error ? error.message : "Extension request failed.",
      }),
    );
    return true;
  },
);
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(sessionKey(tabId));
});
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-find") return;

  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(async ([tab]) => {
      if (tab?.id === undefined) return;

      const result = await activate(tab.id);
      if (!result.ok) await chrome.action.openPopup().catch(() => {});
    });
});

import {
  createState,
  frameKey,
  readState,
  type ActivateResponse,
  type BackgroundMessage,
  type BackgroundMessageType,
  type BackgroundReplies,
  type ContentMessage,
  type ExtensionPageMessageType,
  type FrameIdentity,
  type IgnoredReply,
  type MatchResult,
  type MessageOf,
  type OffscreenMessage,
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
  const saved: unknown = (await chrome.storage.session.get(sessionKey(tabId)))[
    sessionKey(tabId)
  ];
  const value = readState(saved) ?? createState();
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

const activate = async (tabId: number): Promise<ActivateResponse> => {
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

const toOffscreen = <R>(message: OffscreenMessage): Promise<R> =>
  chrome.runtime.sendMessage(message);

type FrameMessageType = Exclude<BackgroundMessageType, ExtensionPageMessageType>;

const extensionPageHandlers: {
  [T in ExtensionPageMessageType]: (
    message: MessageOf<T>,
  ) => Promise<BackgroundReplies[T]>;
} = {
  TOOLBAR_STATE: (message) => toolbarState(message.tabId),
  SET_ENABLED: async (message) => {
    if (
      typeof message.enabled !== "boolean" ||
      !["global", "site"].includes(message.scope)
    ) {
      throw new Error("Invalid enablement preference.");
    }
    return setEnabled(message.tabId, message.scope, message.enabled);
  },
  ACTIVATE: (message) => activate(message.tabId),
};

const frameHandlers: {
  [T in FrameMessageType]: (
    message: MessageOf<T>,
    identity: FrameIdentity,
  ) => Promise<BackgroundReplies[T]>;
} = {
  HELLO: (_message, identity) =>
    serial(identity.tabId, async () => ({
      identity,
      state: await state(identity.tabId),
      enabled: (await toolbarState(identity.tabId)).enabled,
    })),
  SAVE_STATE: (message, { tabId, frameId }) =>
    serial(tabId, async () => {
      if (frameId !== 0) {
        throw new Error("Only the top frame controls tab state.");
      }
      const current = await state(tabId);
      if (message.state.revision < current.revision) return current;

      const value = readState(message.state);
      if (!value) throw new Error("Invalid search state.");

      await closeIfDisabled(tabId, value);
      await chrome.storage.session.set({ [sessionKey(tabId)]: value });
      await deliver(tabId, {
        target: "content",
        type: "STATE",
        state: value,
      }).catch(() => {});
      return value;
    }),
  OPEN: async (message, identity) => {
    if (!(await toolbarState(identity.tabId)).enabled) return { ok: false };
    return deliver(
      identity.tabId,
      {
        target: "content",
        type: "OPEN",
        seed: message.seed,
        source: identity,
      },
      0,
    );
  },
  CLOSE: (_message, { tabId }) =>
    deliver(tabId, { target: "content", type: "CLOSE" }, 0),
  MATCH: async (message, identity) => {
    await ensureOffscreen();
    return toOffscreen<MatchResult>({
      target: "offscreen",
      type: "MATCH",
      key: frameKey(identity),
      request: message.request,
    });
  },
  CANCEL: async (_message, identity) => {
    if (await hasOffscreen()) {
      await toOffscreen({
        target: "offscreen",
        type: "CANCEL",
        key: frameKey(identity),
      });
    }
    return { ok: true };
  },
  SUMMARY: (message, identity) =>
    deliver(
      identity.tabId,
      {
        target: "content",
        type: "SUMMARY",
        summary: { ...message.summary, identity },
      },
      0,
    ).catch(() => {}),
  ROUTE: async (message, { tabId, frameId }) => {
    if (frameId !== 0 || message.destination.tabId !== tabId) {
      throw new Error("Invalid frame route.");
    }
    return deliver(
      tabId,
      message.message,
      undefined,
      message.destination.documentId,
    ).catch(() => ({ missing: true }));
  },
};

const isExtensionPageMessage = (
  message: BackgroundMessage,
): message is MessageOf<ExtensionPageMessageType> =>
  message.type === "TOOLBAR_STATE" ||
  message.type === "SET_ENABLED" ||
  message.type === "ACTIVATE";

const handle = async (
  message: BackgroundMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> => {
  if (isExtensionPageMessage(message)) {
    if (!sender.url?.startsWith(chrome.runtime.getURL(""))) {
      throw new Error(
        message.type === "ACTIVATE"
          ? "Only extension pages can activate tabs."
          : "Only extension pages can change enablement.",
      );
    }
    // TypeScript cannot correlate a union message with its handler; the map's
    // own type already checks each handler against its message and reply.
    const handler = extensionPageHandlers[message.type] as (
      message: BackgroundMessage,
    ) => Promise<unknown>;
    return handler(message);
  }
  const identity = identityOf(sender);
  if (sender.documentLifecycle && sender.documentLifecycle !== "active") {
    return { ignored: true } satisfies IgnoredReply;
  }
  const handler = (
    Object.hasOwn(frameHandlers, message.type)
      ? frameHandlers[message.type]
      : undefined
  ) as
    | ((message: BackgroundMessage, identity: FrameIdentity) => Promise<unknown>)
    | undefined;
  return handler?.(message, identity);
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

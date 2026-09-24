import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { createState, type BackgroundMessage } from "../src/types";

let listener: (message: BackgroundMessage, sender: chrome.runtime.MessageSender, reply: (value: any) => void) => void;
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let deliver: ReturnType<typeof vi.fn>;
const tabs = [
  { id: 1, url: "https://example.com/article" },
  { id: 2, url: "https://other.example/article" },
  { id: 3, url: "chrome://settings" },
];
function storage(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
}
async function request(message: Omit<BackgroundMessage, "target">, tabId?: number, frameId = 0): Promise<any> {
  const sender: chrome.runtime.MessageSender = tabId === undefined
    ? { id: "test-extension", url: "chrome-extension://test-extension/action.html" }
    : { id: "test-extension", url: frameId ? "https://embedded.example/" : tabs[tabId - 1].url, tab: tabs[tabId - 1] as chrome.tabs.Tab, frameId, documentId: `document-${tabId}-${frameId}` };
  return new Promise(resolve => listener({ target: "background", ...message } as BackgroundMessage, sender, resolve));
}
beforeEach(async () => {
  vi.resetModules(); local = {}; session = {}; deliver = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("chrome", {
    storage: { local: storage(local), session: storage(session) },
    tabs: { get: vi.fn(async (id: number) => tabs.find(tab => tab.id === id)), query: vi.fn(async () => tabs), sendMessage: deliver, onRemoved: { addListener: vi.fn() } },
    runtime: { id: "test-extension", getURL: (path: string) => `chrome-extension://test-extension/${path}`, onMessage: { addListener: (value: typeof listener) => { listener = value; } } },
    commands: { onCommand: { addListener: vi.fn() } },
  });
  await import("../src/background");
});
afterEach(() => vi.unstubAllGlobals());

describe("toolbar enablement", () => {
  test("reading the menu leaves search closed and explains unsupported pages", async () => {
    expect(await request({ type: "TOOLBAR_STATE", tabId: 1 } as BackgroundMessage)).toMatchObject({ supported: true, enabled: true, hostname: "example.com" });
    expect(deliver).not.toHaveBeenCalled();
    expect(await request({ type: "TOOLBAR_STATE", tabId: 3 } as BackgroundMessage)).toMatchObject({ supported: false, enabled: false });
    expect(await request({ type: "SET_ENABLED", tabId: 3, scope: "site", enabled: false } as BackgroundMessage)).toHaveProperty("error");
  });
  test("site disablement applies to embedded frames while retaining the query", async () => {
    const saved = createState(); saved.open = true; saved.rows[0].query = "needle"; session["tab:1"] = saved;
    await request({ type: "SET_ENABLED", tabId: 1, scope: "site", enabled: false } as BackgroundMessage);
    const frame = await request({ type: "HELLO" }, 1, 7);
    expect(frame.enabled).toBe(false); expect(frame.state.open).toBe(false); expect(frame.state.rows[0].query).toBe("needle");
    expect((await request({ type: "HELLO" }, 2)).enabled).toBe(true);
    expect(deliver).toHaveBeenCalledWith(1, { target: "content", type: "ENABLEMENT", enabled: false }, undefined);
    expect(local.enablement).toEqual({ enabled: true, disabledSites: ["example.com"] });
  });
  test("global changes retain site exceptions across a worker restart", async () => {
    await request({ type: "SET_ENABLED", tabId: 1, scope: "site", enabled: false } as BackgroundMessage);
    await request({ type: "SET_ENABLED", tabId: 2, scope: "global", enabled: false } as BackgroundMessage);
    expect((await request({ type: "HELLO" }, 2)).enabled).toBe(false);
    vi.resetModules(); await import("../src/background");
    expect((await request({ type: "TOOLBAR_STATE", tabId: 2 } as BackgroundMessage)).preferences.enabled).toBe(false);
    await request({ type: "SET_ENABLED", tabId: 2, scope: "global", enabled: true } as BackgroundMessage);
    expect((await request({ type: "HELLO" }, 1)).enabled).toBe(false);
    expect((await request({ type: "HELLO" }, 2)).enabled).toBe(true);
    await request({ type: "SET_ENABLED", tabId: 1, scope: "site", enabled: true } as BackgroundMessage);
    expect((await request({ type: "HELLO" }, 1)).enabled).toBe(true);
  });
  test("disabled tabs reject activation and stale open state", async () => {
    await request({ type: "SET_ENABLED", tabId: 1, scope: "global", enabled: false } as BackgroundMessage);
    deliver.mockClear();
    expect((await request({ type: "ACTIVATE", tabId: 1 } as BackgroundMessage)).ok).toBe(false);
    expect((await request({ type: "OPEN" }, 1)).ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    const saved = createState(); saved.open = true; saved.revision = 10;
    const result = await request({ type: "SAVE_STATE", state: saved } as BackgroundMessage, 1);
    expect(result.open).toBe(false); expect(result.revision).toBeGreaterThan(10);
  });
});

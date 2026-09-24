import { send, type BackgroundMessage } from "./types";
import type { ToolbarState } from "./preferences";

const globalSwitch = document.getElementById("global") as HTMLInputElement;
const siteSwitch = document.getElementById("site") as HTMLInputElement;
const siteName = document.getElementById("site-name")!;

let tabId: number | undefined;

let menu: ToolbarState | undefined;

const request = async (message: BackgroundMessage): Promise<ToolbarState> => {
  const result = await send<ToolbarState & { error?: string }>(message);
  if (result.error) throw new Error(result.error);
  return result;
};

const render = (): void => {
  if (!menu) return;

  globalSwitch.checked = menu.preferences.enabled;
  globalSwitch.disabled = false;
  siteSwitch.checked =
    !!menu.hostname && !menu.preferences.disabledSites.includes(menu.hostname);
  siteSwitch.disabled = !menu.supported || !menu.preferences.enabled;
  siteName.textContent = menu.hostname ?? "Unavailable on this page";
};

const update = async (
  scope: "global" | "site",
  enabled: boolean,
): Promise<void> => {
  if (tabId === undefined) return;

  globalSwitch.disabled = siteSwitch.disabled = true;
  try {
    menu = await request({
      target: "background",
      type: "SET_ENABLED",
      tabId,
      scope,
      enabled,
    });
    render();
  } catch (error) {
    render();
    siteName.textContent =
      error instanceof Error
        ? error.message
        : "Could not save preferences. Try again.";
  }
};

globalSwitch.addEventListener(
  "change",
  () => void update("global", globalSwitch.checked),
);

siteSwitch.addEventListener(
  "change",
  () => void update("site", siteSwitch.checked),
);

(async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    tabId = tab?.id;
    if (tabId === undefined) {
      throw new Error("Open a webpage to control page search.");
    }

    menu = await request({
      target: "background",
      type: "TOOLBAR_STATE",
      tabId,
    });
    render();
  } catch (error) {
    siteName.textContent =
      error instanceof Error ? error.message : "Could not load preferences.";
  }
})();

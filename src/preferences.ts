export interface Preferences {
  enabled: boolean;
  disabledSites: string[];
}

export interface ToolbarState {
  preferences: Preferences;
  hostname?: string;
  supported: boolean;
  enabled: boolean;
}

export const hostnameOf = (url?: string): string | undefined => {
  try {
    const parsed = new URL(url ?? "");
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
};

export const supportedPage = (url?: string): boolean => {
  return (
    Boolean(hostnameOf(url)) &&
    !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:[/?#]|$)/.test(
      url!,
    )
  );
};

export const enabledOn = (preferences: Preferences, url?: string): boolean => {
  const hostname = hostnameOf(url);
  return (
    preferences.enabled &&
    !!hostname &&
    !preferences.disabledSites.includes(hostname)
  );
};

export const readPreferences = async (): Promise<Preferences> => {
  const { enablement } = (await chrome.storage.local.get("enablement")) as {
    enablement?: Partial<Preferences>;
  };
  return {
    enabled: enablement?.enabled !== false,
    disabledSites: Array.isArray(enablement?.disabledSites)
      ? enablement.disabledSites.filter(
          (site: unknown): site is string => typeof site === "string",
        )
      : [],
  };
};

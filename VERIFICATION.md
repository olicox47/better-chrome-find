# Version 1.3.1: Better Chrome Find name and logo

Verified on 17 September 2026:

- TypeScript and the production build passed.
- Four focused tests passed in installed Chrome using temporary profiles: search controls and close/reopen, unsupported-page menu, site switches across embedded frames, and global/site preferences across restart. This also completes the previously blocked toolbar browser checks below.
- All manifest icon paths exist in the build. The 16, 32, 48 and 128 pixel PNGs have the expected dimensions and preserve transparency.
- Old branding is absent from source, packaged files and tests.

# Version 1.3.0: toolbar controls

Verified on 15 September 2026:

- TypeScript and production build passed.
- Four focused enablement tests passed: opening the menu without activating search, unsupported pages, top-level site preferences applying to embedded frames, retained queries, global override, persistent site exceptions and rejection of stale open state while disabled.
- Three focused browser scenarios are available for the toolbar, native shortcut fallback, frame highlight cleanup, query preservation and restart persistence. Execution was blocked by macOS sandbox restrictions on Chrome startup. The approval policy rejected execution outside the sandbox; these browser scenarios are not yet verified.

Run `CHROME_CHANNEL=chrome npm run test:browser -- --grep toolbar` from the project directory to run those browser checks using a temporary Chrome profile.

The previous checks below apply to earlier builds.

# Verification

Better Chrome Find 1.2.4 verified on macOS on 10 September 2026.

| Check | Result |
| --- | --- |
| TypeScript and Vite production build | Passed; unpacked extension in `dist/` |
| Matcher tests | 20 passed in 1.2.0; matcher code is unchanged |
| Focused Chromium scenarios | 3 passed for 1.2.4; 9 passed for 1.2.3 |
| Installed Chrome | 1.2.3 passed in Chrome 153.0.8010.37 with a temporary profile |
| Visual inspection | 1.2.3 single-row bar in light/dark themes and at 150% browser zoom |

The 1.2.4 checks cover retaining the displayed count while a query is pending (both the initial `0 / 0` and `10,000 / 10,000+`), updating it when results arrive, stable counter layout, regex error/timeout recovery and closing/reopening. The build includes TypeScript checks. Installed Chrome and visual checks were not repeated for this count-only change.

The nine focused Chromium checks cover uninterrupted highlights during unrelated page updates and navigation at the 10,000-match cap, preservation of the current match, yellow/orange colours, dynamic result updates, cross-origin frame navigation, inline/open-shadow-root matching, strict-CSP styling, query edits, regex errors/timeouts, closing/reopening and stable counter layout. The new flashing reproduction detected 11 sampled frames with missing highlights before the fix; it now detects none across three page updates on a fixture with 2,500 background paragraphs. Navigation at the result cap also retains highlights in every sampled animation frame.

The test harness waits for a content-script response before pressing Ctrl/Cmd+F. A session-storage write alone does not establish that the page has finished initialising.

The installed-Chrome smoke test covers Cmd+F from a page input and iframe input, text entry, focus restoration, × closing, removing highlights from both page and iframe, reopening the query, both themes and real 150% browser zoom. Screenshots are under `test-results/native-chrome/`. The bar is 378 × 34 CSS pixels at normal zoom with no error displayed. Tests create and remove separate profiles and do not change your normal Chrome profile.

Windows/Linux shortcut paths are implemented but were not manually tested on those operating systems. Browser address-bar and menu shortcuts were not manually exercised. Chrome 127 is the declared minimum; Chrome 153 was tested.

## Reproduce

```sh
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm run test:chrome
```

The installed-Chrome command needs a desktop session and uses Chrome's extension-debugging protocol in its temporary profile. To use the Chromium downloaded for this project:

```sh
PLAYWRIGHT_BROWSERS_PATH=/Users/oliver.cox/Documents/Codex/2026-09-10/can/work/browsers npm run test:browser
```

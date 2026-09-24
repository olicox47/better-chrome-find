import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TabState } from "../src/types";

let server: Server;
let origin: string;
let context: BrowserContext;
let page: Page;
let worker: Worker;
let profile: string;
const find = process.platform === "darwin" ? "Meta+f" : "Control+f";
const panel = () => page.getByRole("dialog", { name: "Page search" });
const rows = () => panel().locator(".row");
const counts = () => panel().locator(".count");
const field = () =>
  page.getByRole("textbox", { name: "Find on page", exact: true });
async function open(): Promise<void> {
  // Session storage can be written before the content script finishes
  // initialising. Wait for the actual page connection before pressing a shortcut.
  await page.bringToFront();
  await expect
    .poll(async () =>
      worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        return chrome.tabs
          .sendMessage(
            tab.id!,
            { target: "content", type: "PING" },
            { frameId: 0 },
          )
          .then(
            (result) => result.ok,
            () => false,
          );
      }),
    )
    .toBe(true);
  await page.keyboard.press(find);
  await expect(panel()).toBeVisible();
}
async function fill(query: string, count: string): Promise<void> {
  await field().fill(query);
  await expect(counts().first()).toHaveText(count);
}
async function highlightTexts(target: Page = page): Promise<string[]> {
  return target.evaluate(() =>
    [...CSS.highlights.entries()]
      .filter(
        ([key]) => key.startsWith("better-chrome-find-") && !key.endsWith("-current"),
      )
      .flatMap(([, highlight]) =>
        [...highlight].map((range) => (range as Range).toString()),
      ),
  );
}
async function launch(): Promise<BrowserContext> {
  if (process.env.CHROME_CHANNEL === "chrome") {
    const browser = await chromium.launchPersistentContext(profile, {
      channel: "chrome", headless: false, viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging"],
    });
    const session = await browser.browser()!.newBrowserCDPSession();
    await session.send("Extensions.loadUnpacked", { path: resolve("dist") });
    await session.detach();
    return browser;
  }
  return chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: process.env.HEADED !== "1",
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${resolve("dist")}`,
      `--load-extension=${resolve("dist")}`,
    ],
  });
}
test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const port = (server.address() as { port: number }).port;
    const crossOrigin = `http://127.0.0.1:${port}`;
    const path = request.url?.split("?")[0];
    let body =
      '<p>Alpha alpha alphabet. Beta beta. Gamma delta.</p><input id="page-input" value="fieldneedle"><p id="dynamic"></p>';
    if (path === "/indexing")
      body =
        '<p id="split">hel<strong>lo</strong>   world</p><p>separate</p><p>blocks</p><p hidden>invisible</p><p style="display:none">invisible</p><textarea>fieldneedle</textarea><div id="shadow"></div><pre>red\nblue</pre><p>line<br>break</p>';
    if (path === "/frames")
      body = `<p>needle before</p><iframe id="child" src="${crossOrigin}/child"></iframe><p>needle after</p>`;
    if (path === "/child")
      body = `<input id="frame-input"><p>needle child</p><iframe src="/nested"></iframe>`;
    if (path === "/nested") body = "<p>needle nested</p>";
    if (path === "/scroll")
      body =
        '<div style="height:900px">Top</div><div id="scroller" style="height:160px;overflow:auto;border:1px solid"><div style="height:900px">Inside</div><span>deepneedle</span></div>';
    if (path === "/timeout") body = `<p>${"a".repeat(100)}!</p><p>safeword</p>`;
    if (path === "/limit") body = `<p>${"token ".repeat(10_020)}</p>`;
    if (path === "/shortcuts")
      body += `<script>
      window.pageKeys = [];
      for (const target of [window, document]) for (const capture of [true, false]) {
        for (const type of ['keydown', 'keypress', 'keyup']) target.addEventListener(type, event => {
          window.pageKeys.push(type + ':' + event.key);
          if (event.type === 'keydown' && /^[a-z]$/.test(event.key) && !(event.target instanceof HTMLInputElement)) event.preventDefault();
        }, capture);
      }
    </script>`;
    if (path === "/csp") {
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'none'",
      );
      body = "<p>strictneedle</p>";
    }
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>Better Chrome Find fixture</title></head><body>${body}</body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  origin = `http://localhost:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
test.beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "better-chrome-find-test-"));
  context = await launch();
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  page = await context.newPage();
  await page.goto(origin);
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    await page
      .screenshot({ path: info.outputPath("failure.png"), fullPage: true })
      .catch(() => {});
  }
  await context.close();
  await rm(profile, { recursive: true, force: true });
});

test("single search supports all options and the right-hand close button preserves the query", async () => {
  await open();
  await fill("alpha", "1 / 3");
  expect(await worker.evaluate(() => chrome.runtime.getManifest().name)).toBe(
    "Better Chrome Find",
  );
  await expect(panel()).not.toContainText(/Better Chrome Find/);
  await expect(rows()).toHaveCount(1);
  await expect(
    panel().getByRole("button", {
      name: /Add search|Change search colour|Remove search|Reorder|settings/i,
    }),
  ).toHaveCount(0);
  await rows()
    .first()
    .getByRole("button", { name: "Match case", exact: true })
    .click();
  await expect(counts().first()).toHaveText("1 / 2");
  await rows()
    .first()
    .getByRole("button", { name: "Match whole word", exact: true })
    .click();
  await expect(counts().first()).toHaveText("1 / 1");
  await rows()
    .first()
    .getByRole("button", { name: "Use regular expression" })
    .click();
  await fill("b.ta", "1 / 1");
  await expect(
    rows().first().locator('.toggle[aria-pressed="true"]'),
  ).toHaveCount(3);
  await field().press("Control+Enter");
  await field().press("Meta+Enter");
  await expect(rows()).toHaveCount(1);
  await expect(field()).toHaveValue("b.ta");
  const close = panel().locator(".controls > button").last();
  await expect(close).toHaveAttribute("aria-label", "Close search (Escape)");
  await close.click();
  await expect(panel()).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...CSS.highlights.keys()].filter((key) =>
            key.startsWith("better-chrome-find-"),
          ).length,
      ),
    )
    .toBe(0);
  await open();
  await expect(field()).toHaveValue("b.ta");
  await expect(
    rows().first().locator('.toggle[aria-pressed="true"]'),
  ).toHaveCount(3);
  for (const toggle of await rows().first().locator(".toggle").all())
    await toggle.click();
  await fill("alpha", "1 / 3");
  await field().press("Enter");
  await expect(counts().first()).toHaveText("2 / 3");
  await panel()
    .getByRole("button", { name: "Previous match (Shift+Enter)" })
    .click();
  await expect(counts().first()).toHaveText("1 / 3");
  await expect(field()).toBeFocused();
  await field().fill("Gamma");
  await close.click(); // Closing before debounce must save the latest text.
  await open();
  await expect(field()).toHaveValue("Gamma");
  await expect(counts().first()).toHaveText("1 / 1");
});

test("isolates panel typing from page capture and bubble shortcuts while preserving editing", async () => {
  await page.goto(`${origin}/shortcuts`);
  await page.locator("#page-input").focus();
  await open();
  const recorded = () =>
    page.evaluate(() => (window as unknown as { pageKeys: string[] }).pageKeys);
  const clear = () =>
    page.evaluate(() => {
      (window as unknown as { pageKeys: string[] }).pageKeys = [];
    });
  await clear();
  await field().pressSequentially("alphax");
  await field().press("Backspace");
  await expect(field()).toHaveValue("alpha");
  await expect(counts().first()).toHaveText("1 / 3");
  await field().press("ArrowLeft");
  await field().press("ArrowRight");
  await field().press("Enter");
  await expect(counts().first()).toHaveText("2 / 3");
  await field().press("Shift+Enter");
  await expect(counts().first()).toHaveText("1 / 3");
  await page.keyboard.press(find);
  await page.keyboard.type("beta");
  await expect(field()).toHaveValue("beta");
  await expect(counts().first()).toHaveText("1 / 2");
  await field().press("Tab");
  await expect(
    rows().first().getByRole("button", { name: "Match case", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    rows().first().getByRole("button", { name: "Match case", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await field().press(
    process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
  );
  await expect(rows()).toHaveCount(1);
  await expect(field()).toHaveValue("beta");
  expect(await recorded()).toEqual([]);
  await field().focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#page-input")).toBeFocused();
  expect(await recorded()).toEqual([]); // Escape keyup must not leak after focus is restored.
  await page.locator("#page-input").pressSequentially("z");
  expect(await recorded()).toContain("keydown:z");
  await open();
  await clear();
  await page.locator("#page-input").focus();
  await page.keyboard.press("q");
  expect(await recorded()).toContain("keydown:q"); // Page shortcuts still work outside the panel.
});

test("legacy sessions retain only the active query", async () => {
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const rows = ["alpha", "beta", "Gamma", "delta", "Alpha"].map(
      (query, index) => ({
        id: `saved-${index}`,
        query,
        matchCase: true,
        wholeWord: true,
        regex: false,
        colour: "#FF0000",
      }),
    );
    await chrome.storage.session.set({
      [`tab:${tab.id}`]: {
        rows,
        activeRowId: rows[1].id,
        open: true,
        revision: 10,
      },
    });
    await chrome.storage.local.set({
      settings: {
        palette: ["#FF0000"],
        takeover: false,
        disabledOrigins: [location.origin],
      },
    });
  });
  await page.reload();
  await expect(field()).toHaveValue("beta");
  await expect(counts().first()).toHaveText("1 / 1");
  await expect(rows()).toHaveCount(1);
  await expect(
    rows().first().locator('.toggle[aria-pressed="true"]'),
  ).toHaveCount(2);
  const saved = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return (await chrome.storage.session.get(`tab:${tab.id}`))[
      `tab:${tab.id}`
    ] as TabState;
  });
  expect(saved.rows).toEqual([
    {
      id: "saved-1",
      query: "beta",
      matchCase: true,
      wholeWord: true,
      regex: false,
    },
  ]);
  expect(saved.activeRowId).toBe("saved-1");
  await page.keyboard.press("Escape");
  await open();
  await expect(field()).toHaveValue("beta");
  expect(
    await worker.evaluate(() => chrome.runtime.getManifest().options_ui),
  ).toBeUndefined();
});

test("ordinary matches are yellow and the current match is orange", async () => {
  await open();
  await fill("alpha", "1 / 3");
  await expect
    .poll(() =>
      page
        .locator("body > p")
        .first()
        .evaluate((element) => {
          const name = [...CSS.highlights.keys()].find(
            (key) =>
              key.startsWith("better-chrome-find-") && !key.endsWith("-current"),
          );
          const normal = getComputedStyle(element, `::highlight(${name})`);
          const active = getComputedStyle(
            element,
            `::highlight(${name}-current)`,
          );
          return [
            normal.backgroundColor,
            active.backgroundColor,
            normal.color,
            active.color,
          ];
        }),
    )
    .toEqual([
      "rgb(255, 255, 0)",
      "rgb(255, 150, 50)",
      "rgb(0, 0, 0)",
      "rgb(0, 0, 0)",
    ]);
  const current = () =>
    page.evaluate(() =>
      [...CSS.highlights.entries()]
        .filter(([key]) => key.endsWith("-current"))
        .flatMap(([, highlight]) =>
          [...highlight].map((range) => (range as Range).toString()),
        ),
    );
  await expect.poll(current).toEqual(["Alpha"]);
  await field().press("Enter");
  await expect(counts().first()).toHaveText("2 / 3");
  await expect.poll(current).toEqual(["alpha"]);
  await expect
    .poll(() => highlightTexts())
    .toEqual(["Alpha", "alpha", "alpha"]);
});

test("indexes inline text, whitespace, open shadow roots and line breaks", async () => {
  await page.goto(`${origin}/indexing`);
  await page.evaluate(() => {
    document
      .getElementById("shadow")!
      .attachShadow({ mode: "open" }).innerHTML = "<span>shadowneedle</span>";
  });
  await open();
  await fill("hello world", "1 / 1");
  await expect.poll(() => highlightTexts()).toEqual(["hello   world"]);
  await fill("separateblocks", "0 / 0");
  await fill("invisible", "0 / 0");
  await fill("fieldneedle", "0 / 0");
  await fill("shadowneedle", "1 / 1");
  await expect.poll(() => highlightTexts()).toEqual(["shadowneedle"]);
  await rows()
    .first()
    .getByRole("button", { name: "Use regular expression" })
    .click();
  await fill("red\\nblue", "1 / 1");
  await fill("line\\nbreak", "1 / 1");
});

test("updates changed pages and releases matches on close", async () => {
  await open();
  await fill("newneedle", "0 / 0");
  await page.evaluate(() => {
    document.getElementById("dynamic")!.textContent = "newneedle newneedle";
  });
  await expect(counts().first()).toHaveText("1 / 2");
  await page.evaluate(() => {
    document.getElementById("dynamic")!.textContent = "newneedle";
  });
  await expect(counts().first()).toHaveText("1 / 1");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.getElementById("dynamic")!.textContent =
      "newneedle newneedle newneedle";
  });
  await open();
  await expect(counts().first()).toHaveText("1 / 3");
});

test("keeps highlights and the current match stable during unrelated page updates", async () => {
  await page.evaluate(() => {
    const background = document.createElement("section");
    for (let index = 0; index < 2500; index++) {
      const paragraph = document.createElement("p");
      paragraph.textContent = `Background text ${index}`;
      background.append(paragraph);
    }
    document.body.append(background);
  });
  await open();
  await fill("alpha", "1 / 3");
  await field().press("Enter");
  await expect(counts().first()).toHaveText("2 / 3");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...CSS.highlights.entries()]
            .find(([key]) => key.endsWith("-current"))?.[1]
            .values()
            .next().value?.startOffset,
      ),
    )
    .toBe(6);
  const observed = await page.evaluate(async () => {
    let samples = 0,
      missing = 0,
      changedCurrent = 0,
      wrongColour = 0;
    let animation = 0;
    const sample = () => {
      samples++;
      const entries = [...CSS.highlights.entries()].filter(([key]) =>
        key.startsWith("better-chrome-find-"),
      );
      const current = entries.find(([key]) => key.endsWith("-current"));
      const normal = entries.find(([key]) => !key.endsWith("-current"));
      if (!current || !normal || normal[1].size !== 3) missing++;
      if (current && current[1].values().next().value?.startOffset !== 6)
        changedCurrent++;
      if (
        current &&
        getComputedStyle(
          document.querySelector("p")!,
          `::highlight(${current[0]})`,
        ).backgroundColor !== "rgb(255, 150, 50)"
      )
        wrongColour++;
      animation = requestAnimationFrame(sample);
    };
    animation = requestAnimationFrame(sample);
    for (let change = 0; change < 3; change++) {
      document.getElementById("dynamic")!.textContent = `Page update ${change}`;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    cancelAnimationFrame(animation);
    return { samples, missing, changedCurrent, wrongColour };
  });
  expect(observed.samples).toBeGreaterThan(10);
  expect(observed.missing).toBe(0);
  expect(observed.changedCurrent).toBe(0);
  expect(observed.wrongColour).toBe(0);
  await expect(counts().first()).toHaveText("2 / 3");
});

test("combines nested cross-origin frames in document order and restores iframe focus", async () => {
  await page.goto(`${origin}/frames`);
  const child = page.frameLocator("#child");
  await child.locator("#frame-input").focus();
  await page.keyboard.press(find);
  await expect(panel()).toBeVisible();
  await fill("needle", "1 / 4");
  await field().press("Enter");
  await expect(counts().first()).toHaveText("2 / 4");
  await expect
    .poll(() =>
      child
        .locator("body")
        .evaluate(() =>
          [...CSS.highlights.entries()]
            .filter(([key]) => key.endsWith("-current"))
            .flatMap(([, h]) =>
              [...h].map((range) => (range as Range).toString()),
            ),
        ),
    )
    .toEqual(["needle"]);
  await field().press("Enter");
  await expect(counts().first()).toHaveText("3 / 4");
  await expect
    .poll(() =>
      child
        .frameLocator("iframe")
        .locator("body")
        .evaluate(() =>
          [...CSS.highlights.keys()].some((key) => key.endsWith("-current")),
        ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel()).not.toBeVisible();
  await expect(child.locator("#frame-input")).toBeFocused();
  await page.locator("#child").evaluate((element) => element.remove());
  await open();
  await expect(counts().first()).toHaveText("2 / 2");
});

test("scrolls nested containers to the exact matched range", async () => {
  await page.goto(`${origin}/scroll`);
  await open();
  await fill("deepneedle", "1 / 1");
  await expect
    .poll(() =>
      page.locator("#scroller").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(500);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(100);
  await expect(field()).toBeFocused();
});

test("persists within one tab, isolates other tabs and resets on browser restart", async () => {
  await open();
  await fill("beta", "1 / 2");
  await page.reload();
  await expect(field()).toHaveValue("beta");
  await expect(counts().first()).toHaveText("1 / 2");
  await page.goto(`${origin}/another`);
  await expect(field()).toHaveValue("beta");
  const original = page;
  page = await context.newPage();
  await page.goto(origin);
  await open();
  await expect(field()).toHaveValue("");
  page = original;
  await page.keyboard.press("Escape");
  await context.close();
  context = await launch();
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  page = await context.newPage();
  await page.goto(origin);
  await open();
  await expect(field()).toHaveValue("");
});

test("invalid and catastrophic regex allow recovery and discard stale query edits", async () => {
  await page.goto(`${origin}/timeout`);
  await open();
  await rows()
    .first()
    .getByRole("button", { name: "Use regular expression" })
    .click();
  await field().fill("[");
  await expect(rows().first().locator(".error")).toContainText(
    "Invalid regular expression",
  );
  await field().fill("(a+)+$");
  await expect(rows().first().locator(".error")).toContainText("500 ms");
  await fill("safeword", "1 / 1");
  await field().fill("(a+)+$x");
  await field().fill("safeword");
  await expect(counts().first()).toHaveText("1 / 1");
  await expect(rows().first().locator(".error")).toBeEmpty();
});

test("caps retained results at 10,000 with an explicit indicator", async () => {
  await page.goto(`${origin}/limit`);
  await open();
  const geometry = () =>
    panel().evaluate((element) =>
      [element, ...element.querySelectorAll(".controls > *, .toggles > *")].map(
        (control) => {
          const rect = control.getBoundingClientRect();
          return { x: rect.x, width: rect.width };
        },
      ),
    );
  const initial = await geometry();
  const editAndReadPendingCount = (query: string) =>
    field().evaluate((input: HTMLInputElement, query) => {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return (input.getRootNode() as ShadowRoot).querySelector(".count")!
        .textContent;
    }, query);
  expect(await editAndReadPendingCount("token")).toBe("0 / 0");
  expect(await geometry()).toEqual(initial);
  await expect(counts().first()).toHaveText("1 / 10,000+");
  expect(await geometry()).toEqual(initial);
  await expect.poll(async () => (await highlightTexts()).length).toBe(10_000);
  await page.evaluate(() => {
    const monitor = { missing: 0, samples: 0, animation: 0 };
    (
      window as unknown as { highlightMonitor: typeof monitor }
    ).highlightMonitor = monitor;
    const sample = () => {
      monitor.samples++;
      const entries = [...CSS.highlights.entries()].filter(([key]) =>
        key.startsWith("better-chrome-find-"),
      );
      if (
        entries.find(([key]) => !key.endsWith("-current"))?.[1].size !==
          10_000 ||
        !entries.some(([key]) => key.endsWith("-current"))
      )
        monitor.missing++;
      monitor.animation = requestAnimationFrame(sample);
    };
    monitor.animation = requestAnimationFrame(sample);
  });
  for (const [shortcut, offset] of [
    ["Shift+Enter", 59_994],
    ["Enter", 0],
    ["Shift+Enter", 59_994],
  ] as const) {
    await field().press(shortcut);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...CSS.highlights.entries()]
              .find(([key]) => key.endsWith("-current"))?.[1]
              .values()
              .next().value?.startOffset,
        ),
      )
      .toBe(offset);
  }
  const monitor = await page.evaluate(() => {
    const monitor = (
      window as unknown as {
        highlightMonitor: {
          missing: number;
          samples: number;
          animation: number;
        };
      }
    ).highlightMonitor;
    cancelAnimationFrame(monitor.animation);
    return monitor;
  });
  expect(monitor.samples).toBeGreaterThan(0);
  expect(monitor.missing).toBe(0);
  await expect(counts().first()).toHaveText("10,000 / 10,000+");
  expect(
    await counts()
      .first()
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(await geometry()).toEqual(initial);
  expect(await editAndReadPendingCount("missing")).toBe("10,000 / 10,000+");
  await expect(counts().first()).toHaveText("0 / 0");
  expect(await geometry()).toEqual(initial);
});

test("works on pages that prohibit page workers and inline scripts", async () => {
  await page.goto(`${origin}/csp`);
  await open();
  await fill("strictneedle", "1 / 1");
  await expect.poll(() => highlightTexts()).toEqual(["strictneedle"]);
  await expect(panel()).toHaveCSS("border-radius", "6px");
  await expect
    .poll(() =>
      page
        .locator("body > p")
        .first()
        .evaluate((element) => {
          const name = [...CSS.highlights.keys()].find(
            (key) =>
              key.startsWith("better-chrome-find-") && !key.endsWith("-current"),
          );
          return getComputedStyle(element, `::highlight(${name})`)
            .backgroundColor;
        }),
    )
    .toBe("rgb(255, 255, 0)");
});

test("current highlight takes priority and the compact bar survives light/dark themes", async ({}, info) => {
  await open();
  await fill("alpha", "1 / 3");
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...CSS.highlights.values()]
          .map((h) => h.priority)
          .sort((a, b) => a - b),
      ),
    )
    .toEqual([20, 100]);
  context.setDefaultTimeout(8000);
  await page.emulateMedia({ colorScheme: "light" });
  await panel().screenshot({ path: info.outputPath("panel-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await panel().screenshot({ path: info.outputPath("panel-dark.png") });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1.5";
  });
  await expect(panel()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close search (Escape)" }),
  ).toBeInViewport();
});

test("seeds selections, clears empty queries and preserves page-owned highlights", async () => {
  await page.evaluate(() => {
    const node = document.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    CSS.highlights.set("page-owned", new Highlight(range));
  });
  await open();
  await expect(field()).toHaveValue("Alpha");
  await expect(counts().first()).toHaveText("1 / 3");
  await fill("", "0 / 0");
  await expect(rows()).toHaveCount(1);
  await expect(field()).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => [...CSS.highlights.keys()]))
    .toEqual(["page-owned"]);
});

test("discovers shadow roots attached after opening", async () => {
  await page.goto(`${origin}/indexing`);
  await open();
  await fill("late-shadow", "0 / 0");
  await page.evaluate(() => {
    document
      .getElementById("shadow")!
      .attachShadow({ mode: "open" }).innerHTML = "<span>late-shadow</span>";
  });
  await expect(counts().first()).toHaveText("1 / 1");
});

test("toolbar disables site controls on unsupported pages", async () => {
  await page.goto("chrome://version");
  const id = worker.url().split("/")[2];
  const action = await context.newPage();
  await action.goto(`chrome-extension://${id}/action.html`);
  await expect(action.locator("#site-name")).toHaveText("Unavailable on this page");
  await expect(action.getByRole("switch", { name: "Enable extension", exact: true })).toBeEnabled();
  await expect(action.getByRole("switch", { name: "Enable on this site" })).toBeDisabled();
  await expect(action.getByRole("button")).toHaveCount(0);
  await expect(action.locator("#status")).toHaveCount(0);
});

async function toolbarFor(target: Page = page): Promise<Page> {
  const action = await context.newPage();
  await target.bringToFront();
  await action.goto(`chrome-extension://${worker.url().split("/")[2]}/action.html`);
  await expect(action.getByRole("switch", { name: "Enable extension", exact: true })).toBeEnabled();
  return action;
}
async function interceptsFind(target: Page = page): Promise<boolean[]> {
  return Promise.all(target.frames().map(frame => frame.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })));
}

test("toolbar menu disables a site immediately across frames and preserves the query", async () => {
  await page.goto(`${origin}/frames`);
  const action = await toolbarFor();
  await expect(panel()).not.toBeVisible();
  await expect(action.getByRole("switch", { name: "Enable on this site" })).toBeChecked();
  await action.close();
  await open(); await fill("needle", "1 / 4");
  const menu = await toolbarFor();
  await menu.getByRole("switch", { name: "Enable on this site" }).uncheck();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).toBeEnabled();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).not.toBeChecked();
  await expect(panel()).not.toBeVisible();
  await expect.poll(async () => Promise.all(page.frames().map(frame => frame.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith("better-chrome-find-")).length)))).toEqual([0, 0, 0]);
  expect(await interceptsFind()).toEqual([false, false, false]);
  await page.reload();
  await expect.poll(() => interceptsFind()).toEqual([false, false, false]);
  await menu.getByRole("switch", { name: "Enable on this site" }).check();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).toBeEnabled();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).toBeChecked();
  await expect(panel()).not.toBeVisible();
  await menu.close();
  await open();
  await expect(panel()).toBeVisible();
  await expect(field()).toHaveValue("needle");
  await expect(counts().first()).toHaveText("1 / 4");
});

test("toolbar preferences apply globally, preserve site exceptions and survive restart", async () => {
  await open(); await fill("alpha", "1 / 3");
  const menu = await toolbarFor();
  await menu.getByRole("switch", { name: "Enable on this site" }).uncheck();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).toBeEnabled();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).not.toBeChecked();
  const other = await context.newPage();
  await other.goto(origin.replace("localhost", "127.0.0.1"));
  const otherMenu = await toolbarFor(other);
  await expect(otherMenu.getByRole("switch", { name: "Enable on this site" })).toBeChecked();
  await otherMenu.close();
  await other.bringToFront();
  await expect.poll(() => interceptsFind(other)).toEqual([true]);
  await expect(other.getByRole("dialog", { name: "Page search" })).toBeVisible();
  await menu.getByRole("switch", { name: "Enable extension", exact: true }).uncheck();
  await expect(menu.getByRole("switch", { name: "Enable extension", exact: true })).toBeEnabled();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).toBeDisabled();
  await expect(other.getByRole("dialog", { name: "Page search" })).not.toBeVisible();
  expect(await interceptsFind(other)).toEqual([false]);
  await menu.getByRole("switch", { name: "Enable extension", exact: true }).check();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).toBeEnabled();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).not.toBeChecked();
  expect(await interceptsFind()).toEqual([false]);
  expect(await interceptsFind(other)).toEqual([true]);
  await menu.getByRole("switch", { name: "Enable extension", exact: true }).uncheck();
  await expect(menu.getByRole("switch", { name: "Enable extension", exact: true })).toBeEnabled();
  await expect(menu.getByRole("switch", { name: "Enable on this site" })).toBeDisabled();
  await context.close(); context = await launch();
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  page = await context.newPage(); await page.goto(origin);
  const restored = await toolbarFor();
  await expect(restored.getByRole("switch", { name: "Enable extension", exact: true })).not.toBeChecked();
  await expect(restored.getByRole("switch", { name: "Enable on this site" })).not.toBeChecked();
  expect(await interceptsFind()).toEqual([false]);
});

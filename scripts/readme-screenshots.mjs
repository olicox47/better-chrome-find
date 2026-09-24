// Renders the README screenshots into docs/ using installed Chrome and the built extension.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Billing notes</title><style>
:root{color-scheme:light dark;--bg:#eef1f6;--card:#fff;--ink:#26334b;--muted:#6b778c;--line:#dce2ec}
@media (prefers-color-scheme:dark){:root{--bg:#1b1c1f;--card:#26272b;--ink:#e8eaed;--muted:#9aa0a6;--line:#3c4043}}
html{overflow:hidden}body{margin:0;padding:72px 28px 28px;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 22px}
h1{font-size:17px;margin:0 0 6px}small{color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase}p{margin:6px 0}
</style></head><body><section><small>Billing notes</small><h1>March reconciliation</h1>
<p>Invoice-1042 was paid twice, so invoice-1043 was issued as a credit note.</p>
<p>The client disputed invoice-2057; see the thread on invoice-2058 for context.</p>
<p>Draft invoices (invoice-draft) are excluded from this report.</p>
</section></body></html>`;

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(pageHtml);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const profile = await mkdtemp(join(tmpdir(), 'better-chrome-find-shots-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, viewport: { width: 720, height: 300 }, deviceScaleFactor: 2,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: resolve('dist') });
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${id}/action.html`);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.bringToFront();
  await expect.poll(() => extensionPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'PING' }, { frameId: 0 }).then((result) => result.ok, () => false);
  })).toBe(true);

  const panel = page.getByRole('dialog', { name: 'Page search' });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Use regular expression' }).click();
  await page.getByRole('textbox', { name: 'Find on page', exact: true }).fill('invoice-\\d+');
  await expect(panel.locator('.count')).toHaveText('1 / 4');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.count')).toHaveText('2 / 4');
  await page.mouse.move(0, 0);

  await mkdir('docs', { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `docs/screenshot-${colorScheme}.png` });
  }
} finally {
  await context?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}

import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  if (request.url === '/frame') return response.end('<!doctype html><html><body><input placeholder="Frame input"><p>alpha in an embedded frame</p></body></html>');
  response.end(`<!doctype html><html><head><title>Better Chrome Find verification</title><style>body{font:16px/1.8 system-ui;background:#f5f7fb;color:#26334b;max-width:760px;margin:100px auto;padding:0 30px}small{color:#697a91}h1{font-size:34px;letter-spacing:-1px}section{border:1px solid #dce2ec;background:white;padding:26px;border-radius:12px;margin:20px 0}input{font:inherit;padding:7px;border:1px solid #bcc8d8;border-radius:6px}iframe{display:block;border:1px solid #dce2ec;width:100%;height:110px}</style></head><body><small>LOCAL VERIFICATION PAGE</small><h1>Find the details that matter.</h1><section><p>Alpha, alpha and alphabet test case and whole-word matching.</p><p>Match invoice-1042 and invoice-2057 with a regular expression.</p><p>Yellow marks every match. Orange marks the current match.</p><input placeholder="Page input"></section><iframe src="/frame"></iframe></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'better-chrome-find-chrome-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, viewport: { width: 1280, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: resolve('dist') });
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${id}/action.html`);
  await expect(extensionPage.getByRole('heading', { name: 'Better Chrome Find' })).toBeVisible();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.bringToFront();
  await expect.poll(() => extensionPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'PING' }, { frameId: 0 }).then(result => result.ok, () => false);
  })).toBe(true);
  const find = process.platform === 'darwin' ? 'Meta+f' : 'Control+f';
  const panel = page.getByRole('dialog', { name: 'Page search' });
  const search = () => page.getByRole('textbox', { name: 'Find on page', exact: true });
  await page.getByPlaceholder('Page input').focus();
  await page.keyboard.press(find);
  await expect(panel).toBeVisible();
  await search().pressSequentially('alpha');
  await expect(panel.locator('.count').first()).toHaveText('1 / 4');
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  await expect(page.getByPlaceholder('Page input')).toBeFocused();
  await page.frameLocator('iframe').getByPlaceholder('Frame input').focus();
  await page.keyboard.press(find); await expect(panel).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.frameLocator('iframe').getByPlaceholder('Frame input')).toBeFocused();
  await page.keyboard.press(find);
  await expect(search()).toHaveValue('alpha');
  await page.getByRole('button', { name: 'Close search (Escape)' }).click();
  await expect(panel).not.toBeVisible();
  await expect.poll(async () => {
    const totals = await Promise.all(page.frames().map(frame => frame.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith('better-chrome-find-')).length)));
    return totals.reduce((total, count) => total + count, 0);
  }).toBe(0);
  await page.keyboard.press(find); await expect(search()).toHaveValue('alpha');
  await expect.poll(() => page.evaluate(() => [...CSS.highlights.entries()].filter(([key]) => key.startsWith('better-chrome-find-') && !key.endsWith('-current')).reduce((total, [, highlight]) => total + highlight.size, 0))).toBe(3);
  await expect.poll(() => page.frameLocator('iframe').locator('body').evaluate(() => [...CSS.highlights.values()].reduce((total, highlight) => total + highlight.size, 0))).toBe(1);
  await mkdir('test-results/native-chrome', { recursive: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: 'test-results/native-chrome/light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: 'test-results/native-chrome/dark-panel.png' });
  await extensionPage.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.tabs.setZoom(tab.id, 1.5); });
  await expect(page.getByRole('button', { name: 'Close search (Escape)' })).toBeInViewport();
  await page.screenshot({ path: 'test-results/native-chrome/zoom-150.png' });
  await extensionPage.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.tabs.setZoom(tab.id, 1); });
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  console.log(`Installed Chrome ${context.browser().version()}: page and iframe shortcuts, typing, focus restoration, single search, close/reopen, themes and 150% browser zoom passed.`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const webRoot = path.join(root, 'local_disk_analyzer/web');
const output = path.join(root, 'test-results');
await fs.mkdir(output, { recursive: true });

const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/assets\//, '');
  if (name.includes('..')) { response.writeHead(400); response.end(); return; }
  try {
    const bytes = await fs.readFile(path.join(webRoot, name));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
    response.setHeader('Content-Type', types[path.extname(name)] || 'text/plain');
    // Match the packaged server's content security policy, including local fonts.
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(8765, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const browserErrors = [];
const expectedResourceErrors = [];
const calls = [];
const externalRequests = [];
page.on('pageerror', error => browserErrors.push(String(error)));
page.on('console', message => {
  if (message.type() !== 'error') return;
  const url = message.location().url;
  if (/Failed to load resource:.*(400|401|503)/.test(message.text()) && /\/api\//.test(url)) expectedResourceErrors.push(message.text());
  else browserErrors.push(message.text());
});
page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:8765/')) externalRequests.push(request.url()); });
const GiB = 1024 ** 3;
const drive = 'C:\\';
let state = { state: 'idle', scan: 0, root: '', files: 0, folders: 0, bytes: 0, elapsed: 0, volume: null, error_count: 0, skipped: 0, errors: [] };
let pollCount = 0;
let failScan = false;
let failFolder = false;
let unauthorized = false;
let delayedSearch;
const baseNames = [
  ['project-backup-2026.zip', 28.4, 'Documents'],
  ['game-installation.iso', 23.7, 'Downloads'],
  ['japan-trip-final.mov', 18.2, 'Videos'],
  ['development-machine.vhdx', 15.6, 'Virtual Machines'],
  ['weekend-footage.mp4', 12.3, 'Videos'],
];
const files = Array.from({ length: 135 }, (_, index) => {
  const [name, size, directory] = baseNames[index] ?? ['archive-' + String(index).padStart(3, '0') + '.zip', 10 / (index + 1), 'Documents'];
  return { id: 1000 + index, name, size: Math.round(size * GiB), folder: false, path: drive + 'Users\\Alex\\' + directory + '\\' + name };
});
const primaryFolders = [
  { id: 2, name: 'Users', size: 276.4 * GiB, folder: true, path: drive + 'Users' },
  { id: 3, name: 'Games', size: 142.7 * GiB, folder: true, path: drive + 'Games' },
  { id: 4, name: 'Program Files', size: 98.3 * GiB, folder: true, path: drive + 'Program Files' },
  { id: 5, name: 'Windows', size: 37.2 * GiB, folder: true, path: drive + 'Windows', partial: true },
  { id: 6, name: 'ProgramData', size: 18.6 * GiB, folder: true, path: drive + 'ProgramData' },
  { id: 7, name: 'pagefile.sys', size: 8 * GiB, folder: false, path: drive + 'pagefile.sys' },
];
let folderRows = primaryFolders.slice();
const completed = () => ({
  ...state, state: 'completed', scan: state.scan || 1, root: drive,
  files: 183204, folders: 14872, bytes: 582.3 * GiB, elapsed: 48,
  volume: { total: 953.9 * GiB, used: 681.7 * GiB, free: 272.2 * GiB },
  error_count: 0, errors: [], skipped: 13,
});
await context.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const endpoint = url.pathname.replace('/api', '');
  calls.push({ endpoint, query: url.search, method: request.method(), body: request.postDataJSON(), authorization: request.headers().authorization });
  if (unauthorized) { await route.fulfill({ status: 401, json: { detail: 'Unauthorized' } }); return; }
  let data;
  if (endpoint === '/status') {
    if (state.state === 'scanning' && ++pollCount >= 2) state = completed();
    data = state;
  } else if (endpoint === '/scan') {
    assert.equal(request.method(), 'POST');
    assert.deepEqual(request.postDataJSON(), { path: drive });
    if (failScan) { await route.fulfill({ status: 400, json: { detail: 'Access denied' } }); return; }
    pollCount = 0;
    state = { ...completed(), scan: state.scan + 1, state: 'scanning', files: 42631, folders: 3104, bytes: 98.4 * GiB, elapsed: 8 };
    data = state;
  } else if (endpoint === '/cancel') {
    state = { ...state, state: 'cancelled' };
    data = state;
  } else if (endpoint.endsWith('/largest')) {
    const index = Number(url.searchParams.get('page'));
    data = { total: files.length, file_count: 183204, rows: files.slice(index * 100, (index + 1) * 100) };
  } else if (/\/folders\/1$/.test(endpoint)) {
    const index = Number(url.searchParams.get('page'));
    data = { directory: { id: 1, name: drive, size: 582.3 * GiB }, total: folderRows.length, rows: folderRows.slice(index * 100, (index + 1) * 100), chart: primaryFolders, other: 1.1 * GiB, trail: [{ id: 1, name: drive }] };
  } else if (/\/folders\/2$/.test(endpoint)) {
    if (failFolder) { await route.fulfill({ status: 503, json: { detail: 'Temporary failure' } }); return; }
    data = { directory: { id: 2, name: 'Users', size: 276.4 * GiB }, total: 2, rows: files.slice(0, 2), chart: files.slice(0, 2), trail: [{ id: 1, name: drive }, { id: 2, name: 'Users' }] };
  } else if (endpoint.endsWith('/search')) {
    const query = url.searchParams.get('q');
    if (query === 'delayed') {
      await new Promise(resolve => { delayedSearch = resolve; });
      data = { total: 1, rows: [{ ...files[0], name: 'STALE-RESULT.zip' }] };
    } else if (query === 'many') {
      data = { total: 300, rows: Array.from({ length: 250 }, (_, index) => ({ ...files[0], id: 5000 + index, name: 'many-result-' + index + '.zip' })) };
    } else {
      const extension = url.searchParams.get('ext') || '';
      const rows = files.filter(item => (!query || item.name.includes(query)) && (!extension || item.name.endsWith(extension)));
      data = { total: rows.length, rows: rows.slice(0, 250) };
    }
  } else if (/\/items\/\d+\/open$/.test(endpoint) || endpoint === '/quit') {
    data = { ok: true };
  } else throw new Error('Unexpected API endpoint: ' + endpoint);
  await route.fulfill({ json: data });
});
const waitText = async (selector, text) => page.waitForFunction(([selector, text]) => document.querySelector(selector)?.textContent.includes(text), [selector, text]);
const waitCount = async (selector, count) => page.waitForFunction(([selector, count]) => document.querySelectorAll(selector).length === count, [selector, count]);
const ready = async () => {
  await waitText('#state', 'Scan complete');
  await waitCount('#file-rows tr', 5);
  await page.waitForSelector('#folder-rows tr');
};

try {
  await page.goto('http://127.0.0.1:8765/#test-session-token');
  await page.waitForFunction(() => !document.getElementById('scan').disabled);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.locator('.sidebar,.breadcrumb,#help,[role="tab"],#location,#browse,#drives').count(), 0);
  assert.equal(await page.locator('#scan-label').textContent(), 'Scan C:\\');
  assert.equal(await page.locator('#used-percent').textContent(), '—');
  assert.equal(calls.filter(call => call.endpoint === '/scan').length, 0);
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('disk-session')), 'test-session-token');
  assert.ok(await page.evaluate(() => document.fonts.check('650 16px Manrope')));
  assert.ok(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize) >= 17));
  assert.ok(!/How it works|Rescan|Your space|Make room|Workspace/i.test(await page.locator('body').innerText()));
  await page.screenshot({ path: path.join(output, 'idle.png'), fullPage: true });

  await page.locator('#scan').click();
  await waitText('#state', 'Scanning');
  assert.equal(await page.locator('#scan').isDisabled(), true);
  assert.equal(await page.locator('#cancel').isVisible(), true);
  assert.equal(await page.locator('#files-content').isVisible(), false);
  await ready();
  assert.equal(await page.locator('#scan-label').textContent(), 'Start a new scan');
  assert.equal(await page.locator('#used-percent').textContent(), '71%');
  assert.equal(await page.locator('#used').textContent(), '681.7 GiB');
  assert.equal(await page.locator('#scanned-size').textContent(), '582.3 GiB');
  assert.equal(await page.locator('#files-content').isVisible(), true);
  assert.equal(await page.locator('#folder-content').isVisible(), true);
  const order = await page.evaluate(() => {
    const ids = ['drive', 'largest-section', 'explorer-section'];
    return ids.map(id => document.getElementById(id).getBoundingClientRect().top);
  });
  assert.ok(order[0] < order[1] && order[1] < order[2]);
  const metrics = await page.locator('.scan-metrics dt').allTextContents();
  assert.ok(metrics[0].includes('Files scanned') && metrics[1].includes('Folders scanned') && metrics[2].includes('Scanned size'));
  await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true });
  await page.locator('#theme').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: path.join(output, 'dark-mode.png'), fullPage: true });
  await page.reload(); await ready();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('#theme').click();

  // Both result sections stay visible while each is used independently.
  await page.locator('#show-more').click();
  await waitCount('#file-rows tr', 15);
  assert.equal(await page.locator('#folder-rows tr').count(), 6);
  await page.locator('#folder-rows button.item-name').filter({ hasText: 'Users' }).click();
  await waitText('#directory-title', 'Users');
  assert.equal(await page.locator('#file-rows tr').count(), 15);
  assert.equal(await page.locator('#trail button').count(), 2);
  await page.screenshot({ path: path.join(output, 'folders.png'), fullPage: true });
  await page.locator('#trail button').first().click();
  await waitText('#directory-title', drive);
  await page.locator('#treemap').click({ position: { x: 20, y: 20 } });
  await waitText('#directory-title', 'Users');
  await page.locator('#trail button').first().click(); await waitText('#directory-title', drive);
  assert.equal(await page.locator('#file-rows tr').count(), 15);

  // Largest-file expansion crosses the API's 100-row page boundary.
  while (await page.locator('#show-more').isVisible()) {
    const before = await page.locator('#file-rows tr').count();
    await page.locator('#show-more').click();
    await page.waitForFunction(before => document.querySelectorAll('#file-rows tr').length > before, before);
  }
  assert.equal(await page.locator('#file-rows tr').count(), 135);
  assert.ok(calls.some(call => call.endpoint.endsWith('/largest') && call.query === '?page=1'));

  await page.locator('#query').fill('missing-file');
  await page.locator('#search').click();
  await waitText('#file-caption', '0 matches');
  assert.equal(await page.locator('#files-no-rows').isVisible(), true);
  assert.equal(await page.locator('#folder-content').isVisible(), true);
  await page.locator('#query').fill('project-backup');
  await page.locator('#extension').fill('.zip');
  await page.locator('#search').click();
  await waitCount('#file-rows tr', 1);
  assert.ok(calls.some(call => call.endpoint.endsWith('/search') && call.query.includes('q=project-backup') && call.query.includes('ext=.zip')));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#file-rows .copy').first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), files[0].path);
  await page.locator('#file-rows .open').first().click();
  assert.ok(calls.some(call => call.endpoint.endsWith('/items/1000/open')));
  await page.locator('#clear').click(); await waitCount('#file-rows tr', 5);
  await page.keyboard.press('/');
  assert.equal(await page.locator('#query').evaluate(input => input === document.activeElement), true);

  // Search has an explicit server-side cap and must not offer endless loading.
  await page.locator('#query').fill('many'); await page.locator('#search').click();
  await waitText('#file-caption', '300 matches');
  while (await page.locator('#show-more').isVisible()) await page.locator('#show-more').click();
  assert.equal(await page.locator('#file-rows tr').count(), 250);
  assert.equal(await page.locator('#file-limit').isVisible(), true);
  await page.locator('#clear').click(); await waitCount('#file-rows tr', 5);

  // Filenames are text, including strings that resemble executable HTML.
  files[0].name = '<img src=x onerror="window.injected=true">.zip';
  await page.reload(); await ready();
  assert.equal(await page.locator('#file-rows img').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  files[0].name = 'project-backup-2026.zip';

  // Explorer pagination uses 10 visible rows without losing items at API boundaries.
  folderRows = [...primaryFolders, ...Array.from({ length: 117 }, (_, index) => ({ id: 20 + index, name: 'Project ' + String(index).padStart(3, '0'), size: (117 - index) * 1024 ** 2, folder: true, path: drive + 'Projects\\' + index }))];
  await page.reload(); await ready();
  await waitCount('#folder-rows tr', 10);
  await waitText('#folder-page-label', '1–10 of 123');
  for (let index = 0; index < 10; index++) await page.locator('#next-folder').click();
  await waitText('#folder-page-label', '101–110 of 123');
  assert.ok(calls.some(call => call.endpoint.endsWith('/folders/1') && call.query === '?page=1'));
  await page.locator('#previous-folder').click(); await waitText('#folder-page-label', '91–100 of 123');
  await page.locator('#trail button').first().click(); await waitText('#folder-page-label', '1–10 of 123');

  failFolder = true;
  await page.locator('#folder-rows button.item-name').filter({ hasText: 'Users' }).click();
  await waitText('#notice', 'could not be completed');
  assert.equal(await page.locator('#directory-title').textContent(), drive);
  assert.equal(await page.locator('#file-rows tr').count(), 5);
  failFolder = false;
  await page.locator('#folder-rows button.item-name').filter({ hasText: 'Users' }).click(); await waitText('#directory-title', 'Users');

  for (const width of [1920, 1440, 1280, 1024, 768, 540, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow at ' + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('#query').evaluate(input => parseFloat(getComputedStyle(input).fontSize) >= 16));
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });

  failScan = true;
  await page.locator('#scan').click(); await waitText('#notice', 'Access denied');
  assert.equal(await page.locator('#scan').isDisabled(), false);
  assert.equal(await page.locator('#file-rows tr').count(), 5);
  failScan = false;

  // An old search response must not replace results from a newer scan.
  await page.locator('#query').fill('delayed'); await page.locator('#search').click();
  await page.waitForTimeout(100);
  assert.equal(typeof delayedSearch, 'function');
  await page.locator('#scan').click(); await waitText('#state', 'Scanning');
  delayedSearch(); delayedSearch = null;
  await ready();
  assert.ok(!(await page.locator('#file-rows').innerText()).includes('STALE-RESULT'));

  await page.locator('#scan').click(); await waitText('#state', 'Scanning');
  await page.locator('#cancel').click(); await waitText('#state', 'Stopped');
  await page.waitForSelector('#file-rows tr');
  assert.equal(await page.locator('#files-content').isVisible(), true);
  assert.equal(await page.locator('#folder-content').isVisible(), true);
  assert.equal(await page.locator('#scan-label').textContent(), 'Start a new scan');

  state = { ...completed(), state: 'partial', error_count: 2, errors: [{ path: drive + 'System Volume Information', message: '[WinError 5] Native system message' }] };
  await page.reload(); await waitText('#state', 'partial results');
  await page.locator('#warning-summary').click();
  assert.equal(await page.locator('#permission-help').isVisible(), true);
  await waitText('#errors', 'Access denied');

  unauthorized = true;
  await page.reload(); await waitText('#notice', 'session has expired');
  assert.equal(await page.locator('#scan').isDisabled(), true);
  unauthorized = false;
  state = completed(); await page.reload(); await ready();
  await page.locator('#quit').click(); await waitText('#main', 'Localdisk is closed.');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('disk-session')), null);
  assert.ok(calls.every(call => call.authorization === 'Bearer test-session-token'));
  assert.equal(calls.filter(call => ['/browse', '/locations'].includes(call.endpoint)).length, 0);
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(expectedResourceErrors.length, 3);

  const { layout } = await import(pathToFileURL(path.join(webRoot, 'treemap.js')));
  for (const sizes of [[], [0], [-1, 0], [1], [100, 40, 20, 0], [1e12, 1, 1, 1], [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]]) {
    const tiles = layout(sizes.map((size, id) => ({ id, size })), 300, 300);
    for (const tile of tiles) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(tile[key]) && tile[key] >= -1e-6);
    if (sizes.some(size => size > 0)) assert.ok(Math.abs(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0) - 90000) < 1e-3);
  }
  assert.deepEqual(layout([{ id: 1, size: 100 }], 0, 300), []);

  const report = {
    passed: true,
    checks: ['English interface without slogans or tabs', 'Vertical drive, metrics, files, and explorer layout', 'Local Manrope font under production CSP', 'C drive scan with session authentication', 'Largest-file Show more across API pages', 'Independent folder navigation and size map', 'Folder pagination across the 100-row API boundary', 'Search, filters, and 250-result cap', 'Clipboard and Explorer action requests', 'HTML-like filenames rendered as text', 'Persistent light and dark themes', 'Eight responsive widths without overflow', 'Failed request recovery', 'Stale response isolation after a new scan', 'Cancellation with both partial result sections', 'Permission guidance and English diagnostics', 'Session expiry and Quit', 'Treemap geometry'],
    apiCalls: calls.length,
    browserErrors,
    externalRequests,
    windowsExecutableRun: false,
  };
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  delayedSearch?.();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

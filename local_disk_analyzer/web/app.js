import { makeTreemap } from './treemap.js?v=3';

const $ = id => document.getElementById(id);
const SCAN_ROOT = 'C:\\';
const INITIAL_FILES = 5;
const MORE_FILES = 10;
const FOLDER_PAGE_SIZE = 10;
const SERVER_PAGE_SIZE = 100;
const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const isBusy = state => ['scanning', 'cancelling'].includes(state);
const hasResults = state => ['completed', 'partial', 'cancelled'].includes(state);

let token = location.hash.slice(1);
try {
  token ||= sessionStorage.getItem('disk-session');
  if (location.hash && token) sessionStorage.setItem('disk-session', token);
} catch { /* The URL token also works when browser storage is unavailable. */ }
if (location.hash && token) history.replaceState(null, '', location.pathname + location.search);

let status = { state: 'idle', scan: 0 };
let initialized = false;
let starting = false;
let quitting = false;
let connectionLost = false;
let pollTimer;
let fileRequest = 0;
let folderRequest = 0;
let fileBusy = false;
let folderBusy = false;
let fileMode = 'largest';
let fileItems = [];
let fileTotal = 0;
let fileVisible = 0;
let nextFilePage = 0;
let currentFolder = 1;
let folderOffset = 0;
let folderData = null;
const folderCache = new Map();

function formatSize(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return number.format(value) + ' B';
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 5);
  return decimal.format(value / 1024 ** index) + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][index];
}
function duration(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return value < 60 ? value + ' s' : Math.floor(value / 60) + ' min ' + String(value % 60).padStart(2, '0') + ' s';
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
function button(label, action, className = '') {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.textContent = label;
  control.addEventListener('click', action);
  return control;
}
function actionButton(label, iconName, action, className = '') {
  const control = button('', action, 'icon-button ' + className);
  control.append(icon(iconName));
  control.title = label;
  control.setAttribute('aria-label', label);
  return control;
}
function notice(message = '') {
  if (quitting) return;
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode';
  $('theme').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
  $('theme').setAttribute('aria-label', label);
  $('theme').title = label;
  document.dispatchEvent(new Event('themechange'));
}
try { setTheme(localStorage.getItem('localdisk-theme') === 'dark' ? 'dark' : 'light'); }
catch { setTheme('light'); }
$('theme').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  try { localStorage.setItem('localdisk-theme', theme); } catch { /* Keep the current theme for this visit. */ }
});

async function api(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch('/api' + path, {
      method,
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + (token ?? ''), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach Localdisk. Make sure LocalDiskAnalyzer.exe is still running.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('This local session has expired. Reopen LocalDiskAnalyzer.exe.');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Localdisk returned an unexpected response. Try again.'); }
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : '';
    if (/denied|permission|WinError 5|Errno 13/i.test(detail)) {
      throw new Error('Access denied. Reopen LocalDiskAnalyzer.exe with Run as administrator for fewer permission errors.');
    }
    throw new Error(response.status === 409 ? 'A scan is already running. Wait for it to finish or stop it.' : 'The request could not be completed. Try again.');
  }
  return data;
}
const resultPath = (scan, suffix) => '/scans/' + scan + suffix;
const requestIsCurrent = (id, current, scan) => !quitting && id === current && scan === status.scan && hasResults(status.state);

async function openItem(item) {
  if (!hasResults(status.state) || starting || quitting) return;
  notice();
  try { await api(resultPath(status.scan, '/items/' + item.id + '/open'), 'POST'); }
  catch (error) { notice(error.message); }
}
async function copyPath(item, control) {
  try {
    await navigator.clipboard.writeText(item.path);
    control.replaceChildren(icon('check'));
    control.setAttribute('aria-label', 'Path copied');
    setTimeout(() => {
      control.replaceChildren(icon('copy'));
      control.setAttribute('aria-label', 'Copy path for ' + item.name);
    }, 1500);
  } catch { notice('Clipboard access is unavailable. The full path is also shown when you hover over the item.'); }
}
function kindOf(item) {
  if (item.folder) return 'folder';
  const extension = item.name.split('.').at(-1).toLowerCase();
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['zip', 'rar', '7z', 'gz', 'tar', 'iso', 'vhdx'].includes(extension)) return 'archive';
  if (['jpg', 'jpeg', 'png', 'webp', 'svg', 'gif', 'heic', 'psd', 'raw'].includes(extension)) return 'image';
  return 'file';
}
function drawRows(target, items, showPath) {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement('tr');
    row.dataset.id = item.id;
    const name = row.insertCell();
    name.title = item.path ?? item.name;
    const content = document.createElement('div');
    content.className = 'item-content';
    const mark = document.createElement('span');
    mark.className = 'item-icon';
    mark.dataset.kind = kindOf(item);
    mark.append(icon(kindOf(item)));
    const text = document.createElement('div');
    text.className = 'item-text';
    const title = item.folder && !item.unavailable
      ? button(item.name, () => navigateFolder(item.id), 'item-name')
      : document.createElement('span');
    title.className = 'item-name';
    title.textContent = item.name;
    const detail = document.createElement('span');
    detail.className = 'item-detail';
    const extension = item.name.includes('.') ? item.name.split('.').at(-1).toUpperCase() : '';
    detail.textContent = showPath && item.path ? item.path : item.folder ? 'Folder' : extension ? extension + ' file' : 'File';
    if (item.partial || item.unavailable) {
      const warning = document.createElement('span');
      warning.className = 'item-state';
      warning.textContent = item.unavailable ? 'Unavailable' : 'Partial';
      detail.append(warning);
    }
    text.append(title, detail);
    content.append(mark, text);
    name.append(content);
    const size = row.insertCell();
    size.className = 'size';
    size.textContent = formatSize(item.size);
    if (Number.isFinite(item.size)) size.title = number.format(item.size) + ' bytes';
    const actions = row.insertCell();
    const group = document.createElement('div');
    group.className = 'row-actions';
    if (item.path) {
      const copy = actionButton('Copy path for ' + item.name, 'copy', () => copyPath(item, copy), 'copy');
      group.append(copy);
    }
    if (!item.unavailable) group.append(actionButton('Open location for ' + item.name, 'open', () => openItem(item), 'open'));
    actions.append(group);
    fragment.append(row);
  }
  $(target).replaceChildren(fragment);
}

function updateFileControls() {
  if (quitting) return;
  $('search').disabled = !hasResults(status.state) || starting || fileBusy;
  $('show-more').disabled = fileBusy || starting;
  $('clear').disabled = fileBusy || starting;
  $('file-results').setAttribute('aria-busy', String(fileBusy));
}
function renderFiles() {
  const shown = fileItems.slice(0, fileVisible);
  drawRows('file-rows', shown, true);
  $('files-empty').hidden = true;
  $('files-content').hidden = false;
  $('file-total').textContent = fileMode === 'search' ? 'Search results' : number.format(fileTotal) + ' files';
  $('file-caption').textContent = fileMode === 'search'
    ? 'Showing ' + number.format(shown.length) + ' of ' + number.format(fileTotal) + ' matches'
    : 'Showing ' + number.format(shown.length) + ' of the ' + number.format(fileTotal) + ' largest files';
  $('files-no-rows').hidden = shown.length > 0;
  $('files-no-rows').textContent = fileMode === 'search' ? 'No matching items. Try another name or extension.' : 'No readable files were found.';
  $('clear').hidden = fileMode !== 'search';
  const canShowMore = fileVisible < fileItems.length || (fileMode === 'largest' && fileItems.length < fileTotal);
  $('show-more').hidden = !canShowMore;
  $('file-limit').hidden = fileMode !== 'search' || fileTotal <= fileItems.length || fileVisible < fileItems.length;
  $('file-limit').textContent = 'Search returns the 250 largest matches.';
  updateFileControls();
}
async function loadLargest(reset = true) {
  if (!hasResults(status.state) || starting || quitting) return;
  const request = ++fileRequest;
  const scan = status.scan;
  const targetPage = reset ? 0 : nextFilePage;
  fileBusy = true;
  updateFileControls();
  if (reset && $('files-content').hidden) $('files-empty').textContent = 'Loading files…';
  try {
    const data = await api(resultPath(scan, '/largest?page=' + targetPage));
    if (!requestIsCurrent(request, fileRequest, scan)) return;
    if (reset) {
      fileItems = data.rows;
      fileVisible = Math.min(INITIAL_FILES, fileItems.length);
    } else {
      const known = new Set(fileItems.map(item => String(item.id)));
      fileItems = [...fileItems, ...data.rows.filter(item => !known.has(String(item.id)))];
      fileVisible = Math.min(fileVisible + MORE_FILES, fileItems.length);
    }
    fileMode = 'largest';
    fileTotal = Math.max(0, data.total);
    if (!data.rows.length) fileTotal = fileItems.length;
    nextFilePage = targetPage + 1;
    renderFiles();
  } catch (error) {
    if (requestIsCurrent(request, fileRequest, scan)) {
      if ($('files-content').hidden) $('files-empty').textContent = 'Files could not be loaded. Start a new scan to try again.';
      notice(error.message);
    }
  } finally {
    if (request === fileRequest && !quitting) { fileBusy = false; updateFileControls(); }
  }
}
async function searchFiles() {
  if (!hasResults(status.state) || starting || quitting) return;
  const query = $('query').value.trim();
  const extension = $('extension').value.trim();
  if (!query && !extension) { await loadLargest(); return; }
  const request = ++fileRequest;
  const scan = status.scan;
  fileBusy = true;
  updateFileControls();
  notice();
  try {
    const parameters = new URLSearchParams({ q: query, ext: extension });
    const data = await api(resultPath(scan, '/search?' + parameters));
    if (!requestIsCurrent(request, fileRequest, scan)) return;
    fileMode = 'search';
    fileItems = data.rows;
    fileTotal = data.total;
    fileVisible = Math.min(INITIAL_FILES, fileItems.length);
    renderFiles();
  } catch (error) { if (requestIsCurrent(request, fileRequest, scan)) notice(error.message); }
  finally { if (request === fileRequest && !quitting) { fileBusy = false; updateFileControls(); } }
}
$('show-more').addEventListener('click', () => {
  if (fileBusy || !hasResults(status.state) || starting) return;
  if (fileVisible < fileItems.length) {
    fileVisible = Math.min(fileVisible + MORE_FILES, fileItems.length);
    renderFiles();
  } else if (fileMode === 'largest' && fileItems.length < fileTotal) loadLargest(false);
});
$('search-form').addEventListener('submit', event => { event.preventDefault(); searchFiles(); });
$('clear').addEventListener('click', () => {
  $('query').value = '';
  $('extension').value = '';
  notice();
  loadLargest();
});

function highlightFolderItem(id, focus = false) {
  if (quitting) return;
  for (const row of $('folder-rows').children) row.classList.toggle('selected', row.dataset.id === String(id));
  if (focus) $('folder-rows').querySelector('.selected .open')?.focus({ preventScroll: true });
}
function activateMapItem(item) {
  if (item.folder) { navigateFolder(item.id); return; }
  if (folderData) {
    const index = folderData.rows.findIndex(row => String(row.id) === String(item.id));
    if (index >= 0) {
      folderOffset = Math.floor(folderOffset / SERVER_PAGE_SIZE) * SERVER_PAGE_SIZE + Math.floor(index / FOLDER_PAGE_SIZE) * FOLDER_PAGE_SIZE;
      renderFolder(folderData);
    }
  }
  highlightFolderItem(item.id, true);
  $('folder-results').scrollIntoView({ behavior: 'auto', block: 'nearest' });
}
const setTreemap = makeTreemap($('treemap'), $('map-label'), formatSize, activateMapItem, highlightFolderItem);
function drawTrail(trail = []) {
  $('trail').replaceChildren();
  for (const [index, item] of trail.entries()) {
    if (index) $('trail').append(icon('chevron'));
    const crumb = button(item.name, () => navigateFolder(item.id));
    if (index === trail.length - 1) crumb.setAttribute('aria-current', 'location');
    $('trail').append(crumb);
  }
}
function updateFolderControls() {
  if (quitting) return;
  $('folder-results').setAttribute('aria-busy', String(folderBusy));
  $('previous-folder').disabled = folderBusy || starting || folderOffset === 0;
  $('next-folder').disabled = folderBusy || starting || !folderData || folderOffset + FOLDER_PAGE_SIZE >= folderData.total;
}
function renderFolder(data) {
  const start = folderOffset % SERVER_PAGE_SIZE;
  const rows = data.rows.slice(start, start + FOLDER_PAGE_SIZE);
  drawRows('folder-rows', rows, false);
  drawTrail(data.trail);
  $('folder-total').textContent = number.format(data.total) + ' items';
  $('directory-title').textContent = data.directory.name;
  $('folder-caption').textContent = 'Total size: ' + formatSize(data.directory.size) + (data.directory.partial ? ' · Partial results' : '');
  $('folders-empty').hidden = true;
  $('folder-content').hidden = false;
  $('folders-no-rows').hidden = rows.length > 0;
  $('folder-pagination').hidden = data.total <= FOLDER_PAGE_SIZE;
  $('folder-page-label').textContent = data.total ? number.format(folderOffset + 1) + '–' + number.format(Math.min(folderOffset + FOLDER_PAGE_SIZE, data.total)) + ' of ' + number.format(data.total) + ' items' : '0 items';
  $('size-map').hidden = !data.chart?.some(item => item.size > 0);
  if (!$('size-map').hidden) setTreemap(data.chart, data.other);
  updateFolderControls();
}
async function loadFolder(id = currentFolder, offset = folderOffset, moveFocus = false) {
  if (!hasResults(status.state) || starting || quitting) return;
  const request = ++folderRequest;
  const scan = status.scan;
  const serverPage = Math.floor(offset / SERVER_PAGE_SIZE);
  const key = id + ':' + serverPage;
  folderBusy = true;
  updateFolderControls();
  if ($('folder-content').hidden) $('folders-empty').textContent = 'Loading folders…';
  try {
    const data = folderCache.get(key) ?? await api(resultPath(scan, '/folders/' + id + '?page=' + serverPage));
    if (!requestIsCurrent(request, folderRequest, scan)) return;
    folderCache.set(key, data);
    if (folderCache.size > 40) folderCache.delete(folderCache.keys().next().value);
    currentFolder = id;
    folderOffset = offset;
    folderData = data;
    renderFolder(data);
    if (moveFocus) {
      $('directory-title').focus({ preventScroll: true });
      $('explorer-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  } catch (error) {
    if (requestIsCurrent(request, folderRequest, scan)) {
      if ($('folder-content').hidden) $('folders-empty').textContent = 'Folders could not be loaded. Start a new scan to try again.';
      notice(error.message);
    }
  } finally { if (request === folderRequest && !quitting) { folderBusy = false; updateFolderControls(); } }
}
function navigateFolder(id) { notice(); loadFolder(id, 0, true); }
$('previous-folder').addEventListener('click', () => { if (folderOffset > 0 && !folderBusy) loadFolder(currentFolder, Math.max(0, folderOffset - FOLDER_PAGE_SIZE)); });
$('next-folder').addEventListener('click', () => { if (folderData && folderOffset + FOLDER_PAGE_SIZE < folderData.total && !folderBusy) loadFolder(currentFolder, folderOffset + FOLDER_PAGE_SIZE); });

function readErrorMessage(message = '') {
  const match = /(WinError|Errno)\s*(\d+)/i.exec(message);
  if (match) {
    const windows = match[1].toLowerCase() === 'winerror';
    const code = Number(match[2]);
    if ((windows && code === 5) || (!windows && [1, 13].includes(code))) return 'Access denied.';
    if (windows && code === 32) return 'This file is in use.';
    if (code === 2 || (windows && code === 3)) return 'This item is no longer available.';
    return 'Could not read this item (system error ' + code + ').';
  }
  if (/denied|permission/i.test(message)) return 'Access denied.';
  return 'Could not read this item.';
}
function resetResults(active, failed) {
  fileRequest++;
  folderRequest++;
  fileBusy = false;
  folderBusy = false;
  fileItems = [];
  fileTotal = 0;
  fileVisible = 0;
  folderData = null;
  folderCache.clear();
  $('files-content').hidden = true;
  $('folder-content').hidden = true;
  $('files-empty').hidden = false;
  $('folders-empty').hidden = false;
  $('file-total').textContent = '';
  $('folder-total').textContent = '';
  const waiting = active ? 'Scanning. Results will appear when the scan finishes.' : failed ? 'No results are available. Try a new scan.' : null;
  $('files-empty').textContent = waiting ?? 'Scan C:\\ to find the largest files.';
  $('folders-empty').textContent = waiting ?? 'Folder contents will appear after the scan.';
}
function display(next) {
  if (quitting) return;
  const previous = status;
  status = next;
  const active = isBusy(next.state);
  const available = hasResults(next.state);
  document.body.dataset.scan = next.state;
  $('scan').disabled = !initialized || active || starting;
  $('scan-label').textContent = active ? (next.state === 'cancelling' ? 'Stopping…' : 'Scanning…') : next.scan ? 'Start a new scan' : 'Scan C:\\';
  $('cancel').hidden = !active;
  $('cancel').disabled = next.state === 'cancelling';
  for (const id of ['query', 'extension']) $(id).disabled = !available || starting;
  const labels = { idle: 'Ready', scanning: 'Scanning', cancelling: 'Stopping', completed: 'Scan complete', partial: 'Scan complete · partial results', cancelled: 'Stopped · partial results', failed: 'Scan failed' };
  $('state').textContent = labels[next.state] ?? 'Unknown status';
  $('state').dataset.state = next.state;
  $('elapsed').textContent = next.scan ? (active ? 'Elapsed: ' : 'Duration: ') + duration(next.elapsed) : 'No scan yet';
  $('volume-root').textContent = next.root || SCAN_ROOT;
  const volume = next.volume;
  const percent = volume?.total > 0 && Number.isFinite(volume.used) ? Math.min(100, Math.max(0, 100 * volume.used / volume.total)) : null;
  $('used-percent').textContent = percent == null ? '—' : Math.round(percent) + '%';
  $('used-caption').textContent = percent == null ? 'not measured yet' : 'used';
  $('usage-bar').firstElementChild.style.width = (percent ?? 0) + '%';
  if (percent == null) {
    $('usage-bar').removeAttribute('aria-valuenow');
    $('usage-bar').setAttribute('aria-valuetext', 'Not measured yet');
  } else {
    $('usage-bar').setAttribute('aria-valuenow', String(Math.round(percent)));
    $('usage-bar').setAttribute('aria-valuetext', Math.round(percent) + ' percent used');
  }
  $('capacity').textContent = formatSize(volume?.total);
  $('used').textContent = formatSize(volume?.used);
  $('available').textContent = formatSize(volume?.free);
  $('file-count').textContent = next.scan ? number.format(next.files ?? 0) : '—';
  $('folder-count').textContent = next.scan ? number.format(next.folders ?? 0) : '—';
  $('scanned-size').textContent = next.scan ? formatSize(next.bytes ?? 0) : '—';
  $('warnings').hidden = !next.error_count && !next.skipped && !next.failure;
  $('warning-summary').textContent = [next.error_count ? number.format(next.error_count) + ' read error' + (next.error_count === 1 ? '' : 's') : '', next.skipped ? number.format(next.skipped) + ' links or special items skipped' : '', next.failure ? 'Scan failure' : ''].filter(Boolean).join(' · ');
  $('permission-help').hidden = !next.error_count;
  $('failure-detail').hidden = !next.failure;
  $('failure-detail').textContent = 'The drive could not be fully scanned. Check that it is available and try again.';
  const errors = (next.errors ?? []).map(item => {
    const row = document.createElement('li');
    row.textContent = item.path + ' — ' + readErrorMessage(item.message);
    return row;
  });
  if (next.error_count > errors.length) {
    const more = document.createElement('li');
    more.textContent = errors.length ? 'Only the first ' + number.format(errors.length) + ' errors are listed.' : 'Error details are not available.';
    errors.push(more);
  }
  $('errors').replaceChildren(...errors);
  if (!available) {
    resetResults(active, next.state === 'failed');
  } else if (!hasResults(previous.state) || previous.scan !== next.scan) {
    $('query').value = '';
    $('extension').value = '';
    fileMode = 'largest';
    currentFolder = 1;
    folderOffset = 0;
    folderCache.clear();
    loadLargest();
    loadFolder(1, 0);
  }
  updateFileControls();
  updateFolderControls();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (quitting || !isBusy(status.state)) return;
  pollTimer = setTimeout(async () => {
    try {
      const next = await api('/status');
      if (!quitting) {
        if (connectionLost) { notice(); connectionLost = false; }
        display(next);
      }
    } catch (error) {
      if (!quitting) { connectionLost = true; notice(error.message); }
    }
    schedulePoll();
  }, connectionLost ? 2000 : 600);
}
$('scan-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!initialized || starting || isBusy(status.state) || quitting) return;
  starting = true;
  $('scan').disabled = true;
  updateFileControls();
  updateFolderControls();
  notice();
  try {
    const next = await api('/scan', 'POST', { path: SCAN_ROOT });
    starting = false;
    if (!quitting) { display(next); schedulePoll(); }
  } catch (error) {
    starting = false;
    if (!quitting) { display(status); notice(error.message); }
  }
});
$('cancel').addEventListener('click', async () => {
  $('cancel').disabled = true;
  try {
    const next = await api('/cancel', 'POST');
    if (!quitting) { display(next); schedulePoll(); }
  } catch (error) { if (!quitting) { $('cancel').disabled = status.state === 'cancelling'; notice(error.message); } }
});
$('quit').addEventListener('click', async () => {
  if (quitting) return;
  $('quit').disabled = true;
  try {
    await api('/quit', 'POST');
    quitting = true;
    fileRequest++;
    folderRequest++;
    clearTimeout(pollTimer);
    try { sessionStorage.removeItem('disk-session'); } catch { /* No stored session. */ }
    const message = document.createElement('section');
    message.className = 'card';
    const title = document.createElement('h1');
    title.textContent = 'Localdisk is closed.';
    const description = document.createElement('p');
    description.className = 'empty-message';
    description.textContent = 'You can close this browser tab.';
    message.append(title, description);
    $('main').replaceChildren(message);
    document.title = 'Localdisk — Closed';
  } catch (error) { $('quit').disabled = false; notice(error.message); }
});
document.addEventListener('keydown', event => {
  if (quitting || event.key !== '/' || event.ctrlKey || event.altKey || event.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if ($('query') && !$('query').disabled && !$('files-content').hidden) {
    event.preventDefault();
    $('query').focus();
  }
});
async function initialize() {
  try {
    const latest = await api('/status');
    initialized = true;
    display(latest);
    schedulePoll();
  } catch (error) {
    notice(error.message);
    $('scan').disabled = true;
    $('quit').disabled = true;
  }
}
initialize();

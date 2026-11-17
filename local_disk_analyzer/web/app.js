import { makeTreemap } from "./treemap.js?v=2";

const $ = id => document.getElementById(id);
// Le scan démarre toujours sur C:, sans sélecteur ni dialogue de dossier.
const SCAN_ROOT = "C:\\";
let token = location.hash.slice(1);
try {
  token ||= sessionStorage.getItem("disk-session");
  if (location.hash && token) sessionStorage.setItem("disk-session", token);
} catch { /* Une session dans l'URL fonctionne aussi sans stockage navigateur. */ }
if (location.hash && token) history.replaceState(null, "", location.pathname + location.search);

const states = {
  idle: "Prêt à scanner", scanning: "Analyse en cours", cancelling: "Arrêt en cours",
  completed: "Analyse terminée", partial: "Avec quelques réserves",
  cancelled: "Analyse arrêtée", failed: "Analyse interrompue",
};
const busy = state => ["scanning", "cancelling"].includes(state);
const ready = state => ["completed", "partial", "cancelled"].includes(state);
const number = new Intl.NumberFormat("fr-FR");
const decimal = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const formatSize = value => {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return number.format(value) + " o";
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 5);
  return decimal.format(value / 1024 ** index) + " " + ["o", "Kio", "Mio", "Gio", "Tio", "Pio"][index];
};
const duration = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return value < 60 ? value + " s" : Math.floor(value / 60) + " min " + String(value % 60).padStart(2, "0") + " s";
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme").replaceChildren(icon(theme === "dark" ? "sun" : "moon"));
  $("theme").setAttribute("aria-label", "Activer le thème " + (theme === "dark" ? "clair" : "sombre"));
  document.dispatchEvent(new Event("themechange"));
}
try { applyTheme(localStorage.getItem("localdisk-theme") === "light" ? "light" : "dark"); }
catch { applyTheme("dark"); }
$("theme").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(theme);
  try { localStorage.setItem("localdisk-theme", theme); } catch { /* Préférence non persistée. */ }
});

let status = { state: "idle", scan: 0 };
let view = "largest", folder = 1, page = 0, pageCount = 1, revision = 0;
let pollTimer, quitting = false, initialized = false, starting = false, connectionLost = false;

async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch("/api" + path, {
      method, cache: "no-store",
      headers: { Authorization: "Bearer " + (token ?? ""), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error("Connexion à l’application perdue. Vérifiez que LocalDiskAnalyzer.exe est toujours ouvert."); }
  if (response.status === 401 || response.status === 403) {
    throw new Error("La session locale n’est plus accessible. Relancez LocalDiskAnalyzer.exe pour ouvrir l’application.");
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error("L’application a renvoyé une réponse inattendue. Réessayez dans un instant."); }
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "La demande n’a pas pu aboutir. Réessayez.");
  return data;
}
function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
const resultPath = suffix => "/scans/" + status.scan + suffix;
function selectNavigation(id) {
  for (const name of ["nav-overview", "nav-largest", "nav-explore"]) {
    $(name).classList.toggle("active", name === id);
    if (name === id) $(name).setAttribute("aria-current", "page");
    else $(name).removeAttribute("aria-current");
  }
}
function highlight(id, focus = false) {
  for (const row of $("rows").children) row.classList.toggle("selected", row.dataset.id === String(id));
  if (focus) $("rows").querySelector(".selected .open")?.focus();
}
const setTreemap = makeTreemap($("treemap"), $("map-label"), formatSize,
  item => item.folder ? navigate(item.id) : highlight(item.id, true), highlight);
function button(label, action, className) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener("click", action);
  return element;
}
function actionButton(label, iconName, action, className = "") {
  const element = button("", action, "icon-button " + className);
  element.append(icon(iconName));
  element.title = label;
  element.setAttribute("aria-label", label);
  return element;
}
function navigate(id) {
  view = "explore"; folder = id; page = 0;
  selectNavigation("nav-explore");
  loadResults(true);
}
async function openItem(item) {
  notice();
  try { await api(resultPath("/items/" + item.id + "/open"), "POST"); }
  catch (error) { if (!quitting) notice(error.message); }
}
async function copyPath(item, control) {
  try {
    await navigator.clipboard.writeText(item.path);
    control.replaceChildren(icon("check"));
    control.setAttribute("aria-label", "Chemin copié");
    setTimeout(() => {
      control.replaceChildren(icon("copy"));
      control.setAttribute("aria-label", "Copier le chemin de " + item.name);
    }, 1600);
  } catch { if (!quitting) notice("La copie n’est pas disponible. Le chemin complet est affiché au survol de l’élément."); }
}
function kindOf(item) {
  if (item.folder) return "folder";
  const extension = item.name.split(".").at(-1).toLowerCase();
  if (["mp4", "mov", "mkv", "avi", "webm", "m4v"].includes(extension)) return "video";
  if (["zip", "rar", "7z", "gz", "tar", "iso", "vhdx"].includes(extension)) return "archive";
  if (["jpg", "jpeg", "png", "webp", "svg", "gif", "heic", "psd", "raw"].includes(extension)) return "image";
  return "file";
}
function drawRows(rows, showPath, totalSize) {
  const fragment = document.createDocumentFragment();
  for (const item of rows) {
    const row = document.createElement("tr");
    row.dataset.id = item.id;
    const name = row.insertCell();
    name.title = item.path ?? item.name;
    const content = document.createElement("div"); content.className = "name-content";
    const mark = document.createElement("span"); mark.className = "file-icon";
    const kind = kindOf(item); mark.dataset.kind = kind; mark.append(icon(kind));
    const text = document.createElement("div"); text.className = "name-text";
    const title = item.folder && !item.unavailable
      ? button(item.name, () => navigate(item.id)) : document.createElement("span");
    title.textContent = item.name;
    text.append(title);
    const meta = document.createElement("span"); meta.className = "item-meta";
    const ext = item.name.includes(".") ? item.name.split(".").at(-1).toUpperCase() : "Fichier";
    meta.textContent = item.folder ? "Dossier" : ext + (ext === "Fichier" ? "" : " · Fichier");
    if (item.partial || item.unavailable) {
      const warning = document.createElement("span"); warning.className = "row-status";
      warning.textContent = item.unavailable ? "Inaccessible" : "Partiel"; meta.append(warning);
    }
    text.append(meta); content.append(mark, text); name.append(content);
    const path = row.insertCell(); path.className = "item-path path-column"; path.hidden = !showPath;
    path.textContent = path.title = item.path ?? "";
    const size = row.insertCell(); size.className = "size";
    const value = document.createElement("span"); value.className = "size-value";
    value.textContent = formatSize(item.size); size.append(value);
    if (Number.isFinite(item.size)) {
      size.title = number.format(item.size) + " octets";
      const track = document.createElement("span"); track.className = "size-track"; track.setAttribute("aria-hidden", "true");
      const bar = document.createElement("span");
      bar.style.width = (totalSize > 0 ? Math.min(100, Math.max(0, 100 * item.size / totalSize)) : 0) + "%";
      track.append(bar); size.append(track);
    }
    const actions = row.insertCell(); const group = document.createElement("div"); group.className = "row-actions";
    if (item.path) {
      const copy = actionButton("Copier le chemin de " + item.name, "copy", () => copyPath(item, copy), "copy");
      group.append(copy);
    }
    if (!item.unavailable) group.append(actionButton("Afficher l’emplacement de " + item.name, "open", () => openItem(item), "open"));
    actions.append(group); fragment.append(row);
  }
  $("rows").replaceChildren(fragment);
}
function drawTrail(trail) {
  $("trail").hidden = !trail?.length;
  $("trail").replaceChildren();
  if (!trail) return;
  for (const item of trail) {
    if ($("trail").childElementCount) {
      const divider = document.createElement("span"); divider.textContent = "›"; divider.setAttribute("aria-hidden", "true");
      $("trail").append(divider);
    }
    const crumb = button(item.name, () => navigate(item.id));
    if (item === trail.at(-1)) crumb.setAttribute("aria-current", "location");
    $("trail").append(crumb);
  }
}
async function loadResults(moveFocus = false) {
  if (!ready(status.state)) return;
  const request = ++revision, mode = view;
  const filters = new URLSearchParams({ q: $("query").value.trim(), ext: $("extension").value.trim() });
  const suffix = mode === "explore" ? "/folders/" + folder + "?page=" + page
    : mode === "largest" ? "/largest?page=" + page : "/search?" + filters;
  $("results").setAttribute("aria-busy", "true");
  notice();
  try {
    const data = await api(resultPath(suffix));
    if (revision !== request || quitting) return;
    $("largest").setAttribute("aria-pressed", String(mode === "largest"));
    $("explore").setAttribute("aria-pressed", String(mode === "explore"));
    $("clear").hidden = mode !== "search";
    $("result-title").textContent = data.directory?.name ?? (mode === "largest" ? "Ce qui pèse le plus" : "Résultats de recherche");
    $("result-caption").textContent = mode === "largest"
      ? number.format(data.total) + " fichiers classés sur " + number.format(data.file_count) + " fichiers recensés"
      : mode === "explore"
        ? number.format(data.total) + " éléments · " + formatSize(data.directory.size) + (data.directory.partial ? " · Résultats partiels" : "")
        : number.format(data.total) + " résultat" + (data.total > 1 ? "s" : "") + (data.total > data.rows.length ? " · Les 250 plus volumineux" : "");
    drawTrail(data.trail);
    $("path-heading").hidden = mode === "explore";
    drawRows(data.rows, mode !== "explore", data.directory?.size ?? status.bytes);
    $("no-rows").hidden = Boolean(data.rows.length);
    $("no-rows").textContent = mode === "search" ? "Aucun résultat. Essayez un autre nom ou une autre extension." : "Ce dossier ne contient aucun élément accessible.";
    pageCount = Math.max(1, Math.ceil(data.total / 100));
    $("pagination").hidden = mode === "search" || pageCount <= 1;
    $("previous").disabled = page === 0;
    $("next").disabled = page + 1 >= pageCount;
    $("page-label").textContent = "Page " + (page + 1) + " sur " + pageCount;
    $("map").hidden = !data.chart?.some(item => item.size > 0);
    $("empty").hidden = true;
    $("results").hidden = false;
    if (!$("map").hidden) setTreemap(data.chart, data.other);
    if (moveFocus) $("result-title").focus();
  } catch (error) { if (revision === request) notice(error.message); }
  finally { if (revision === request) $("results").setAttribute("aria-busy", "false"); }
}
function display(next) {
  const previous = status;
  status = next;
  const state = next.state, active = busy(state), hasResults = ready(state);
  document.body.dataset.scan = state;
  $("state").dataset.state = state;
  $("state-label").textContent = states[state] ?? "État inconnu";
  $("scan").disabled = active || starting || !initialized;
  $("scan-label").textContent = active ? "Analyse en cours…" : next.scan ? "Rescanner C:\\" : "Scanner C:\\";
  $("scan-shortcut").disabled = active || starting || !initialized;
  $("scan-shortcut").hidden = active || state === "failed";
  $("cancel").hidden = !active;
  $("cancel").disabled = state === "cancelling";
  for (const id of ["largest", "explore", "query", "extension", "search", "nav-largest", "nav-explore"]) $(id).disabled = !hasResults;
  $("clear").hidden = !hasResults || view !== "search";
  $("volume-root").textContent = next.root || SCAN_ROOT;
  const volume = next.volume;
  const percent = volume?.total > 0 && Number.isFinite(volume.used) ? Math.min(100, Math.max(0, 100 * volume.used / volume.total)) : null;
  $("capacity").textContent = formatSize(volume?.total);
  $("used").textContent = formatSize(volume?.used);
  $("available").textContent = formatSize(volume?.free);
  $("used-percent").textContent = percent == null ? "—" : Math.round(percent) + "%";
  $("gauge-caption").textContent = percent == null ? "à analyser" : "de l’espace utilisé";
  $("gauge-fill").setAttribute("stroke-dasharray", (percent ?? 0) + " 100");
  $("usage-bar").firstElementChild.style.width = (percent ?? 0) + "%";
  $("volume-hint").textContent = volume?.total ? "Occupation du volume · tailles des fichiers recensées séparément" : "Les informations du disque apparaîtront au lancement du scan.";
  $("file-count").textContent = next.scan ? number.format(next.files ?? 0) : "—";
  $("folder-count").textContent = next.scan ? number.format(next.folders ?? 0) : "—";
  $("scanned-size").textContent = next.scan ? formatSize(next.bytes ?? 0) : "—";
  const titles = { idle: "La place est là. Trouvons-la.", scanning: "Chaque fichier trouve sa place.", cancelling: "On termine proprement.", completed: "Votre disque n’a plus de secrets.", partial: "L’essentiel est sous vos yeux.", cancelled: "Une première vue de votre disque.", failed: "L’analyse n’a pas pu aboutir." };
  $("status-title").textContent = titles[state] ?? states[state];
  $("progress").textContent = active ? "Exploration de " + (next.root || SCAN_ROOT) + " · Les résultats arrivent à la fin de l’analyse."
    : hasResults ? number.format(next.files ?? 0) + " fichiers recensés. À vous d’explorer."
      : state === "failed" ? "Consultez les détails, puis relancez le scan de C:\\." : "Un clic pour voir ce qui se cache sur C:\\.";
  $("elapsed").textContent = next.scan ? (active ? "Écoulé : " : "Analysé en ") + duration(next.elapsed) : "Pas encore d’analyse";
  $("status-note").textContent = active ? "En direct" : hasResults ? "Résultats disponibles" : "À votre rythme";
  $("results-badge").textContent = active ? "ANALYSE EN COURS" : hasResults ? "SCAN N° " + next.scan : "EN ATTENTE DU SCAN";
  $("footer-note").textContent = next.scan ? "Tailles logiques · " + number.format(next.files ?? 0) + " fichiers recensés" : "Vos données restent sur cet ordinateur.";
  $("warnings").hidden = !next.error_count && !next.skipped && !next.failure;
  $("warning-summary").textContent = [next.error_count ? number.format(next.error_count) + " erreurs de lecture" : "", next.skipped ? number.format(next.skipped) + " liens ou éléments spéciaux ignorés" : "", next.failure].filter(Boolean).join(" · ");
  const errorList = (next.errors ?? []).map(({ path, message }) => {
    const item = document.createElement("li"); item.textContent = path + " — " + message; return item;
  });
  if (next.errors?.length && next.error_count > next.errors.length) {
    const item = document.createElement("li"); item.textContent = "Affichage des " + next.errors.length + " premières erreurs."; errorList.push(item);
  }
  $("errors").replaceChildren(...errorList);
  if (!hasResults) {
    revision++;
    $("results").hidden = true;
    $("results").setAttribute("aria-busy", "false");
    $("empty").hidden = false;
    $("empty-title").textContent = active ? "Un peu de patience, beaucoup de clarté." : state === "failed" ? "On réessaie ?" : "Chaque giga mérite sa place.";
    $("empty-copy").textContent = active ? "Votre disque est en cours d’exploration. Vous pourrez parcourir les résultats dès la fin du scan."
      : state === "failed" ? "Un problème a empêché l’analyse. Les détails ci-dessus vous aideront à comprendre ce qui s’est passé."
        : "Lancez l’analyse de C:\\ pour découvrir les fichiers et dossiers qui occupent votre disque.";
    $("empty-eyebrow").textContent = active ? "ON FAIT LE TOUR DE VOTRE DISQUE" : state === "failed" ? "L’ANALYSE A RENCONTRÉ UN PROBLÈME" : "UN CLIC SUFFIT POUR Y VOIR PLUS CLAIR";
    selectNavigation("nav-overview");
  } else if (!ready(previous.state) || previous.scan !== next.scan) {
    view = "largest"; folder = 1; page = 0;
    $("query").value = ""; $("extension").value = "";
    loadResults();
  }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (quitting || !busy(status.state)) return;
  pollTimer = setTimeout(async () => {
    try {
      const next = await api("/status");
      if (!quitting) {
        if (connectionLost) { notice(); connectionLost = false; }
        display(next);
      }
    } catch (error) { if (!quitting) { connectionLost = true; notice(error.message); } }
    schedulePoll();
  }, connectionLost ? 2000 : 600);
}
$("scan-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!initialized || starting || busy(status.state) || quitting) return;
  starting = true;
  $("scan").disabled = true; $("scan-shortcut").disabled = true;
  notice();
  try {
    const next = await api("/scan", "POST", { path: SCAN_ROOT });
    starting = false;
    if (!quitting) { display(next); schedulePoll(); }
  } catch (error) { starting = false; if (!quitting) { display(status); notice(error.message); } }
});
$("scan-shortcut").addEventListener("click", () => $("scan-form").requestSubmit());
$("cancel").addEventListener("click", async () => {
  $("cancel").disabled = true;
  try { const next = await api("/cancel", "POST"); if (!quitting) { display(next); schedulePoll(); } }
  catch (error) { if (!quitting) { $("cancel").disabled = status.state === "cancelling"; notice(error.message); } }
});
$("quit").addEventListener("click", async () => {
  if (quitting) return;
  $("quit").disabled = true;
  try {
    await api("/quit", "POST");
    quitting = true; revision++; clearTimeout(pollTimer);
    try { sessionStorage.removeItem("disk-session"); } catch { /* Pas de session persistée. */ }
    const closed = document.createElement("section"); closed.className = "empty";
    const title = document.createElement("h1"); title.textContent = "À bientôt, et à vos projets.";
    const message = document.createElement("p"); message.textContent = "Localdisk est fermé. Vous pouvez fermer cet onglet.";
    closed.append(title, message); $("main").replaceChildren(closed);
    for (const id of ["nav-largest", "nav-explore", "nav-overview"]) $(id).disabled = true;
    document.title = "Localdisk — Application fermée";
  } catch (error) { $("quit").disabled = false; notice(error.message); }
});
$("largest").addEventListener("click", () => { view = "largest"; page = 0; selectNavigation("nav-largest"); loadResults(); });
$("explore").addEventListener("click", () => navigate(folder));
$("nav-overview").addEventListener("click", () => { selectNavigation("nav-overview"); window.scrollTo({ top: 0, behavior: "smooth" }); });
$("nav-largest").addEventListener("click", () => { $("largest").click(); $("workspace").scrollIntoView({ behavior: "smooth" }); });
$("nav-explore").addEventListener("click", () => navigate(folder));
$("previous").addEventListener("click", () => { if (page > 0) { page--; loadResults(); } });
$("next").addEventListener("click", () => { if (page + 1 < pageCount) { page++; loadResults(); } });
$("search-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!ready(status.state) || (!$("query").value.trim() && !$("extension").value.trim())) return;
  view = "search"; page = 0; loadResults();
});
$("clear").addEventListener("click", () => { $("query").value = ""; $("extension").value = ""; $("largest").click(); });
$("help").addEventListener("click", () => $("help-dialog").showModal());
for (const id of ["help-close", "help-done"]) $(id).addEventListener("click", () => $("help-dialog").close());
$("help-dialog").addEventListener("click", event => { if (event.target === $("help-dialog")) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
document.addEventListener("keydown", event => {
  if (event.key === "/" && !event.ctrlKey && !event.altKey && !event.metaKey && !$("help-dialog").open
      && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) && !$("query").disabled) {
    event.preventDefault(); $("query").focus();
  }
});
async function initialize() {
  $("scan").disabled = true; $("scan-shortcut").disabled = true;
  try { const latest = await api("/status"); initialized = true; display(latest); schedulePoll(); }
  catch (error) { notice(error.message); $("quit").disabled = true; }
}
initialize();

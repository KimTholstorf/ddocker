const view = document.getElementById("view");
const hero = document.getElementById("hero");
const q = document.getElementById("q");
// Set by the Worker: "private" on a key hostname (the mirror), "public" on the bare domain.
const MODE = document.body.dataset.mode === "public" ? "public" : "private";
const GITHUB_URL = document.body.dataset.github || "";
// The Hub browser runs on mirror hostnames; the public page is a front page
// unless PUBLIC_SEARCH is set.
const SEARCH = document.body.dataset.search === "on";
const VERSION = document.body.dataset.version || "";
const GUIDE_LABEL = MODE === "private" ? "client setup" : "about &amp; self-hosting";
let searchTimer;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const compact = (n) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
const bytes = (n) => (n ? (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : Math.round(n / 1e6) + " MB") : "");
function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso)) / 1000;
  for (const [unit, secs] of [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]]) {
    if (s >= secs) return `${Math.floor(s / secs)}${unit} ago`;
  }
  return "just now";
}
async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── pixel art ────────────────────────────────────────────────────────────
// Chunky 6x7 glyphs; rows are colored in bands like a CRT gradient.
const GLYPHS = {
  d: ["111110", "110011", "110011", "110011", "110011", "110011", "111110"],
  o: ["011110", "110011", "110011", "110011", "110011", "110011", "011110"],
  c: ["011111", "110000", "110000", "110000", "110000", "110000", "011111"],
  k: ["110011", "110110", "111100", "111000", "111100", "110110", "110011"],
  e: ["111111", "110000", "110000", "111110", "110000", "110000", "111111"],
  r: ["111110", "110011", "110011", "111110", "111100", "110110", "110011"],
};
const BAND = ["b1", "b1", "b2", "b2", "b3", "b3", "b4"];

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function wordmark(text, { cell = 10, drips = true } = {}) {
  const rand = rng(7);
  const rects = [];
  let x = 0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    g.forEach((row, y) => [...row].forEach((bit, i) => {
      if (bit === "1") rects.push(`<rect class="${BAND[y]}" x="${(x + i) * cell}" y="${y * cell}" width="${cell}" height="${cell}"/>`);
    }));
    // Pixels "dripping" off the bottom of some letters.
    if (drips) {
      for (let i = 0; i < 6; i++) {
        if (g[6][i] === "1" && rand() < 0.16) {
          const len = 1 + Math.floor(rand() * 2);
          for (let d = 1; d <= len; d++) rects.push(`<rect class="b4" x="${(x + i) * cell}" y="${(6 + d) * cell}" width="${cell}" height="${cell}"/>`);
        }
      }
    }
    x += g[0].length + 1;
  }
  const w = (x - 1) * cell, h = (drips ? 9 : 7) * cell;
  return `<svg class="wordmark" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" role="img" aria-label="${esc(text)}">${rects.join("")}</svg>`;
}

// Scattered squares: sparse at the sides, a dense band along the bottom
// edge, and a clear column in the middle so text stays readable.
function dust(cols = 96, rows = 44) {
  const rand = rng(42);
  const rects = [];
  for (let y = 0; y < rows; y++) {
    const t = y / rows;
    const band = t > 0.8 ? Math.pow((t - 0.8) / 0.2, 1.4) * 0.62 : 0;
    for (let x = 0; x < cols; x++) {
      const fromCenter = Math.abs(x - cols / 2) / (cols / 2);
      const side = fromCenter > 0.42 ? 0.05 + (fromCenter - 0.42) * 0.16 : 0.004;
      if (rand() < Math.max(band, side)) rects.push(`<rect class="${rand() < 0.35 ? "d2" : "d1"}" x="${x * 12}" y="${y * 12}" width="10" height="10"/>`);
    }
  }
  return `<svg class="dust" viewBox="0 0 ${cols * 12} ${rows * 12}" preserveAspectRatio="xMidYMax slice" shape-rendering="crispEdges" aria-hidden="true">${rects.join("")}</svg>`;
}

document.getElementById("logo-mark").innerHTML = wordmark("dd", { cell: 3, drips: false });

// 16x16 pixel GitHub mark: the octocat cut out of a filled circle.
const GITHUB_MARK = [
  ".....XXXXXX.....", "...XXXXXXXXXX...", "..XXXXXXXXXXXX..", ".XXX.XXXXXX.XXX.",
  ".XXX..XXXX..XXX.", "XXXX........XXXX", "XXX..........XXX", "XXX..........XXX",
  "XXX..........XXX", "XXXX........XXXX", "XXXXXX....XXXXXX", "...XXX....XXXXX.",
  ".XX.......XXXXX.", "..XXXX....XXXX..", "...XXX....XXX...", ".....X....X.....",
];
if (GITHUB_URL) {
  const gh = document.getElementById("gh-link");
  const px = GITHUB_MARK.flatMap((row, y) => [...row].map((c, x) => (c === "X" ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : "")));
  gh.innerHTML = `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${px.join("")}</svg>`;
  gh.href = GITHUB_URL;
  gh.hidden = false;
}

// ── theme: a light/dark toggle on top of the system setting ─────────────
// The button always offers the opposite of what is showing. Choosing the
// system's own mode goes back to auto (nothing stored), so only a deliberate
// deviation from the system is remembered.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
const themeBtn = document.getElementById("theme");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const systemTheme = () => (systemDark.matches ? "dark" : "light");
const shownTheme = () => document.documentElement.dataset.theme || systemTheme();

function applyTheme(t) {
  if (t && t !== systemTheme()) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const next = shownTheme() === "dark" ? "light" : "dark";
  themeBtn.querySelector(".label").textContent = next;
  themeBtn.title = `Switch to ${next} (T)`;
}
function toggleTheme() {
  const next = shownTheme() === "dark" ? "light" : "dark";
  store.set("theme", next === systemTheme() ? "" : next);
  applyTheme(next);
}
applyTheme(store.get("theme") || "");
systemDark.addEventListener("change", () => applyTheme(store.get("theme") || ""));
themeBtn.onclick = toggleTheme;
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey && !e.altKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) toggleTheme();
  if (SEARCH && e.key === "/" && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    (document.getElementById("hero-q") || q).focus();
  }
});

// ── mirror status: /v2/ answers 401 with a token challenge when healthy ───
function setStatus(ok) {
  const el = document.getElementById("status");
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.classList.add(ok ? "online" : "offline");
  document.getElementById("status-text").textContent = `mirror ${ok ? "online" : "unreachable"} · checked ${time}`;
}
if (MODE === "private") {
  if (VERSION) {
  const tag = document.getElementById("version");
  tag.textContent = `v${VERSION}`;
  if (GITHUB_URL) {
    tag.outerHTML = `<a href="${esc(GITHUB_URL)}/releases/tag/v${esc(VERSION)}" rel="noopener">v${esc(VERSION)}</a>`;
  }
}

fetch("/v2/", { cache: "no-store" })
    .then((r) => setStatus(r.status === 401 || r.ok))
    .catch(() => setStatus(false));
} else {
  // The public page has no registry; point at the source instead.
  document.getElementById("status").outerHTML = GITHUB_URL
    ? `<a class="status" href="${esc(GITHUB_URL)}" rel="noopener">self-host it · github →</a>`
    : `<span class="status">self-hostable · source coming soon</span>`;
}

// ── routing: #/  #/search/<query>  #/r/<namespace>/<name> ───────────────
function route() {
  const [, kind, a, b] = location.hash.split("/").map(decodeURIComponent);
  const home = !SEARCH || (!(kind === "r" && a && b) && !(kind === "search" && a));
  const guideOpen = kind === "setup";
  document.body.classList.toggle("home", home);
  if (!home) hero.innerHTML = "";
  if (kind === "r" && a && b) return showRepo(a, b);
  if (kind === "search" && a) { if (q.value !== a) q.value = a; return showSearch(a); }
  // A shared #/setup link opens the guide once; the URL is reset so a refresh starts collapsed.
  if (guideOpen) history.replaceState(null, "", "#/");
  showHome(guideOpen);
}
window.addEventListener("hashchange", route);
view.addEventListener("click", (e) => {
  if (e.target.closest(".back") && history.length > 1) { e.preventDefault(); history.back(); }
});

function onSearchInput(input) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const term = input.value.trim();
    // Leaving the home page removes the hero input; keep typing in the bar.
    if (input !== q && term) {
      document.body.classList.remove("home"); // the bar search is hidden (unfocusable) on home
      q.value = input.value;
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
    location.hash = term ? `#/search/${encodeURIComponent(term)}` : "#/";
  }, 300);
}
if (SEARCH) {
  q.addEventListener("input", () => onSearchInput(q));
} else {
  q.closest(".prompt-field").remove();
}

function showHome(guideOpen = false) {
  q.value = "";
  hero.innerHTML = `
    <section class="hero">
      ${dust()}
      <div class="wrap">
        ${wordmark("ddocker")}
        <h1>Dodge, Duck, Dip, Dive, and Dodge Firewalls<span class="cursor"></span></h1>
        <p>private pull-through mirror in case of corporate overlords and bitter keepers of the firewall.</p>
        ${SEARCH ? `<label class="prompt-field"><span>&gt;</span><input id="hero-q" type="search" placeholder="search images, e.g. postgres" autocomplete="off" spellcheck="false" aria-label="Search Docker Hub"></label>` : ""}
      </div>
    </section>`;
  const heroQ = document.getElementById("hero-q");
  if (heroQ) {
    heroQ.addEventListener("input", () => onSearchInput(heroQ));
    heroQ.focus({ preventScroll: true });
  }
  view.innerHTML = `
    <div class="steps">${SEARCH ? `
      <div><b><em>01</em>search</b><p>find any image on Docker Hub, even when hub.docker.com is blocked.</p></div>
      <div><b><em>02</em>pick a tag</b><p>filter the tag list, then copy the pull or compose line for it.</p></div>
      <div><b><em>03</em>pull</b><p>with this host in <code>registry-mirrors</code>, <code>docker pull</code> just works.</p></div>` : `
      <div><b><em>01</em>self-host</b><p>one small Worker on your own domain, on Cloudflare's free plan.</p></div>
      <div><b><em>02</em>hand out keys</b><p>everyone gets a secret hostname that doubles as their access key.</p></div>
      <div><b><em>03</em>pull</b><p>add it to <code>registry-mirrors</code> and <code>docker pull</code> just works.</p></div>`}
    </div>
    <article class="readme guide" id="guide" hidden></article>
    <button class="guide-toggle" id="guide-toggle" type="button" aria-expanded="false" aria-controls="guide"></button>`;
  document.getElementById("guide-toggle").onclick = () => setGuide(document.getElementById("guide").hidden);
  setGuide(guideOpen, false);
}

// Pixel chevrons: V points down (expand), ^ points up (collapse).
const CHEVRON = {
  down: ["10001", "01010", "00100"],
  up: ["00100", "01010", "10001"],
};
function chevron(dir) {
  const rects = CHEVRON[dir].flatMap((row, y) => [...row].map((bit, x) => (bit === "1" ? `<rect x="${x * 3}" y="${y * 3}" width="3" height="3"/>` : "")));
  return `<svg class="chevron" viewBox="0 0 15 9" width="20" height="12" shape-rendering="crispEdges" aria-hidden="true">${rects.join("")}</svg>`;
}

let guideLoaded = false;
function setGuide(open, scroll = true) {
  const guide = document.getElementById("guide");
  const toggle = document.getElementById("guide-toggle");
  guide.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.classList.toggle("open", open);
  // Collapsed: label then V. Expanded: ^ then label, sitting right above the footer.
  toggle.innerHTML = open ? `${chevron("up")}<span>${GUIDE_LABEL}</span>` : `<span>${GUIDE_LABEL}</span>${chevron("down")}`;
  if (open && !guideLoaded) {
    guideLoaded = true;
    guide.innerHTML = `<p class="muted loading">loading</p>`;
    fetch("/hub/api/guide")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((html) => { guide.innerHTML = html; addCopyButtons(guide); })
      .catch((err) => { guideLoaded = false; guide.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
  }
  if (open && scroll) guide.scrollIntoView({ block: "start" });
}

function addCopyButtons(root) {
  // Diagrams (```text blocks) aren't commands, so they get no copy button.
  root.querySelectorAll("pre:not(:has(code.language-text))").forEach((pre) => {
    const btn = Object.assign(document.createElement("button"), { className: "copy pre-copy", type: "button", textContent: "[copy]" });
    btn.onclick = async () => {
      await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent);
      btn.textContent = "[copied]"; btn.classList.add("done");
      setTimeout(() => { btn.textContent = "[copy]"; btn.classList.remove("done"); }, 1200);
    };
    pre.append(btn);
  });
}

async function showSearch(term, page = 1, list) {
  if (!list) view.innerHTML = `<div class="sec"><b>results</b><span class="loading">searching</span></div>`;
  try {
    const data = await api(`/hub/api/search?q=${encodeURIComponent(term)}&page=${page}`);
    if (q.value.trim() !== term) return;
    if (!list) {
      view.innerHTML = `<div class="sec"><b>results</b><span>${compact(data.count)} matches for "${esc(term)}"</span></div><ul class="results"></ul>`;
      list = view.querySelector(".results");
    }
    view.querySelector(".btn")?.remove();
    list.insertAdjacentHTML("beforeend", data.results.map((r) => {
      const [ns, name] = r.name.includes("/") ? r.name.split("/") : ["library", r.name];
      return `<li><a href="#/r/${esc(ns)}/${esc(name)}">
        <span class="name">${esc(r.name)}${r.official ? '<span class="official">[official]</span>' : ""}</span>
        <span class="stats">↓ ${compact(r.pulls)} &nbsp;★ ${compact(r.stars)}</span>
        ${r.description ? `<span class="desc">${esc(r.description)}</span>` : ""}</a></li>`;
    }).join(""));
    if (data.hasNext) {
      const more = Object.assign(document.createElement("button"), { className: "btn", textContent: "[ more results ↓ ]" });
      more.onclick = () => showSearch(term, page + 1, list);
      view.append(more);
    }
  } catch (err) {
    view.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function showRepo(ns, name) {
  const display = ns === "library" ? name : `${ns}/${name}`;
  view.innerHTML = `<a class="back" href="#/">← cd ..</a><h1 class="repo-title">${esc(display)}</h1><p class="muted loading">loading</p>`;
  let repo;
  try { repo = await api(`/hub/api/repo/${ns}/${name}`); }
  catch (err) { view.querySelector(".loading").outerHTML = `<p class="error">${esc(err.message)}</p>`; return; }

  const facts = [];
  if (repo.pulls != null) facts.push(`<span>↓ <b>${compact(repo.pulls)}</b> pulls</span>`);
  if (repo.stars != null) facts.push(`<span>★ <b>${compact(repo.stars)}</b> stars</span>`);

  view.innerHTML = `
    <a class="back" href="#/">← cd ..</a>
    <h1 class="repo-title">${esc(display)}${repo.official ? '<span class="official">[official]</span>' : ""}</h1>
    ${repo.description ? `<p class="lede">${esc(repo.description)}</p>` : ""}
    ${facts.length ? `<div class="facts">${facts.join("")}</div>` : ""}
    <div class="term">
      <div class="term-bar"><span class="dots">■■■</span><span>~/pull · via mirror</span></div>
      <div class="term-line"><span class="p">$</span><code id="cmd-pull"></code><button class="copy" data-copy="cmd-pull">[copy]</button></div>
      <div class="term-line"><span class="p">#</span><code id="cmd-compose"></code><button class="copy" data-copy="cmd-compose">[copy]</button></div>
    </div>
    <div class="sec"><b>tags</b><span id="tag-count"></span></div>
    <label class="prompt-field grep"><span>grep</span><input type="search" id="tag-q" placeholder="filter tags, e.g. 16-alpine" autocomplete="off" spellcheck="false" aria-label="Filter tags"></label>
    <table class="tags"><thead><tr><th>tag</th><th class="col-cmd">pull command</th></tr></thead><tbody></tbody></table>
    <div id="tag-more"></div>`;

  const setTag = (tag) => {
    document.getElementById("cmd-pull").textContent = `docker pull ${display}:${tag}`;
    document.getElementById("cmd-compose").textContent = `image: docker.io/${ns}/${name}:${tag}`;
  };
  setTag("latest");
  view.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);
    b.textContent = "[copied]"; b.classList.add("done");
    setTimeout(() => { b.textContent = "[copy]"; b.classList.remove("done"); }, 1200);
  });

  const tbody = view.querySelector(".tags tbody");
  tbody.onclick = (e) => {
    const row = e.target.closest("tr[data-tag]");
    if (!row) return;
    tbody.querySelector(".selected")?.classList.remove("selected");
    row.classList.add("selected");
    setTag(row.dataset.tag);
  };

  let filterTimer;
  const tagQ = document.getElementById("tag-q");
  tagQ.oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => loadTags(ns, name, tagQ.value.trim(), ""), 300); };
  loadTags(ns, name, "", "");
}

// The registry pages through tags with a cursor and gives names only, so
// "more" keeps scanning from the last tag seen.
let tagsShown = 0;

async function loadTags(ns, name, filter, last) {
  const tbody = view.querySelector(".tags tbody");
  const moreBox = document.getElementById("tag-more");
  if (!tbody) return;
  if (!last) { tbody.innerHTML = `<tr><td colspan="2" class="muted loading">loading tags</td></tr>`; tagsShown = 0; }
  try {
    const data = await api(`/hub/api/tags/${ns}/${name}?q=${encodeURIComponent(filter)}&last=${encodeURIComponent(last)}`);
    if ((document.getElementById("tag-q")?.value.trim() ?? "") !== filter) return;
    if (!last) tbody.innerHTML = "";
    tagsShown += data.tags.length;
    document.getElementById("tag-count").textContent = filter
      ? `${tagsShown} matching`
      : `${tagsShown}${data.next ? "+" : ""}`;
    if (!tagsShown) tbody.innerHTML = `<tr><td colspan="2" class="muted">no matching tags in the first ${data.scanned} tags</td></tr>`;
    const display = ns === "library" ? name : `${ns}/${name}`;
    tbody.insertAdjacentHTML("beforeend", data.tags.map((t) => `
      <tr data-tag="${esc(t.name)}"><td class="tagname">${esc(t.name)}</td>
      <td class="col-cmd mono muted">docker pull ${esc(display)}:${esc(t.name)}</td></tr>`).join(""));
    moreBox.innerHTML = "";
    if (data.next) {
      const more = Object.assign(document.createElement("button"), { className: "btn", textContent: "[ more tags ↓ ]" });
      more.onclick = () => loadTags(ns, name, filter, data.next);
      moreBox.append(more);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="2" class="error">${esc(err.message)}</td></tr>`;
  }
}

route();

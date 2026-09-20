// The page: a small Docker Hub browser (search and tags) for networks where
// hub.docker.com is blocked, plus a guide section that depends on the mode:
// client setup on a key hostname, about + self-hosting on the public page.
//
// Data comes from two upstreams that answer from Cloudflare's IP addresses:
// index.docker.io for search, and the registry itself for tag names. The
// hub.docker.com API is rate-limited per IP, and Cloudflare's shared addresses
// are permanently over that limit, so it is not used at all.

import { marked } from "marked";
import HUB_PAGE from "./hub.html";
import HUB_SCRIPT from "./hub.client.js";
import SETUP_GUIDE from "../docs/setup-guide.md";
import ABOUT_GUIDE from "../docs/about.md";
import MONO_FONT from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2";

const SEARCH_API = "https://index.docker.io/v1/search";
const REGISTRY = "https://registry-1.docker.io";
const REGISTRY_AUTH = "https://auth.docker.io/token";
const CACHE_SECONDS = 300;
const TAGS_PER_PAGE = 100;
const MAX_FILTER_PAGES = 12; // ~1200 tags scanned per filter request
const GITHUB_PLACEHOLDER = "https://github.com/your-name/ddocker";
const REPO_PATH = /^\/hub\/api\/(repo|tags)\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;

// The access key is in the hostname, so never let it leak via Referer.
const BASE_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

// Scripts only from /hub/app.js, so nothing injected into the page can run.
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export async function handleHub(url, env, mode) {
  // The Hub browser belongs to the mirrors. PUBLIC_SEARCH=1 opts the public
  // page in.
  const search = mode === "private" || env.PUBLIC_SEARCH === "1";

  if (url.pathname === "/") {
    const github = escapeAttr(env.GITHUB_URL || "");
    const page = HUB_PAGE.replace("<body>", `<body data-mode="${mode}" data-search="${search ? "on" : "off"}" data-github="${github}">`);
    const headers = { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP };
    if (mode === "public") delete headers["x-robots-tag"]; // the front page may be indexed
    return new Response(page, { headers });
  }

  if (url.pathname === "/hub/app.js") {
    return new Response(HUB_SCRIPT, {
      headers: { ...BASE_HEADERS, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  // Self-hosted so the page looks right on networks that block font CDNs too.
  if (url.pathname === "/hub/mono.woff2") {
    return new Response(MONO_FONT, {
      headers: { ...BASE_HEADERS, "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
    });
  }

  // Our own documents, so no sanitizing. Private: client setup with this
  // mirror's hostname filled in. Public: about + self-hosting.
  if (url.pathname === "/hub/api/guide") {
    const markdown = (mode === "private"
      ? SETUP_GUIDE.replaceAll("your-key.example.com", url.host)
      : ABOUT_GUIDE.replaceAll(GITHUB_PLACEHOLDER, env.GITHUB_URL || GITHUB_PLACEHOLDER)
    ).replace(/^<!--[\s\S]*?-->\s*/, "");
    return new Response(marked.parse(markdown), {
      headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!search && url.pathname.startsWith("/hub/api/")) {
    return json({ error: "the Docker Hub browser runs on mirror hostnames" }, 404);
  }

  if (url.pathname === "/hub/api/search") {
    const query = (url.searchParams.get("q") || "").trim().slice(0, 100);
    if (!query) return json({ count: 0, hasNext: false, results: [] });
    const page = pageParam(url);
    const data = await getJson(`${SEARCH_API}?q=${encodeURIComponent(query)}&n=25&page=${page}`);
    if (data.error) return json(data, data.status);
    return json({
      count: data.num_results,
      hasNext: page < data.num_pages,
      results: (data.results || []).map((r) => ({
        name: r.name,
        description: r.description,
        stars: r.star_count,
        pulls: r.pull_count,
        official: r.is_official,
      })),
    });
  }

  const m = url.pathname.match(REPO_PATH);
  if (!m) return json({ error: "not found" }, 404);
  const [, kind, namespace, name] = m;
  const repo = `${namespace}/${name}`;

  // The registry has no repository metadata, so the summary comes from a
  // search for the image's own name.
  if (kind === "repo") {
    const wanted = namespace === "library" ? name : repo;
    const data = await getJson(`${SEARCH_API}?q=${encodeURIComponent(name)}&n=25`);
    const hit = data.error ? null : (data.results || []).find((r) => r.name === wanted);
    return json({
      namespace,
      name,
      description: hit?.description || "",
      stars: hit?.star_count ?? null,
      pulls: hit?.pull_count ?? null,
      official: namespace === "library",
    });
  }

  const filter = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const last = (url.searchParams.get("last") || "").slice(0, 200);
  const token = await registryToken(repo, env);
  if (!token) return json({ error: "could not authenticate with the registry" }, 502);

  // The registry lists tags alphabetically with a cursor, and can't filter, so
  // a filter means paging through until enough matches turn up.
  const headers = { accept: "application/json", authorization: `Bearer ${token}` };
  const matches = [];
  let cursor = last;
  let scanned = 0;
  let more = true;

  for (let page = 0; page < (filter ? MAX_FILTER_PAGES : 1); page++) {
    const target = `${REGISTRY}/v2/${repo}/tags/list?n=${TAGS_PER_PAGE}${cursor ? `&last=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetchSafely(target, { headers });
    if (res.error) return json(res, res.status);
    if (res.status === 404) return json({ error: "Not found in the registry" }, 404);
    if (!res.ok) return json({ error: `Registry returned ${res.status}` }, 502);

    const tags = (await res.json()).tags || [];
    scanned += tags.length;
    matches.push(...(filter ? tags.filter((t) => t.includes(filter)) : tags));
    more = Boolean(res.headers.get("link")) && tags.length > 0;
    if (tags.length) cursor = tags[tags.length - 1];
    if (!more || matches.length >= TAGS_PER_PAGE) break;
  }

  return json({
    tags: matches.map((name) => ({ name })),
    scanned,
    next: more ? cursor : "",
  });
}

// Pull tokens, with the mirror's Docker Hub credentials when they are set.
const registryTokens = new Map(); // repo -> { token, expires }

async function registryToken(repo, env) {
  const cached = registryTokens.get(repo);
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;

  const headers = { accept: "application/json" };
  if (env.HUB_USERNAME && env.HUB_TOKEN) {
    headers.authorization = "Basic " + btoa(`${env.HUB_USERNAME}:${env.HUB_TOKEN}`);
  }
  const res = await fetchSafely(`${REGISTRY_AUTH}?service=registry.docker.io&scope=repository:${repo}:pull`, { headers });
  if (res.error || !res.ok) return null;
  const { token, expires_in } = await res.json();
  if (!token) return null;
  registryTokens.set(repo, { token, expires: Date.now() + (expires_in || 300) * 1000 });
  return token;
}

async function fetchSafely(target, init = {}) {
  try {
    return await fetch(target, { ...init, cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
  } catch (err) {
    return { error: `upstream unreachable: ${err.message}`, status: 502, ok: false };
  }
}

async function getJson(target) {
  const res = await fetchSafely(target, { headers: { accept: "application/json", "user-agent": "ddocker" } });
  if (res.error) return res;
  if (res.status === 404) return { error: "Not found on Docker Hub", status: 404 };
  if (res.status === 429) return { error: "Docker Hub is rate-limiting this right now", status: 503 };
  if (!res.ok) return { error: `Docker Hub returned ${res.status}`, status: 502 };
  return res.json();
}

function pageParam(url) {
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  return Number.isFinite(page) && page > 0 && page <= 100 ? page : 1;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

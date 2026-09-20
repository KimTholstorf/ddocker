// The page: a small Docker Hub browser (search, tags, README) for networks
// where hub.docker.com is blocked, plus a guide section that depends on the
// mode: client setup on a key hostname, about + self-hosting on the public page.
//
// Only the handful of read-only Hub API endpoints below are reachable through
// it; this is not a general proxy for hub.docker.com.

import { marked } from "marked";
import HUB_PAGE from "./hub.html";
import HUB_SCRIPT from "./hub.client.js";
import SETUP_GUIDE from "../docs/setup-guide.md";
import ABOUT_GUIDE from "../docs/about.md";
import MONO_FONT from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2";

const DEFAULT_HUB_API = "https://hub.docker.com";
const CACHE_SECONDS = 300;
const REPO_PATH = /^\/hub\/api\/(repo|tags|readme)\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;

const GITHUB_PLACEHOLDER = "https://github.com/your-name/ddocker";

// The access key is in the hostname, so never let it leak via Referer.
const BASE_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

// Scripts only from /hub/app.js: even if README sanitizing missed something,
// injected inline handlers can't run. README images may come from anywhere.
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// README HTML is written by arbitrary image publishers. Keep only plain
// document markup, and only http(s) links and https images.
const README_TAGS = new Set(
  ("a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img kbd li ol p pre " +
   "s samp small span strong sub summary sup table tbody td tfoot th thead tr u ul").split(" "),
);
const README_ATTRS = { a: ["href"], img: ["src", "alt", "width", "height"], td: ["colspan", "rowspan", "align"], th: ["colspan", "rowspan", "align"] };
const README_DROP = new Set("script style iframe frame frameset object embed form input button textarea select option noscript template svg math link meta base title head audio video source canvas".split(" "));

export async function handleHub(url, env, mode) {
  const api = env.HUB_WEB_API || DEFAULT_HUB_API;
  // The Hub browser belongs to the mirrors. PUBLIC_SEARCH=1 opts the public
  // page in, at the cost of anonymous rate limits.
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
    const html = marked.parse(markdown);
    return new Response(html, {
      headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!search && url.pathname.startsWith("/hub/api/") && url.pathname !== "/hub/api/guide") {
    return json({ error: "the Docker Hub browser runs on mirror hostnames" }, 404);
  }

  if (url.pathname === "/hub/api/search") {
    const query = (url.searchParams.get("q") || "").trim().slice(0, 100);
    if (!query) return json({ count: 0, hasNext: false, results: [] });
    const page = pageParam(url);
    const data = await hubGet(api, `/v2/search/repositories/?query=${encodeURIComponent(query)}&page=${page}&page_size=25`, env, mode === "private");
    if (data.error) return json(data, data.status);
    return json({
      count: data.count,
      hasNext: Boolean(data.next),
      results: data.results.map((r) => ({
        name: r.repo_name,
        description: r.short_description,
        stars: r.star_count,
        pulls: r.pull_count,
        official: r.is_official,
      })),
    });
  }

  const m = url.pathname.match(REPO_PATH);
  if (!m) return json({ error: "not found" }, 404);
  const [, kind, namespace, name] = m;
  const repoPath = `/v2/repositories/${namespace}/${name}`;

  if (kind === "tags") {
    const filter = (url.searchParams.get("q") || "").trim().slice(0, 100);
    const data = await hubGet(
      api,
      `${repoPath}/tags?page_size=50&page=${pageParam(url)}&ordering=last_updated&name=${encodeURIComponent(filter)}`,
      env,
      mode === "private",
    );
    if (data.error) return json(data, data.status);
    return json({
      count: data.count,
      hasNext: Boolean(data.next),
      tags: data.results.map((t) => ({
        name: t.name,
        updated: t.last_updated,
        platforms: (t.images || [])
          .filter((i) => i.os && i.os !== "unknown") // attestation manifests
          .map((i) => ({ os: i.os, arch: i.architecture, variant: i.variant, size: i.size })),
      })),
    });
  }

  const repo = await hubGet(api, `${repoPath}/`, env, mode === "private");
  if (repo.error) return json(repo, repo.status);

  if (kind === "repo") {
    return json({
      namespace: repo.namespace,
      name: repo.name,
      description: repo.description,
      stars: repo.star_count,
      pulls: repo.pull_count,
      updated: repo.last_updated,
      hasReadme: Boolean(repo.full_description),
    });
  }

  const html = repo.full_description ? await sanitize(marked.parse(repo.full_description)) : "";
  return new Response(html, {
    headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

// Docker Hub rate-limits its API per IP for anonymous callers, and Cloudflare's
// addresses are shared, so those limits are usually already spent. Exchanging
// the Docker Hub token for an API token lifts the calls out of that pool. Only
// mirror hostnames do this: searches from the public page would otherwise count
// against the owner's Docker Hub account.
let apiToken = null; // { token, expires }

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp) return payload.exp * 1000;
  } catch {}
  return Date.now() + 20 * 60 * 1000;
}

async function hubAuth(api, env, force = false) {
  if (!env.HUB_USERNAME || !env.HUB_TOKEN) return null;
  if (!force && apiToken && apiToken.expires > Date.now() + 60_000) return apiToken.token;
  try {
    const res = await fetch(api + "/v2/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ identifier: env.HUB_USERNAME, secret: env.HUB_TOKEN }),
    });
    if (!res.ok) return null;
    const { token } = await res.json();
    if (!token) return null;
    apiToken = { token, expires: jwtExpiry(token) };
    return token;
  } catch {
    return null;
  }
}

async function hubGet(api, path, env, authed) {
  const fetchOnce = async (token) => {
    const headers = { accept: "application/json", "user-agent": "ddocker-hub" };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(api + path, { headers, cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
  };

  let res;
  try {
    res = await fetchOnce(authed ? await hubAuth(api, env) : null);
    // An expired token: get a fresh one and retry once.
    if (authed && (res.status === 401 || res.status === 429)) {
      const token = await hubAuth(api, env, true);
      if (token) res = await fetchOnce(token);
    }
  } catch (err) {
    return { error: `Docker Hub unreachable: ${err.message}`, status: 502 };
  }
  if (res.status === 404) return { error: "Not found on Docker Hub", status: 404 };
  if (res.status === 429) return { error: "Docker Hub is rate-limiting search right now", status: 503 };
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

async function sanitize(html) {
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName;
        if (README_DROP.has(tag)) return el.remove();
        if (!README_TAGS.has(tag)) return el.removeAndKeepContent();
        const allowed = README_ATTRS[tag] || [];
        for (const [name] of [...el.attributes]) {
          if (!allowed.includes(name)) el.removeAttribute(name);
        }
        if (tag === "a") {
          const href = el.getAttribute("href") || "";
          if (!/^(https?:|mailto:|#)/i.test(href.trim())) el.removeAttribute("href");
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
        if (tag === "img" && !/^https:/i.test((el.getAttribute("src") || "").trim())) el.remove();
      },
    })
    .onDocument({
      comments(c) {
        c.remove();
      },
    });
  return rewriter.transform(new Response(html)).text();
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

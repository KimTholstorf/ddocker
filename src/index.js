// ddocker: a private, read-only Docker Hub pull-through mirror on Cloudflare Workers.
//
// Each user gets a secret hostname, e.g. alice-7h3k9q2m.example.com, and points
// their container runtime's docker.io mirror at it. The hostname is the access
// key, so it works identically for Docker Desktop, OrbStack, Colima, Podman and
// plain dockerd, none of which reliably send credentials to a mirror.
//
// The same Worker serves the public front page on the bare domain. The page is
// identical in both modes; only the guide section and the registry differ:
//   example.com          public:  about + self-hosting guide, no registry
//   <key>.example.com    private: client setup guide, registry mirror
//   anything else        redirect to the public page
// The domain comes from the BASE_DOMAIN variable.

import { handleHub } from "./hub.js";

const UPSTREAM_REGISTRY = "https://registry-1.docker.io";
const UPSTREAM_AUTH = "https://auth.docker.io/token";
const UPSTREAM_SERVICE = "registry.docker.io";

// Headers a registry client sends that upstream needs to see.
const FORWARD_REQUEST_HEADERS = ["accept", "authorization", "range", "if-none-match", "user-agent"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.BASE_DOMAIN) {
      return new Response("ddocker: BASE_DOMAIN is not set. See wrangler.toml.", { status: 500 });
    }
    const mode = siteMode(url.hostname, env);

    if (!mode) {
      const port = url.port ? `:${url.port}` : "";
      return Response.redirect(`${url.protocol}//${baseDomain(env)}${port}/`, 302);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return registryError(405, "UNSUPPORTED", "this mirror is read-only");
    }

    const isRegistry = url.pathname === "/token" || url.pathname === "/v2" || url.pathname.startsWith("/v2/");
    if (isRegistry && mode === "public") {
      return registryError(404, "NAME_UNKNOWN", "this is the public page; pull through your own mirror hostname");
    }
    if (url.pathname === "/token") return handleToken(url, env);
    if (isRegistry) return handleRegistry(request, url);

    if (url.pathname === "/hub" || url.pathname === "/hub/") return Response.redirect(`${url.origin}/`, 301);
    const isIcon = url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico" || url.pathname === "/icon-180.png";
    if (url.pathname === "/" || url.pathname.startsWith("/hub/") || isIcon) return handleHub(url, env, mode);
    return new Response("not found", { status: 404 });
  },
};

function baseDomain(env) {
  return env.BASE_DOMAIN.toLowerCase();
}

// "public" for the bare domain, "private" for a valid key subdomain, else null.
function siteMode(hostname, env) {
  const base = baseDomain(env);
  const host = hostname.toLowerCase();
  if (host === base) return "public";
  if (!host.endsWith("." + base)) return null;
  const key = host.slice(0, -(base.length + 1));
  if (key.includes(".")) return null;
  const keys = (env.ACCESS_KEYS || "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  return keys.includes(key) ? "private" : null;
}

// Official images live under library/ upstream; clients using the mirror
// explicitly (e.g. key.example.com/nginx) may leave it out.
function normalizeRepo(name) {
  return name.includes("/") ? name : `library/${name}`;
}

async function handleRegistry(request, url) {
  let path = url.pathname;
  const m = path.match(/^\/v2\/(.+)\/(manifests|blobs|tags)\/(.+)$/);
  if (m) path = `/v2/${normalizeRepo(m[1])}/${m[2]}/${m[3]}`;

  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }

  const upstream = await fetch(UPSTREAM_REGISTRY + path + url.search, {
    method: request.method,
    headers,
    redirect: "manual",
  });

  // Blobs redirect to Docker's CDN, which is usually blocked too. Fetch it
  // here instead. The redirect URL is pre-signed, so no Authorization header.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has("location")) {
    const location = new URL(upstream.headers.get("location"), UPSTREAM_REGISTRY);
    const cdnHeaders = new Headers();
    const range = request.headers.get("range");
    if (range) cdnHeaders.set("range", range);
    try {
      const blob = await fetch(location, { method: request.method, headers: cdnHeaders });
      return new Response(blob.body, { status: blob.status, headers: blob.headers });
    } catch (err) {
      return registryError(502, "BLOB_UNKNOWN", `blob CDN fetch failed: ${err.message}`);
    }
  }

  const responseHeaders = new Headers(upstream.headers);
  if (upstream.status === 401) {
    const challenge = responseHeaders.get("www-authenticate");
    if (challenge) {
      responseHeaders.set(
        "www-authenticate",
        challenge.replace(/realm="[^"]*"/i, `realm="${url.origin}/token"`),
      );
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function handleToken(url, env) {
  const upstreamUrl = new URL(UPSTREAM_AUTH);
  upstreamUrl.searchParams.set("service", UPSTREAM_SERVICE);

  // repository:nginx:pull,push -> repository:library/nginx:pull
  for (const scope of url.searchParams.getAll("scope")) {
    const parts = scope.split(":");
    if (parts[0] === "repository" && parts.length === 3) {
      upstreamUrl.searchParams.append("scope", `repository:${normalizeRepo(parts[1])}:pull`);
    }
  }

  const headers = new Headers();
  if (env.HUB_USERNAME && env.HUB_TOKEN) {
    headers.set("authorization", "Basic " + btoa(`${env.HUB_USERNAME}:${env.HUB_TOKEN}`));
  }

  const upstream = await fetch(upstreamUrl, { headers });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function registryError(status, code, message) {
  return new Response(JSON.stringify({ errors: [{ code, message }] }), {
    status,
    headers: { "content-type": "application/json", "docker-distribution-api-version": "registry/2.0" },
  });
}

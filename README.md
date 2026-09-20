# ddocker

A private, read-only Docker Hub mirror on a Cloudflare Worker, for the networks that block
`hub.docker.com` and Docker's layer CDN: hotels, guest Wi-Fi, corporate gateways that open up
your TLS traffic and look inside.

Set it once as your docker.io registry mirror and leave it on. Docker uses it when it can be
reached and falls back to docker.io when it can't. Compose files, Dockerfiles and `docker pull`
commands all stay as they are.

The same Worker serves a public front page on your bare domain, and a Docker Hub browser on
every mirror hostname for searching images, comparing tags and reading READMEs.

## How it works

```text
docker pull nginx
  └─> https://<key>.example.com/v2/library/nginx/...   the only host the network sees
        Worker ─> registry-1.docker.io                 manifests
               ─> auth.docker.io                       tokens (auth realm rewritten to <key>.example.com/token)
               ─> production.cloud*.docker.com         layers (redirect followed by the Worker, not the client)
```

The hostname is the access control. Each person gets their own `<name>-<random>.example.com`,
listed in the `ACCESS_KEYS` secret, and removing a key from that list revokes it. Unknown
subdomains land on the public page instead.

Nothing can be written through the mirror: push and other non-GET requests get a 405 back, and
token scopes are cut down to `pull`.

Rate limits depend on whether you set `HUB_USERNAME` and `HUB_TOKEN`. With them, pulls count
against your Docker Hub account. Without them, they are anonymous and come from Cloudflare's
shared IP addresses, which run into limits much sooner.

## What the hostname decides

| | `example.com` (public) | `<key>.example.com` (private) |
|---|---|---|
| Page | same hero, search, tags, READMEs | same |
| Guide section | about & self-hosting, from [docs/about.md](docs/about.md) | client setup, from [docs/setup-guide.md](docs/setup-guide.md), with the reader's hostname filled in |
| Registry (`/v2`, `/token`) | refused | the mirror |
| Footer | link to `GITHUB_URL` | mirror status |
| Search engines | may index it | `noindex` |

Anything else, `www` or a wrong key, redirects to the public page.

## Self-hosting

You need a domain on Cloudflare and a Cloudflare account with Workers. The free plan is enough
for both.

1. DNS: add two proxied (orange cloud) records to your zone, `@` → `AAAA 100::` for the public
   page and `*` → `AAAA 100::` for the mirrors. Cloudflare's free certificate covers both.
   Leave Bot Fight Mode off, because its challenge stops `docker pull` dead.
2. Generate a key per person:
   ```bash
   ./new-key.sh alice
   ```
3. Store the secrets:
   ```bash
   npx wrangler secret put ACCESS_KEYS     # comma-separated keys
   npx wrangler secret put HUB_USERNAME    # optional, recommended
   npx wrangler secret put HUB_TOKEN       # Docker Hub token with "Public Repo Read-only" scope
   ```
   Skip the token and pulls are anonymous, counted against Cloudflare's shared IP addresses,
   which allow 100 pulls per 6 hours between you and whoever else is using them. With it, they
   count against your Docker Hub account, which allows 200 per 6 hours.
4. Deploy, passing your domain in so this repository stays untouched:
   ```bash
   npm ci
   npx wrangler deploy \
     --route "example.com/*" --route "*.example.com/*" \
     --var BASE_DOMAIN:example.com \
     --var GITHUB_URL:https://github.com/you/ddocker
   ```
5. Check it:
   ```bash
   ./ddocker-doctor.sh alice-3f9a1c7b2e4d6a8b0c1e3f5a7b9d2c4e.example.com
   ```
   The mirror line should say `ok (HTTP 401)`. That 401 is the registry's normal challenge, not
   an error.
6. Hand out the hostnames. Each person opens `https://<their-key>.example.com/` and finds the
   steps for their runtime under client setup.

### Keeping your deployment separate

To keep your domain and secrets out of this repository, deploy from a small private repository
that pulls this one in as a git submodule, pinned to a release tag:

```text
your-deployment/
├── ddocker/            submodule → this repository, at a release tag
└── deploy.sh           runs wrangler with --config ddocker/wrangler.toml, your --route and --var flags
```

Upgrading is then a matter of checking out a newer tag in the submodule and deploying again.
Secrets can come straight from a password manager at deploy time, for example 1Password's
`op run` and `op inject` feeding `wrangler deploy` and `wrangler secret bulk`.

## Helper scripts

[`ddocker-doctor.sh`](ddocker-doctor.sh) tells you in seconds whether this network blocks
Docker Hub, whether your mirror answers, and whether Docker or Podman is actually configured to
use it.

[`new-key.sh`](new-key.sh) prints an access key for one person, which is a name plus 128 random
bits. Add it to `ACCESS_KEYS` and deploy. Pass `--key-only` to get just the key, for scripts
that feed it somewhere else:

```bash
KEY=$(./new-key.sh alice --key-only)
```

[`podman-mirror.sh`](podman-mirror.sh) writes the mirror config into the Podman machine on
macOS and restarts it. Run it again after `podman machine init`, which wipes the setting.

## Docker Hub browser

Every mirror hostname, and the public page, carries a small Docker Hub browser for the times
hub.docker.com is blocked. You can search images, see tags with their update dates, platforms
and the size for your architecture, click a tag to copy a `docker pull` command or a compose
`image:` line, and read the image's README.

The Worker only calls Docker Hub's read-only search, repository and tag endpoints, so it isn't
a general proxy for hub.docker.com. READMEs are written by image publishers, so the Worker
strips them down to plain document markup before they reach the page. The page's security
policy also blocks inline scripts, and `Referrer-Policy: no-referrer` keeps key hostnames out
of the `Referer` header when you follow a link.

The browser on the public page draws on the same daily Worker request allowance as the mirror.
If it ever gets heavy traffic, add a Cloudflare rate-limiting rule for `example.com/hub/api/*`.
The free plan includes one.

## Cost

Cloudflare's free Workers plan includes 100,000 requests a day and charges nothing for
bandwidth. A typical image pull takes 10 to 20 requests, one per layer plus a few fixed ones,
so a handful of people stay far below the limit. A free plan can't be billed either: if you do
hit the ceiling, requests fail until it resets at 00:00 UTC.

## Security model

The hostname is a shared secret, which is enough for a read-only mirror of public images.

Nobody can discover it from outside. There is one wildcard DNS record and one wildcard
certificate, so no key shows up in DNS or in certificate-transparency logs. Don't add keys as
Workers custom domains, because that issues a certificate per key and publishes the name. Keys
use 128 random bits, so guessing is out of the question.

The networks you use it on are another matter. The hostname travels unencrypted in DNS lookups
and in the TLS SNI field, so hotel proxies and DNS resolvers can log it. Keys also sit in plain
text in runtime config, so keep them out of public dotfiles.

If a key does leak, someone can pull public images using your Docker Hub quota and your Worker
requests. That's the extent of it. Per-person keys show up separately in Cloudflare analytics,
so you can revoke just the leaked one: remove it from `ACCESS_KEYS` and update the secret.

## Limits

Docker Hub only. `ghcr.io`, `quay.io` and similar aren't mirrored.

Public images only. Private repos would need per-user Docker Hub credentials.

Only pulls and the Docker Hub browser go through the Worker. `docker login`, `docker push` and
signing in to hub.docker.com still need a network that allows Docker.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler dev --port 8799 --local-upstream test-key123.localhost:8799
test/e2e.sh http://test-key123.localhost:8799 alpine latest
```

Open `http://test-key123.localhost:8799/` in Chrome or Firefox. Safari won't resolve
`*.localhost`. For the public page, run a second dev server with its own state folder:

```bash
npx wrangler dev --port 8798 --local-upstream localhost:8798 --inspector-port 9231 --persist-to .wrangler/state-public
```

Then open `http://localhost:8798/`. `--local-upstream` makes the dev server treat every request
as that hostname, which is why each mode needs its own server and why a wrong key can't be
tested locally. Layer downloads only work if your own network can reach Docker's CDN.

## License

MIT. See [LICENSE](LICENSE).

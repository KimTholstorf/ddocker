<!--
Public guide, shown on the bare domain under "about & self-hosting".
The Worker replaces "https://github.com/your-name/ddocker" with GITHUB_URL
from wrangler.toml when that is set.
-->

# About ddocker

Corporate Overlords and bitter Keepers of the Firewall often block `hub.docker.com` and the CDN
Docker uses for image layers. `docker compose up` then dies halfway through, usually with a
certificate error that tells you nothing about why.

ddocker is a small Cloudflare Worker you run on your own domain. It works as a private,
read-only Docker Hub mirror. The network only ever sees traffic to your domain on Cloudflare,
so pulls go through in places where Docker Hub doesn't.

## How it works

```text
docker pull postgres
  └─> https://<key>.your-domain.com/v2/...    the only host the network sees
        Worker ─> registry-1.docker.io        manifests
               ─> auth.docker.io              pull tokens
               ─> Docker's layer CDN          image layers, fetched by the Worker
```

Add your mirror hostname to Docker's `registry-mirrors` setting once and leave it there. Your
compose files and image names stay exactly as they are. If the mirror is ever unreachable,
Docker quietly goes back to docker.io.

## What you get

A pull-through mirror that works with Docker Desktop, OrbStack, Colima, Podman and Docker
Engine on Linux.

Every mirror hostname also serves this page, so you can search Docker Hub, compare tags and
read an image's README from a network that blocks hub.docker.com. Open the client setup
section there and the commands already have that person's hostname in them.

There's also a script that tells you in a few seconds whether the network you're sitting on
blocks Docker.

## Access

Each person gets their own secret hostname, something like `alice-3f9a1c7b….your-domain.com`.
The hostname is the access key, which is why it works the same in every container runtime and
nobody has to log in anywhere. Delete a key and that person's access is gone. Nothing can be
pushed through the mirror, and it only serves public images.

This page, on the bare domain, is the front door. No images are served here.

## Self-hosting

You need a domain on Cloudflare and a Cloudflare account with Workers. The free plan covers
both. A token from a free Docker Hub account is optional, and it raises how many pulls you
get (see below).

Setting it up takes about 15 minutes:

1. Clone the repository and install its dependencies.
2. Add two proxied DNS records to your domain: `@` and `*`.
3. Generate an access key for each person and store the keys as a Worker secret.
4. Deploy with `wrangler deploy`.
5. Send each person their hostname. Their setup steps are waiting on their own mirror page.

Full instructions and the source are on GitHub:
[https://github.com/your-name/ddocker](https://github.com/your-name/ddocker)

## Pull limits

Docker Hub counts pulls per account, or per IP address when nobody is signed in. Cloudflare's
addresses are shared with other Workers, so anonymous pulls through your mirror are competing
with strangers over the same 100 pulls per 6 hours.

Give the Worker a token from a free Docker Hub account and the pulls count against that
account instead. That allows 200 per 6 hours, shared by everyone you hand a key to. A
read-only token is enough, and the people using your mirror never see it or log in themselves.
Worth knowing: a multi-architecture image counts as one pull per architecture.

## Cost

For you and a few colleagues, this runs on Cloudflare's free Workers plan, which includes
100,000 requests a day and charges nothing for bandwidth. A typical image pull costs 10 to 20
of those requests. The domain is the only thing you pay for.

## Limits

Docker Hub only. Images from `ghcr.io`, `quay.io` and other registries go direct as usual.

Public images only, and only pulls. You still need an open network for `docker login` and
`docker push`.

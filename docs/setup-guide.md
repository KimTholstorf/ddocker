<!--
Client setup guide, shown on the /hub page under "client setup".
The Worker replaces every "your-key.example.com" with the hostname the page
is opened on, so readers get commands with their own mirror in them.
-->

# Client setup

Set your mirror as Docker Hub's registry mirror once and leave it on. Your compose files and
image names stay as they are. If the mirror is unreachable, Docker and Podman go back to
docker.io by themselves.

Your mirror: `https://your-key.example.com`

## Docker Desktop (macOS, Windows)

Open Settings, then Docker Engine, add this line to the JSON and click Apply & restart:

```json
"registry-mirrors": ["https://your-key.example.com"]
```

## OrbStack

Open Settings, then Docker, and add the same line to the engine config. You can also edit
`~/.orbstack/config/docker.json` directly:

```json
"registry-mirrors": ["https://your-key.example.com"]
```

Then restart the engine:

```bash
orb restart docker
```

## Podman (macOS, Windows)

Podman pulls images inside its VM, so the mirror goes into the VM's config. Open a shell in the VM:

```bash
podman machine ssh
```

Inside the VM, write the mirror config:

```bash
sudo tee /etc/containers/registries.conf.d/ddocker.conf <<'EOF'
[[registry]]
prefix = "docker.io"
location = "docker.io"

[[registry.mirror]]
location = "your-key.example.com"
EOF
```

Type `exit`, then restart the machine so Podman picks up the change:

```bash
podman machine stop && podman machine start
```

If you ever recreate the machine with `podman machine init`, the setting is gone and you get to
do this again.

## Podman (Linux)

Write the same file on the host itself:

```bash
sudo tee /etc/containers/registries.conf.d/ddocker.conf <<'EOF'
[[registry]]
prefix = "docker.io"
location = "docker.io"

[[registry.mirror]]
location = "your-key.example.com"
EOF
```

## Colima

```bash
colima start --edit
```

Under `docker:`, add:

```yaml
registry-mirrors:
  - https://your-key.example.com
```

## Docker Engine (Linux)

Add the mirror to `/etc/docker/daemon.json`, creating the file if it isn't there:

```json
{ "registry-mirrors": ["https://your-key.example.com"] }
```

```bash
sudo systemctl restart docker
```

## Check that it works

Docker, OrbStack, Colima:

```bash
docker info --format '{{.RegistryConfig.Mirrors}}'
```

Podman:

```bash
podman info --format '{{json .Registries}}'
```

Your mirror should be in the output. Then pull something small:

```bash
docker pull alpine
```

## Good to know

Only Docker Hub images use the mirror. Anything from `ghcr.io`, `quay.io` or another registry
goes direct as usual.

Podman only uses the mirror for names that resolve to `docker.io`. Short names usually do, but
`docker.io/library/postgres:16` in a compose file always works.

buildx with the `docker-container` driver ignores the engine config. Add
`[registry."docker.io"] mirrors = ["your-key.example.com"]` to its `buildkitd.toml`. The
default builder uses the engine's mirror and needs nothing.

Pulls are all that goes through the mirror. `docker login` and `docker push` still need a
network that allows Docker Hub.

Keep your mirror hostname to yourself. It works as your access key.

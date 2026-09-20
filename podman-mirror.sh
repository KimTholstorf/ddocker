#!/usr/bin/env bash
# Point the Podman machine's docker.io pulls at your ddocker mirror.
# The config lives inside the VM, so rerun this after `podman machine init`.
# Usage: podman-mirror.sh <key>.example.com   (or --remove)
set -euo pipefail
DROPIN=/etc/containers/registries.conf.d/ddocker.conf
ARG=${1:?usage: podman-mirror.sh <key>.example.com | --remove}

if [[ $ARG == --remove ]]; then
  podman machine ssh "sudo rm -f $DROPIN"
else
  conf=$(printf '[[registry]]\nprefix = "docker.io"\nlocation = "docker.io"\n\n[[registry.mirror]]\nlocation = "%s"\n' "$ARG" | base64 | tr -d '\n')
  podman machine ssh "echo $conf | base64 -d | sudo tee $DROPIN >/dev/null"
fi

# The API service caches registries.conf, so restart the machine to pick it up.
podman machine stop >/dev/null && podman machine start >/dev/null
podman info --format '{{json .Registries}}'

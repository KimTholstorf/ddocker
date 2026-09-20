#!/usr/bin/env bash
# ddocker-doctor: find out in 10 seconds why docker pull is failing on this network.
# Usage: ddocker-doctor.sh [your-key.example.com]   (or set DDOCKER_MIRROR)
MIRROR=${1:-${DDOCKER_MIRROR:-}}

probe() {
  local label=$1 host=$2 path=$3 code rc issuer
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "https://$host$path"); rc=$?
  case $rc in
    0)  printf '  %-34s ok (HTTP %s)\n' "$label" "$code" ;;
    60|35) issuer=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
               | openssl x509 -noout -issuer 2>/dev/null | sed 's/.*CN *= *//; s/,.*//')
        printf '  %-34s BLOCKED: TLS intercepted by "%s"\n' "$label" "${issuer:-unknown}" ;;
    6)  printf '  %-34s BLOCKED: DNS does not resolve\n' "$label" ;;
    28) printf '  %-34s BLOCKED: timed out\n' "$label" ;;
    *)  printf '  %-34s BLOCKED: curl error %s\n' "$label" "$rc" ;;
  esac
}

echo "Docker Hub, direct:"
probe "registry (manifests)"  registry-1.docker.io /v2/
probe "auth (tokens)"         auth.docker.io /token
probe "layer CDN (cloudflare)" production.cloudflare.docker.com /
probe "layer CDN (cloudfront)" production.cloudfront.docker.com /
probe "hub.docker.com website" hub.docker.com /

if [[ -n $MIRROR ]]; then
  echo "Your mirror:"
  probe "$MIRROR" "$MIRROR" /v2/
fi

echo "Runtime config:"
mirrors=$(docker info --format '{{range .RegistryConfig.Mirrors}}{{.}} {{end}}' 2>/dev/null)
ctx=$(docker context show 2>/dev/null)
if [[ -z $ctx ]]; then
  echo "  docker not running"
elif [[ -n $MIRROR && $mirrors == *"$MIRROR"* ]]; then
  echo "  ok: context '$ctx' uses the mirror ($mirrors)"
else
  echo "  context '$ctx' mirrors: ${mirrors:-none}  <- add https://${MIRROR:-<key>.example.com} to registry-mirrors"
fi

if command -v podman >/dev/null; then
  if ! pinfo=$(podman info --format '{{json .Registries}}' 2>/dev/null); then
    echo "  podman: machine not running"
  elif [[ -n $MIRROR && $pinfo == *"$MIRROR"* ]]; then
    echo "  ok: podman uses the mirror"
  else
    echo "  podman: no mirror  <- run ./podman-mirror.sh ${MIRROR:-<key>.example.com}"
  fi
fi

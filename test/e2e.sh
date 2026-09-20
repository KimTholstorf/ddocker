#!/usr/bin/env bash
# Emulates a registry client pulling an image through the mirror.
# Usage: test/e2e.sh http://test-key123.localhost:8787 [image] [tag]
set -euo pipefail
M=${1:?mirror base url}; IMG=${2:-alpine}; TAG=${3:-latest}
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

challenge=$(curl -s -D - -o /dev/null "$M/v2/" | tr -d '\r' | grep -i '^www-authenticate:')
echo "challenge: $challenge"
realm=$(sed -E 's/.*realm="([^"]+)".*/\1/' <<<"$challenge")
[[ $realm == "$M/token" ]] || { echo "FAIL: realm not rewritten"; exit 1; }

token=$(curl -sf "$realm?service=registry.docker.io&scope=repository:$IMG:pull" | jq -r '.token // .access_token')
H=(-H "Authorization: Bearer $token" -H "Accept: $ACCEPT")

index=$(curl -sf "${H[@]}" "$M/v2/$IMG/manifests/$TAG")
digest=$(jq -r '[.manifests[]? | select(.platform.architecture=="arm64" and .platform.os=="linux")][0].digest // empty' <<<"$index")
manifest=${digest:+$(curl -sf "${H[@]}" "$M/v2/$IMG/manifests/$digest")}
manifest=${manifest:-$index}

layer=$(jq -r '.layers[0].digest' <<<"$manifest"); size=$(jq -r '.layers[0].size' <<<"$manifest")
got=$(curl -sfL "${H[@]}" "$M/v2/$IMG/blobs/$layer" | shasum -a 256 | cut -d' ' -f1)
[[ "sha256:$got" == "$layer" ]] || { echo "FAIL: layer digest mismatch"; exit 1; }
echo "OK: $IMG:$TAG layer $layer ($size bytes) verified"

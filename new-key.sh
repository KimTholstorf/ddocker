#!/usr/bin/env bash
# Generate an access key (a subdomain label) for one person.
# Usage: ./new-key.sh <name> [--key-only]
#   --key-only   print just the key, for use in other scripts
set -euo pipefail

NAME=""
KEY_ONLY=false
for arg in "$@"; do
  case $arg in
    --key-only) KEY_ONLY=true ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) NAME=$arg ;;
  esac
done
[[ -n $NAME ]] || { echo "usage: new-key.sh <name> [--key-only]" >&2; exit 2; }

[[ $NAME =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || {
  echo "name must be lowercase letters, digits and hyphens, e.g. alice" >&2
  exit 1
}

KEY="$NAME-$(openssl rand -hex 16)"
[[ ${#KEY} -le 63 ]] || { echo "name too long: the whole label must fit in 63 characters" >&2; exit 1; }

if $KEY_ONLY; then
  printf '%s\n' "$KEY"
  exit 0
fi

echo "$KEY"
echo
echo "Add it to ACCESS_KEYS (comma-separated, no spaces), deploy, and send them:" >&2
echo "  https://$KEY.<your-domain>/" >&2

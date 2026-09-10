#!/usr/bin/env bash
# Run from the repository on the VPS after installing Docker Engine.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
umask 077
mkdir -p deploy/private
config=deploy/private/production.env
if [[ -e "$config" ]]; then
  printf 'Configuration already exists; refusing to replace credentials.\n' >&2
  exit 1
fi
read -r -p 'Hostname [streetrove.kimber.dev]: ' hostname
hostname=${hostname:-streetrove.kimber.dev}
read -r -p 'Certificate / application contact email: ' contact
read -r -p 'Pilot username [streetrove]: ' pilot_user
pilot_user=${pilot_user:-streetrove}
[[ "$hostname" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ ]] || { echo 'Invalid hostname.' >&2; exit 1; }
[[ "$contact" =~ ^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { echo 'Invalid contact email.' >&2; exit 1; }
[[ "$pilot_user" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid username.' >&2; exit 1; }
read -r -s -p 'Pilot password (at least 16 characters): ' pilot_password
printf '\n'
[[ ${#pilot_password} -ge 16 ]] || { echo 'Password is too short.' >&2; exit 1; }
# Standard input keeps the password out of process arguments and history.
password_hash=$(printf '%s' "$pilot_password" | docker run --rm -i caddy:2-alpine caddy hash-password --algorithm bcrypt)
unset pilot_password
database_password=$(openssl rand -hex 32)
{
  printf 'STREETROVE_HOST=%s\nTLS_EMAIL=%s\nPILOT_USER=%s\n' "$hostname" "$contact" "$pilot_user"
  printf "PILOT_PASSWORD_HASH='%s'\n" "$password_hash"
  printf 'POSTGRES_PASSWORD=%s\n' "$database_password"
  printf 'OSM_USER_AGENT="StreetRove/0.1 (contact: %s)"\n' "$contact"
  printf 'STREETROVE_RELEASE=local\n'
} > "$config"
unset database_password password_hash
printf 'Created %s with private file permissions. No services have been started.\n' "$config"

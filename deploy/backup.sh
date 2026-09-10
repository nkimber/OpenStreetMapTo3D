#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
umask 077
mkdir -p deploy/private/backups
exec 9>deploy/private/backup.lock
flock -n 9 || exit 0
compose=(docker compose --env-file deploy/private/production.env -f compose.production.yaml)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="deploy/private/backups/$timestamp"
mkdir "$archive"
trap 'echo "Backup failed; incomplete directory retained for diagnosis." >&2' ERR
"${compose[@]}" exec -T db pg_dump -U streetrove -d streetrove -Fc > "$archive/database.dump"
"${compose[@]}" exec -T db pg_restore --list < "$archive/database.dump" > /dev/null
# Files are immutable; a file added mid-backup is harmless. Take the SQL dump first.
"${compose[@]}" exec -T worker tar -C /data/osm -czf - . > "$archive/osm.tar.gz"
cp deploy/private/production.env "$archive/production.env"
sha256sum "$archive/database.dump" "$archive/osm.tar.gz" > "$archive/SHA256SUMS"
touch "$archive/COMPLETE"
printf 'Backup complete: %s\nCopy it to independent storage; this directory is on the VPS.\n' "$archive"

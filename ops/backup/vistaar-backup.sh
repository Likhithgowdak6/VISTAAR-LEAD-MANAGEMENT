#!/usr/bin/env bash
#
# Nightly MongoDB backup for Vistaar CRM.
#
# WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT. This writes a compressed archive of the
# whole database to /backups on the SAME MACHINE and the SAME DISK as the data it is backing
# up. That covers a bad migration, a mistaken delete, a corrupted collection - the everyday
# ways data goes missing. It does NOT cover losing the instance or the EBS volume, because the
# copy dies with them. Off-server copies are a separate step and the one that actually matters;
# until that exists, treat this as half a backup.
#
# THE ARCHIVE IS PLAINTEXT CUSTOMER DATA. Every phone number, every message, every lead. It is
# written 0600 into a 0700 directory, and nothing here should ever widen that.
#
# NOTHING IN HERE WRITES TO THE LIVE DATABASE. mongodump only reads. The validation pass uses
# `--dryRun`, which performs no writes by definition, and is additionally pointed at a scratch
# namespace so that even a misreading of that flag could not land on wam_crm_ai.
#
# FAILURE IS LOUD AND LEAVES NOTHING BEHIND. Every step is checked, a partial file is never
# published under a real backup name, and the trap removes temporary files on any exit path.
# A backup that silently produces a 200-byte file is worse than no backup, because it looks
# like one in a directory listing.
set -euo pipefail

CONTAINER="wam-crm-ai-mongo"
DB="wam_crm_ai"
DEST="/backups"
KEEP=14
# A real dump of this database gzips to a few hundred KB. Anything near zero means mongodump
# produced an empty or truncated archive, which must not be mistaken for a backup.
MIN_BYTES=10000
LOCK="/tmp/vistaar-backup.lock"
S3_BUCKET="${AWS_S3_BACKUP_BUCKET:-}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "FAILED: $*" >&2; exit 1; }

# One run at a time. Cron and a hand-run backup overlapping would race on the container's
# temporary file and could publish a half-written archive.
exec 9>"$LOCK"
flock -n 9 || die "another backup run already holds the lock"

STAMP="$(date -u +%F-%H%M%S)"
# PID as well as the timestamp: two runs inside the same second would otherwise collide.
UNIQ="${STAMP}-$$"
IN_CONTAINER="/tmp/vistaar-dump-${UNIQ}.archive.gz"
# Staged inside DEST, not /tmp, so the final publish is a rename within one filesystem and
# therefore atomic. A cross-filesystem mv copies, and a reader could see a partial file.
HOST_TMP="${DEST}/.partial-${UNIQ}.archive.gz"
OUT="${DEST}/wam_crm_ai-${STAMP}.archive.gz"

cleanup() {
  docker exec "$CONTAINER" rm -f "$IN_CONTAINER" >/dev/null 2>&1 || true
  rm -f "$HOST_TMP" >/dev/null 2>&1 || true
}
# Covers success, failure and interruption alike.
trap cleanup EXIT

[ -d "$DEST" ] || die "$DEST does not exist - create it first"
[ -e "$OUT" ] && die "refusing to overwrite an existing archive at $OUT"

# 1. The container has to be running. `docker exec` against a stopped container fails in ways
#    that are easy to mistake for an empty database.
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
[ "$running" = "true" ] || die "container ${CONTAINER} is not running"

# 2. And mongod inside it has to answer. A container can be up while the process is still
#    starting, mid-election, or wedged.
docker exec "$CONTAINER" mongosh --quiet --eval 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1 \
  || die "mongod in ${CONTAINER} did not answer a ping"

log "dumping ${DB} from ${CONTAINER}"
docker exec "$CONTAINER" mongodump --db="$DB" --archive="$IN_CONTAINER" --gzip --quiet \
  || die "mongodump exited non-zero"

# 3. Validate the archive by PARSING it, not just by looking at its size.
#
#    Support is detected first and the result is a hard gate either way: running the check and
#    treating its failure as "unsupported" would quietly accept a corrupt archive, which is the
#    exact failure this is meant to catch.
if docker exec "$CONTAINER" mongorestore --help 2>&1 | grep -q -- '--dryRun'; then
  docker exec "$CONTAINER" mongorestore \
    --archive="$IN_CONTAINER" --gzip --dryRun --quiet \
    --nsFrom="${DB}.*" --nsTo="${DB}_backup_validation.*" \
    || die "the archive failed a dry-run restore - it is not usable"
  VALIDATION="dry-run restore parsed every collection"
else
  VALIDATION="gzip integrity only (this mongorestore has no --dryRun)"
fi

docker cp "${CONTAINER}:${IN_CONTAINER}" "$HOST_TMP" >/dev/null \
  || die "docker cp out of the container failed"

# 4. Independently check what landed on the host. docker cp can truncate on a full disk.
gzip -t "$HOST_TMP" || die "the copied archive is not valid gzip"

SIZE="$(stat -c %s "$HOST_TMP")"
[ "$SIZE" -ge "$MIN_BYTES" ] || die "archive is only ${SIZE} bytes - refusing to trust it"

# 5. Publish. Permissions set BEFORE the rename, so the file is never briefly readable under
#    its final name with looser bits.
chmod 600 "$HOST_TMP"
mv "$HOST_TMP" "$OUT"

log "ok ${OUT} (${SIZE} bytes, validated: ${VALIDATION})"

# 6. Optional Off-Site S3 Replication
if [ -n "${S3_BUCKET}" ]; then
  if command -v aws >/dev/null 2>&1; then
    log "uploading ${OUT} to s3://${S3_BUCKET}/mongo/"
    aws s3 cp "$OUT" "s3://${S3_BUCKET}/mongo/$(basename "$OUT")" --sse AES256 \
      && log "off-site s3 backup uploaded successfully" \
      || log "WARNING: s3 upload failed - local backup preserved"
  else
    log "WARNING: aws cli not installed - skipping off-site upload"
  fi
else
  log "NOTICE: AWS_S3_BACKUP_BUCKET not set - backup is local-only"
fi

# 7. Retention, last and only after a successful publish - so a failed run can never prune the
#    good archives it just failed to add to. Newest KEEP are kept.
ls -1t "${DEST}"/wam_crm_ai-*.archive.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  log "pruning ${old}"
  rm -f "$old"
done

exit 0

#!/bin/sh
# Пересоздать базу t и прогнать stubs + schema + update-1..N (N по умолчанию — все)
P="/usr/lib/postgresql/16/bin/psql -h /tmp -p 5544 -U postgres -v ON_ERROR_STOP=1 -q"
R=$(cd "$(dirname "$0")/../.." && pwd); D=$R/tests/db
N=${1:-$(ls $R/update-*.sql | wc -l)}
$P -c "drop database if exists t" -c "create database t" >/dev/null 2>&1
P="$P -d t"
$P -f $D/stubs.sql >/dev/null 2>&1 || exit 1
$P -f $R/schema.sql >/dev/null || { echo FAIL schema; exit 1; }
for i in $(seq 1 $N); do
  [ $i = 6 ] && $P -f $D/notify.sql >/dev/null
  sed -E '/create extension if not exists pg_(cron|net)/d' $R/update-$i.sql | $P -f - >/dev/null 2>/tmp/err.txt || { echo "FAIL update-$i"; cat /tmp/err.txt; exit 1; }
done
echo OK

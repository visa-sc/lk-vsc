#!/usr/bin/env bash
# Обёртка для работы ТОЛЬКО с VPS бота (194.67.103.207): ssh-команды и заливка/
# скачивание файлов, со встроенными ретраями на флакость сети из песочницы.
# IP захардкожен — на прод (89.108.88.59) эта обёртка ходить НЕ может.
# Использование:
#   bash botssh.sh run 'удалённая команда'
#   bash botssh.sh put локальныйфайл [ещё...] :/удалённая/папка/
#   bash botssh.sh get /удалённый/файл локальныйпуть
set -uo pipefail
HOST="root@194.67.103.207"
SSH_OPTS=(-o ConnectTimeout=30 -o BatchMode=yes -o ServerAliveInterval=10 -o StrictHostKeyChecking=accept-new)
MODE="${1:-}"; shift || true

run_with_retry() {
  local n=0 max=6
  while :; do
    "$@" && return 0
    n=$((n+1)); [ "$n" -ge "$max" ] && { echo "[botssh] не удалось после $max попыток" >&2; return 1; }
    echo "[botssh] повтор $n…" >&2; sleep $((3 + n*2))
  done
}

case "$MODE" in
  run)
    run_with_retry ssh "${SSH_OPTS[@]}" "$HOST" "$*"
    ;;
  put)
    files=(); dest=""
    for a in "$@"; do
      if [[ "$a" == :* ]]; then dest="${a#:}"; else files+=("$a"); fi
    done
    [ -z "$dest" ] && { echo "[botssh] put: укажи назначение как :/remote/dir" >&2; exit 2; }
    run_with_retry scp "${SSH_OPTS[@]}" "${files[@]}" "$HOST:$dest"
    ;;
  get)
    run_with_retry scp "${SSH_OPTS[@]}" "$HOST:$1" "$2"
    ;;
  *)
    echo "usage: botssh.sh run|put|get …" >&2; exit 2
    ;;
esac

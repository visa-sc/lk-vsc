#!/usr/bin/env bash
# ── Настройка машины под распознавание звонков (проект Кати Зайцевой) ─────────
# Запускать НА НОВОМ сервере от root, один раз, сразу после создания:
#   scp tools/kate-asr-setup.sh root@<IP>:/root/ && ssh root@<IP> 'bash /root/kate-asr-setup.sh "<ssh-ключ Кати>"'
#
# Ставит ровно то, что Катя просила в письме (ffmpeg, cmake, make, gcc, python3),
# плюс базовая гигиена: пользователь с sudo, swap, файрвол, автообновления.
# Сам Whisper НЕ ставим — Катя собирает его сама (whisper.cpp из исходников).
set -euo pipefail

KATE_KEY="${1:-}"            # публичный ssh-ключ Кати (необязательно, можно добавить позже)
KATE_USER="kate"
SWAP_GB=2                    # страховка от OOM; при 8 ГБ памяти больше не нужно, диск дороже
AUDIO_KEEP_DAYS=30           # записи храним месяц, транскрипции — бессрочно

echo "── 1/8 Время и локаль ─────────────────────────────────────────"
timedatectl set-timezone Europe/Moscow
echo "  часовой пояс: $(timedatectl show -p Timezone --value)"

echo "── 2/8 Обновление системы ─────────────────────────────────────"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

echo "── 3/8 Пакеты для сборки whisper.cpp и работы со звуком ───────"
apt-get install -y -qq \
  ffmpeg \
  build-essential cmake make gcc g++ \
  python3 python3-pip python3-venv \
  git curl unzip htop tmux \
  ufw fail2ban unattended-upgrades
echo "  ffmpeg: $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"
echo "  cmake:  $(cmake --version | head -1)"
echo "  python: $(python3 --version)"

echo "── 4/8 Swap ${SWAP_GB} ГБ ──────────────────────────────────────────"
if swapon --show | grep -q .; then
  echo "  swap уже есть, пропускаю"
else
  fallocate -l ${SWAP_GB}G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q -w vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  echo "  подключён: $(free -h | awk '/Swap/{print $2}')"
fi

echo "── 5/8 Пользователь ${KATE_USER} ──────────────────────────────────────"
if id "$KATE_USER" &>/dev/null; then
  echo "  пользователь уже есть"
else
  adduser --disabled-password --gecos "" "$KATE_USER"
  usermod -aG sudo "$KATE_USER"
  # sudo без пароля: пароля у пользователя нет, вход только по ключу
  echo "$KATE_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$KATE_USER"
  chmod 440 "/etc/sudoers.d/90-$KATE_USER"
  echo "  создан, добавлен в sudo"
fi
if [ -n "$KATE_KEY" ]; then
  install -d -m 700 -o "$KATE_USER" -g "$KATE_USER" "/home/$KATE_USER/.ssh"
  echo "$KATE_KEY" >> "/home/$KATE_USER/.ssh/authorized_keys"
  sort -u "/home/$KATE_USER/.ssh/authorized_keys" -o "/home/$KATE_USER/.ssh/authorized_keys"
  chmod 600 "/home/$KATE_USER/.ssh/authorized_keys"
  chown "$KATE_USER:$KATE_USER" "/home/$KATE_USER/.ssh/authorized_keys"
  echo "  ключ Кати добавлен"
else
  echo "  ⚠ ключ Кати не передан — добавить потом в /home/$KATE_USER/.ssh/authorized_keys"
fi

echo "── 6/8 Файрвол и автообновления ───────────────────────────────"
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
echo "  ufw: только SSH (наружу сервис ничего не публикует)"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now fail2ban >/dev/null 2>&1 || true

echo "── 7/8 Рабочие каталоги ───────────────────────────────────────"
for d in /opt/asr /opt/asr/audio /opt/asr/text /opt/asr/models; do
  install -d -m 755 -o "$KATE_USER" -g "$KATE_USER" "$d"
done
echo "  /opt/asr/audio  — записи (чистятся автоматически, см. ниже)"
echo "  /opt/asr/text   — транскрипции (хранятся бессрочно, весят копейки)"
echo "  /opt/asr/models — модели whisper"

echo "── 8/8 Автоочистка записей старше ${AUDIO_KEEP_DAYS} дней ────────────────────"
# Аудио — биометрические ПДн и основной пожиратель диска; держим не дольше месяца.
# Транскрипции НЕ трогаем: они текстовые и нужны для повторных разборов.
cat > /etc/cron.daily/asr-cleanup <<CRON
#!/bin/sh
# чистка записей звонков: аудио живёт не дольше ${AUDIO_KEEP_DAYS} дней, тексты остаются
find /opt/asr/audio -type f \\( -name '*.mp3' -o -name '*.wav' -o -name '*.ogg' \\) -mtime +${AUDIO_KEEP_DAYS} -delete 2>/dev/null
find /opt/asr/audio -type d -empty -mtime +${AUDIO_KEEP_DAYS} -delete 2>/dev/null
CRON
chmod +x /etc/cron.daily/asr-cleanup
echo "  /etc/cron.daily/asr-cleanup — раз в сутки, аудио старше ${AUDIO_KEEP_DAYS} дн. удаляется"

echo
echo "════════ ГОТОВО ════════"
echo "ядер: $(nproc) · память: $(free -h | awk '/Mem/{print $2}') · swap: $(free -h | awk '/Swap/{print $2}') · диск: $(df -h / | awk 'NR==2{print $4}') свободно"
echo "вход для Кати:  ssh ${KATE_USER}@$(hostname -I | awk '{print $1}')"
echo
echo "Дальше Катя собирает whisper.cpp сама:"
echo "  git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j\$(nproc)"
echo "  bash ./models/download-ggml-model.sh medium"
echo "Совет: телефонные записи 8 кГц — перед распознаванием привести к 16 кГц моно НА КАЖДЫЙ КАНАЛ:"
echo "  ffmpeg -i call.mp3 -filter_complex 'channelsplit=channel_layout=stereo[l][r]' -map '[l]' -ar 16000 mgr.wav -map '[r]' -ar 16000 client.wav"

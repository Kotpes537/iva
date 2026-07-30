#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${TELEGRAM_BOT_API_SOURCE_DIR:-/root/src/telegram-bot-api}"
BUILD_JOBS="${TELEGRAM_BOT_API_BUILD_JOBS:-1}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates cmake g++ git gperf make libssl-dev zlib1g-dev

mkdir -p "$(dirname "$SOURCE_DIR")"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone --recursive https://github.com/tdlib/telegram-bot-api.git "$SOURCE_DIR"
else
  git -C "$SOURCE_DIR" fetch --prune origin
  git -C "$SOURCE_DIR" checkout master
  git -C "$SOURCE_DIR" pull --ff-only origin master
  git -C "$SOURCE_DIR" submodule update --init --recursive
fi

cmake -S "$SOURCE_DIR" -B "$SOURCE_DIR/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build "$SOURCE_DIR/build" --target install --parallel "$BUILD_JOBS"

/usr/local/bin/telegram-bot-api --version

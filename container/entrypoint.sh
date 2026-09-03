#!/bin/sh
set -eu

install -d -m 0700 /tmp/runtime-browser

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp > /tmp/xvfb.log 2>&1 &
xvfb_pid=$!

cleanup() {
  if [ -n "${brave_pid:-}" ]; then
    kill -TERM "$brave_pid" 2>/dev/null || true
    wait "$brave_pid" 2>/dev/null || true
  fi
  kill -TERM "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

proxy_args=""
if [ -n "${BROWSERSILO_BRAVE_PROXY:-}" ]; then
  proxy_args="--proxy-server=${BROWSERSILO_BRAVE_PROXY} --proxy-bypass-list=<-loopback>"
fi

# shellcheck disable=SC2086
HOME=/home/browser XDG_RUNTIME_DIR=/tmp/runtime-browser DISPLAY=:99 brave-browser $proxy_args \
  --user-data-dir=/home/browser/.brave-profile \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-background-networking \
  --disable-component-update \
  --disable-breakpad \
  --disable-crash-reporter \
  --disable-sync \
  --metrics-recording-only \
  --no-first-run \
  --no-default-browser-check \
  about:blank > /tmp/brave.log 2>&1 &
brave_pid=$!
set +e
wait "$brave_pid"
status=$?
set -e
echo "Brave exited with status $status" >&2
tail -n 80 /tmp/brave.log >&2 || true
tail -n 40 /tmp/xvfb.log >&2 || true
exit "$status"

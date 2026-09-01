#!/bin/zsh

set -u

PROJECT_DIR="/Users/minimac/Documents/Work/email-fetch"

fail() {
  print ""
  print "Could not stop Email Fetch: $1"
  print -n "Press any key to close this window..."
  read -k 1
  print ""
  exit 1
}

cd "$PROJECT_DIR" || fail "project folder not found at $PROJECT_DIR"
command -v docker >/dev/null 2>&1 || fail "Docker is not installed or is not on PATH"

if ! docker info >/dev/null 2>&1; then
  print "Docker is not running, so Email Fetch is already stopped."
  sleep 2
  exit 0
fi

print "Stopping Email Fetch..."
docker compose down || fail "docker compose down failed"
print ""
print "Email Fetch has stopped. Saved data was kept."
sleep 2

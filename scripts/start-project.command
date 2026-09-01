#!/bin/zsh

set -u

PROJECT_DIR="/Users/minimac/Documents/Work/email-fetch"
APP_URL="http://127.0.0.1:8080"

fail() {
  print ""
  print "Could not start Email Fetch: $1"
  print -n "Press any key to close this window..."
  read -k 1
  print ""
  exit 1
}

cd "$PROJECT_DIR" || fail "project folder not found at $PROJECT_DIR"
command -v docker >/dev/null 2>&1 || fail "Docker is not installed or is not on PATH"

if ! docker info >/dev/null 2>&1; then
  print "Starting Docker Desktop..."
  open -a Docker >/dev/null 2>&1 || fail "Docker Desktop could not be opened"

  attempts=0
  until docker info >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    (( attempts >= 120 )) && fail "Docker did not become ready within four minutes"
    sleep 2
  done
fi

print "Building and starting Email Fetch..."
docker compose up --build --detach || fail "docker compose up failed"

print "Waiting for Email Fetch to become ready..."
attempts=0
until curl --fail --silent --output /dev/null "$APP_URL"; do
  attempts=$((attempts + 1))
  if (( attempts >= 90 )); then
    print "The containers started, but the website is not ready yet."
    print "Opening $APP_URL anyway."
    break
  fi
  sleep 2
done

open "$APP_URL"
print ""
print "Email Fetch is running at $APP_URL"
sleep 2

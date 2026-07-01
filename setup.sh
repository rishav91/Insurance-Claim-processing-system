#!/usr/bin/env bash
# Setup script: install, reset DB, test, demo.
# Start the API server separately: cd app && npm run dev
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$SCRIPT_DIR/app"

if [ ! -f "$APP/.env" ]; then
  echo "==> Copying .env.example -> app/.env"
  cp "$APP/.env.example" "$APP/.env"
else
  echo "==> app/.env already exists, skipping copy"
fi

echo "==> Installing dependencies"
npm --prefix "$APP" install

echo "==> Resetting database and seeding reference data"
npm --prefix "$APP" run db:reset

echo "==> Running test suite"
npm --prefix "$APP" test

echo "==> Running end-to-end demo"
npm --prefix "$APP" run demo

echo ""
echo "Setup complete. Start the API server with:"
echo "  cd app && npm run dev"

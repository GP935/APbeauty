#!/usr/bin/env bash
# AP Beauty · deploy — redactado por backend, revisado y adoptado por devops 2026-07-15.
# Lo ejecuta EL HUMANO en el VPS, dentro del directorio del repo
# (p.ej. /var/www/apbeauty). No lo ejecuta ningún agente.
set -euo pipefail

echo "==> git pull"
git pull origin main

echo "==> deps del backend (solo producción)"
cd server
npm ci --omit=dev
cd ..

echo "==> recarga PM2 (zero-downtime)"
pm2 reload ecosystem.config.js --env production
pm2 save

echo "==> Deploy OK. Estado:"
pm2 status apbeauty-backend

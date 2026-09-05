// AP Beauty · PM2 — redactado por backend, revisado y adoptado por devops 2026-07-15.
// Arranca el backend Node desde ./server cargando ./server/.env.
// Uso en el VPS (desde la raíz del repo):
//   pm2 start ecosystem.config.js --env production
//   pm2 save && pm2 startup   (para que sobreviva a reinicios)
module.exports = {
  apps: [
    {
      name: 'apbeauty-backend',
      cwd: './server',
      script: 'server.js',
      // Carga ./server/.env (Node >= 20.12). El .env NUNCA se versiona.
      node_args: '--env-file-if-exists=.env',
      // instances:1 / fork A PROPÓSITO: la idempotencia de los webhooks
      // (eventosProcesados/notificacionesMP) y el tracking de importes
      // (pedidos/pedidosMP) están en memoria por proceso. Con la pasarela
      // Mercado Pago activa (2026-09-05) esto sigue igual de obligatorio.
      // NO usar cluster hasta migrar el estado a DB/KV compartido.
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      // Apagado limpio: server.js escucha SIGTERM/SIGINT (reload sin cortar).
      kill_timeout: 12000,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};

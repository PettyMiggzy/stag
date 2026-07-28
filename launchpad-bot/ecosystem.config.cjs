// PM2 process file — keeps the buy bot alive & auto-restarting.
//   pm2 start ecosystem.config.cjs
//   pm2 logs hoodx-buybot
//   pm2 save && pm2 startup   (survive server reboots)
module.exports = {
  apps: [
    {
      name: "hoodx-buybot",
      script: "index.mjs",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 4000,
      env: { NODE_ENV: "production" },
    },
  ],
};

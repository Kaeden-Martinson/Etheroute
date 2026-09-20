// PM2 process manager config — alternative to systemd.
//   pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'etheroute',
      script: 'src/app.js',
      instances: 1,               // single instance: the datastore is not multi-writer safe
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      // Load real secrets from the environment / .env, not from here.
    },
  ],
};

module.exports = {
  apps: [{
    name: "mythic-relayer",
    script: "dist/index.js",
    cwd: "/mnt/data/mythic-relayer",
    env: { NODE_ENV: "production" },
    restart_delay: 5000,
    max_restarts: 10,
    log_file: "./logs/relayer.log",
    error_file: "./logs/relayer-error.log",
  }]
};

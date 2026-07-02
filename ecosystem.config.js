module.exports = {
  apps: [
    {
      name: "pdf-saas-api",
      script: "dist/index.js",
      cwd: "/var/www/pdf/pdf-backend/api",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "pdf-saas-worker",
      script: "dist/index.js",
      cwd: "/var/www/pdf/pdf-backend/worker",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

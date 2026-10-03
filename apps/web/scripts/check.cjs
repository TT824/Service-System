const { spawnSync } = require('node:child_process');

const files = [
  'server.js',
  'src/api-client.js',
  'src/realtime.js',
  'src/exports.js',
  'src/catalog.js',
  'src/load-pages.js',
  'src/mock-data.js',
  'src/admin-data.js',
  'src/app.js',
  'src/admin.js',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Frontend syntax check passed (${files.length} files).`);

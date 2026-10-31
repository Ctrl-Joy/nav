// Build step: stamps build metadata into the artifact.
const fs = require('node:fs');
fs.writeFileSync('build-info.json', JSON.stringify({ builtAt: new Date().toISOString(), commit: process.env.NAV_GIT_COMMIT || null }));
console.log('build-info.json written');

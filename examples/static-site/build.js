const fs = require('node:fs');
fs.mkdirSync('dist/assets', { recursive: true });
fs.writeFileSync('dist/index.html', `<!doctype html><html><head><title>NAV static</title><link rel="stylesheet" href="/assets/site.4f2a1c.css"></head><body><h1>Static site on NAV</h1><p>Built ${new Date().toISOString()}</p></body></html>`);
fs.writeFileSync('dist/assets/site.4f2a1c.css', 'body{font-family:system-ui;background:#0b0d10;color:#e8eaed}');
fs.writeFileSync('dist/404.html', '<h1>Not here</h1>');
console.log('built dist/');

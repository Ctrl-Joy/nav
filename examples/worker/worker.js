let n = 0;
console.log('worker started');
setInterval(() => console.log(`processed job #${++n}`), 3000);
process.on('SIGTERM', () => { console.log('worker draining'); process.exit(0); });

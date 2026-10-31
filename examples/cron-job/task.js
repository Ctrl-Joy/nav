console.log(`cron tick at ${new Date().toISOString()} (service ${process.env.NAV_SERVICE_NAME})`);
if (process.argv[2] === 'fail') process.exit(2);

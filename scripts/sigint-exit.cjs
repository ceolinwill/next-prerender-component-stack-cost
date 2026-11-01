// Next ends its build workers with SIGINT. Exiting normally on SIGINT lets
// Node's --cpu-prof write each worker's profile.
process.on('SIGINT', () => process.exit(0));

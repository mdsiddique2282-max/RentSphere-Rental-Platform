// Legacy destructive seeding is permanently disabled. No configuration or database modules are loaded.
console.error('Legacy seeding is disabled to protect existing RentSphere data. No database connection or changes were made.');
process.exitCode = 1;

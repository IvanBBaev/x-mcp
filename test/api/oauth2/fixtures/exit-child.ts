// T-206 driver: a process that exits immediately. The parent test harvests its REAL
// (now provably dead) PID to plant as a lock holder for the AUTH-5 dead-holder matrix
// rows, exercising the store's DEFAULT process.kill(pid, 0) liveness probe for real.

export {};

process.exit(0);

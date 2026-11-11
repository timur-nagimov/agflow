// Standalone pinned vendor installation for smoke suites (design 7.1, 15).
import { vendorInstallMain } from '../src/vendor/install';

if (import.meta.main) process.exitCode = await vendorInstallMain(process.argv.slice(2), process.env);

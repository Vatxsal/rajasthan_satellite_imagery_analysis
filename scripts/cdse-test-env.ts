/**
 * Flips the process into live-CDSE mode BEFORE the route graph loads.
 *
 * lib/dataSource freezes NEXT_PUBLIC_DATA_SOURCE at first import and
 * getServerEnv() caches its parse, so a test that needs "cdse" must import
 * this module statically (right after alias-hook, before the route) instead
 * of assigning the env vars later. Credentials are fake — every test stubs
 * fetch, so no network call ever happens.
 */
process.env.NEXT_PUBLIC_DATA_SOURCE = "cdse";
process.env.CDSE_CLIENT_ID = "test-client";
process.env.CDSE_CLIENT_SECRET = "test-secret";

// Runs once before all test files. Makes it impossible to miss that the
// database tests did not run.
export default function setup() {
  if (process.env.MONGO_URI_TEST) {
    console.log(`\nDatabase tests: ON (MONGO_URI_TEST is set)\n`);
    return;
  }
  console.warn(
    [
      '',
      '==================================================================',
      ' Database tests SKIPPED: MONGO_URI_TEST is not set.',
      ' Only unit and no-database tests ran. The ordering, stock, cancel,',
      ' isolation and report tests did NOT run.',
      ' To run them (PowerShell), with a throwaway MongoDB:',
      "   $env:MONGO_URI_TEST='mongodb://127.0.0.1:27018/choplist_test'; npm test",
      ' or add MONGO_URI_TEST to the root .env file.',
      '==================================================================',
      '',
    ].join('\n'),
  );
}

// Jest configuration for the tests that run against the REAL emulators.
// It is NOT picked up by the default `npx jest` (that one only runs __tests__/ and never needs emulators).
// Run with the emulators already started (see EMULATOR.md):
//   npx jest -c jest.emulator.config.js --runInBand
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/emulator-tests/**/*.emu.js'],
  testTimeout: 60000
};

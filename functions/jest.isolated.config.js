// Jest configuration for the tests that run against the ISOLATED emulators (Firestore 8190, Storage 9290,
// project demo-ductsal-isolated). Not picked up by the default `npx jest`. See ISOLATED_TESTS.md.
//   npx jest -c jest.isolated.config.js --runInBand
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/isolated-tests/**/*.iso.js'],
  testTimeout: 60000
};

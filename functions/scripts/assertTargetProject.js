#!/usr/bin/env node
// functions/scripts/assertTargetProject.js
// Preflight guard for DUCTSAL ERP test & maintenance scripts.
//
// STRICT SAFETY RULE:
// Prevents accidental writes or deployments against production ('ductsal-erp').
// Requires target to be explicitly 'ductsal-erp-staging' or local emulator 'demo-*'.

const ALLOWED_TEST_PROJECTS = new Set([
  'ductsal-erp-staging',
  'demo-ductsal-local',
  'demo-ductsal-isolated'
]);

const FORBIDDEN_PRODUCTION_PROJECTS = new Set([
  'ductsal-erp',
  'ductsal-erp.firebaseapp.com',
  'ductsal-erp.firebasestorage.app'
]);

function assertSafeTargetProject(projectId, context = 'Test/Seed Script') {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error(`[FATAL GUARD] Target projectId must be a non-empty string. Provided: "${projectId}"`);
  }

  const cleanId = projectId.trim().toLowerCase();

  // 1. Explicit check against production
  if (FORBIDDEN_PRODUCTION_PROJECTS.has(cleanId)) {
    const msg = `🚨 FATAL SAFETY VIOLATION BLOCKED: ${context} attempted against PRODUCTION project "${cleanId}". All write operations are strictly forbidden on production!`;
    console.error('\n' + '='.repeat(80) + '\n' + msg + '\n' + '='.repeat(80) + '\n');
    throw new Error(msg);
  }

  // 2. Explicit whitelist check
  if (!ALLOWED_TEST_PROJECTS.has(cleanId)) {
    const msg = `🚨 TARGET PROJECT REJECTED: ${context} attempted against "${cleanId}". Must be one of: ${Array.from(ALLOWED_TEST_PROJECTS).join(', ')}`;
    console.error('\n' + '='.repeat(80) + '\n' + msg + '\n' + '='.repeat(80) + '\n');
    throw new Error(msg);
  }

  console.log(`[TARGET GUARD OK] Operation allowed for validated target project: "${cleanId}" (${context})`);
  return cleanId;
}

if (require.main === module) {
  const target = process.argv[2] || process.env.GCLOUD_PROJECT;
  try {
    assertSafeTargetProject(target, 'CLI Verification');
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  assertSafeTargetProject,
  ALLOWED_TEST_PROJECTS,
  FORBIDDEN_PRODUCTION_PROJECTS
};

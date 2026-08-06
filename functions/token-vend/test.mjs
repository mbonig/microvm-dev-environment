// Unit checks for token-vend helpers that are pure enough to test without AWS.
//   node functions/token-vend/test.mjs
import { createRequire } from 'node:module';
const { conflictAccessPointId } = createRequire(import.meta.url)('./conflict.js');

let pass = 0, fail = 0;
const eq = (actual, expected, what) => {
  if (actual === expected) { pass++; return; }
  fail++;
  console.error(`  FAIL ${what}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// The shape sigv4Request rejects with: message plus statusCode and raw body.
const apiErr = (statusCode, body) =>
  Object.assign(new Error(`API ${statusCode}`), { statusCode, body });

// The exact payload the S3 Files control plane returned when the SSM parameter
// path was renamed out from under an existing access point.
const REAL_409 = JSON.stringify({
  errorCode: 'ConflictException',
  message: "Access Point 'fsap-06b392e040a7050c7' already exists with this clientToken.",
  resourceId: 'fsap-06b392e040a7050c7',
  resourceType: 'AccessPoint',
});

console.log('\nconflictAccessPointId — adopts an existing access point');
eq(conflictAccessPointId(apiErr(409, REAL_409)), 'fsap-06b392e040a7050c7', 'real 409 yields the id');

console.log('conflictAccessPointId — everything else must propagate');
eq(conflictAccessPointId(apiErr(500, REAL_409)), null, '500 is not adopted, even with a resourceId');
eq(conflictAccessPointId(apiErr(403, REAL_409)), null, '403 is not adopted');
eq(conflictAccessPointId(apiErr(404, REAL_409)), null, '404 is not adopted');
eq(conflictAccessPointId(apiErr(409, undefined)), null, '409 with no body');
eq(conflictAccessPointId(apiErr(409, '')), null, '409 with empty body');
eq(conflictAccessPointId(apiErr(409, 'not json at all')), null, '409 with unparseable body');
eq(conflictAccessPointId(apiErr(409, '{}')), null, '409 with no resourceId');
eq(conflictAccessPointId(apiErr(409, '{"resourceId":""}')), null, '409 with empty resourceId');
eq(conflictAccessPointId(apiErr(409, '{"resourceId":null}')), null, '409 with null resourceId');
eq(conflictAccessPointId(new Error('network down')), null, 'a non-API error');
eq(conflictAccessPointId(null), null, 'null');
eq(conflictAccessPointId(undefined), null, 'undefined');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

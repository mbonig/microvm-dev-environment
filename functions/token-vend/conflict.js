// Split out from index.js so it can be tested without the AWS SDK, which only
// exists in the Lambda runtime.

// The existing access-point id out of a CreateAccessPoint 409, or null if this
// isn't a recoverable conflict. Anything other than a 409 carrying a usable
// resourceId must propagate — silently continuing without an access point would
// mount the wrong home.
function conflictAccessPointId(err) {
  if (!err || err.statusCode !== 409) return null;
  try {
    return JSON.parse(err.body || '{}').resourceId || null;
  } catch {
    return null;
  }
}

module.exports = { conflictAccessPointId };

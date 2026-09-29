/**
 * Host-owned plugin permission vocabulary and ceiling intersection.
 *
 * A contribution's `permissionCeiling` is a hard upper bound on what that
 * contribution may declare. Previously the ceiling was only checked for being a
 * known enum value, so a READ_ONLY manifest could still declare
 * `executor.invoke.controlled` and receive the executor service through the
 * capability membrane. This module owns the intersection so the manifest
 * validator and the context membrane cannot disagree.
 *
 * A contribution without a declared ceiling keeps the historical behaviour (the
 * full known vocabulary); an explicit ceiling can only narrow a grant.
 */
export const KNOWN_PERMISSIONS = Object.freeze([
  'workspace.read.metadata', 'workspace.read.content', 'workspace.read.snapshot',
  'workspace.write.patch', 'filesystem.write.workspace',
  'process.execute.argv', 'process.execute.shell', 'process.spawn.restricted',
  'network.connect.host', 'trajectory.read.redacted', 'trajectory.write',
  'profile.read', 'profile.propose-update', 'ui.render.timeline-item',
  'executor.invoke.controlled', 'thread.read', 'thread.write',
  'plugin.manifest.read', 'plugin.registry.write'
]);

export const PERMISSION_CEILINGS = Object.freeze(['READ_ONLY', 'CONTROLLED']);

// READ_ONLY is observation only. Every mutating, executing or egress permission
// belongs to CONTROLLED; there is no ceiling above the known vocabulary.
export const CEILING_PERMISSIONS = Object.freeze({
  READ_ONLY: Object.freeze([
    'workspace.read.metadata', 'workspace.read.content', 'workspace.read.snapshot',
    'trajectory.read.redacted', 'profile.read', 'ui.render.timeline-item',
    'thread.read', 'plugin.manifest.read'
  ]),
  CONTROLLED: KNOWN_PERMISSIONS
});

const KNOWN = new Set(KNOWN_PERMISSIONS);
const CEILING_RANK = Object.freeze({ READ_ONLY: 0, CONTROLLED: 1 });
const contributionList = (manifest) => (Array.isArray(manifest?.contributions) ? manifest.contributions : []);

export const isKnownPermission = (value) => typeof value === 'string' && KNOWN.has(value);

export const isPermissionCeiling = (value) => typeof value === 'string' && PERMISSION_CEILINGS.includes(value);

/** Permissions declared anywhere in the manifest that a ceiling does not allow. */
export const permissionsExceedingCeiling = (manifest) => {
  const violations = [];
  for (const contribution of contributionList(manifest)) {
    const ceiling = contribution?.permissionCeiling;
    if (!isPermissionCeiling(ceiling)) continue;
    const allowed = new Set(CEILING_PERMISSIONS[ceiling]);
    for (const permission of Array.isArray(contribution?.permissions) ? contribution.permissions : []) {
      if (!allowed.has(permission)) violations.push({ contributionId: String(contribution?.id ?? ''), ceiling, permission });
    }
  }
  return violations;
};

/**
 * The effective ceiling for a whole manifest: the most restrictive ceiling any
 * contribution declares, or CONTROLLED when nothing opts in to a narrower bound.
 */
export const effectivePermissionCeiling = (manifest) => {
  let ceiling = 'CONTROLLED';
  for (const contribution of contributionList(manifest)) {
    const declared = contribution?.permissionCeiling;
    if (!isPermissionCeiling(declared)) continue;
    if (CEILING_RANK[declared] < CEILING_RANK[ceiling]) ceiling = declared;
  }
  return ceiling;
};

/** Declared permissions that stay inside the manifest's effective ceiling. */
export const permissionsWithinCeiling = (manifest) => {
  const allowed = new Set(CEILING_PERMISSIONS[effectivePermissionCeiling(manifest)]);
  const granted = new Set();
  for (const contribution of contributionList(manifest)) {
    for (const permission of Array.isArray(contribution?.permissions) ? contribution.permissions : []) {
      if (allowed.has(permission)) granted.add(permission);
    }
  }
  return [...granted].sort();
};

import { generateKeyPairSync, sign } from 'node:crypto';
import { pluginGovernanceDigest } from '../../src/plugin-governance.mjs';

// Controlled channels refuse unsigned dynamic plugins. Tests that exercise the
// layers behind the signature gate (traversal, revocation, activation) sign
// fixtures with this ephemeral key and install it as the trust root.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
export const PLUGIN_TRUST_KEY = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim();

export const installPluginTrustKey = (env = process.env) => {
  env.DDA_PLUGIN_TRUST_KEY = PLUGIN_TRUST_KEY;
  return PLUGIN_TRUST_KEY;
};

export const signPluginManifest = (manifest) => ({
  algorithm: 'ed25519',
  manifestDigest: pluginGovernanceDigest(manifest),
  publicKey: PLUGIN_TRUST_KEY,
  signature: sign(null, Buffer.from(JSON.stringify(manifest), 'utf8'), privateKey).toString('base64')
});

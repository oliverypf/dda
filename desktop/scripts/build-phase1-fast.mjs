import { pathToFileURL } from 'node:url';

export const phase1FastBuildEnvironment = () => {
  throw new Error('RELEASE_CHANNEL_RETIRED: use npm run build:windows:phase15:fast');
};

export const runPhase1FastBuild = phase1FastBuildEnvironment;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPhase1FastBuild();
}

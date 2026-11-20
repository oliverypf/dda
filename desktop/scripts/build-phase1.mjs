import { pathToFileURL } from 'node:url';

export const phase1BuildEnvironment = () => {
  throw new Error('RELEASE_CHANNEL_RETIRED: use npm run build:windows:phase15');
};

export const runPhase1Build = phase1BuildEnvironment;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPhase1Build();
}

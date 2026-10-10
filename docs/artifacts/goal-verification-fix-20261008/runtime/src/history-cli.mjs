#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseHarnessStore, resolveReleaseChannel } from './release-channel.mjs';
import { readThreadHistory } from './thread-history-reader.mjs';

// Shared by index.mjs and the desktop's lightweight, read-only entry point.
// Never import the execution harness, model clients, or recovery controllers here.
export async function runHistoryCommand(command, args = process.argv.slice(3)) {
  const value = (name) => {
    for (let index = 0; index < args.length; index++) {
      if (args[index] === name) return args[index + 1]?.startsWith('--') ? undefined : args[index + 1];
      if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
    }
  };
  const operation = value('--operation') ?? 'list';
  if (command !== 'thread-events' && !(value('--summary') === 'true'
    && (command === 'dashboard' || (command === 'thread' && ['list', 'get'].includes(operation))))) {
    throw new Error('HISTORY_READ_COMMAND_REQUIRED');
  }
  const releaseChannel = resolveReleaseChannel();
  const root = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  const defaultPath = (name) => root ? join(root, 'hmCodex', name) : undefined;
  const trajectoryPath = value('--trajectory-store') ?? process.env.HMCODEX_TRAJECTORY_STORE ?? defaultPath('trajectory.jsonl');
  const scopedTrajectory = value('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = assertReleaseHarnessStore(value('--harness-event-store') ?? process.env.HMCODEX_HARNESS_EVENT_STORE
    ?? (!scopedTrajectory ? defaultPath('hmcodex.db')
      : releaseChannel === 'WINDOWS_PHASE1_READ_ONLY' && trajectoryPath ? `${trajectoryPath}.db` : undefined));
  const explicitThreadStore = value('--thread-store') !== undefined || Boolean(process.env.HMCODEX_THREAD_STORE?.trim());
  const threadPath = value('--thread-store') ?? process.env.HMCODEX_THREAD_STORE
    ?? (command !== 'thread' && scopedTrajectory && trajectoryPath ? `${trajectoryPath}.threads.json` : defaultPath('threads.json'));
  const listOnly = command === 'dashboard' || (command === 'thread' && operation === 'list');
  const threadId = value('--thread-id');
  if (!listOnly && !threadId) throw new Error('THREAD_ID_REQUIRED');
  const result = await readThreadHistory({ harnessPath, threadPath, trajectoryPath, explicitThreadStore,
    listOnly, summariesOnly: command === 'thread', threadId,
    limit: value('--limit') ?? 100, before: value('--before') });
  if (command !== 'dashboard') return result;
  return { ...result, summaryOnly: true, releaseChannel,
    execution: { ok: true, records: [] }, feedback: [], memories: [], dreams: [], plugins: [], pluginVersions: [],
    evolution: { proposals: [], reports: [], control: { enabled: true, changedAtMs: 0 } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runHistoryCommand(process.argv[2]))); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
}

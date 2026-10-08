// Keep a pending I/O deadline alive, but release its timer as soon as either
// branch settles. This changes no filesystem policy or timeout duration.
export const withWorkspaceIoTimeout = async (promise, label, timeoutMs = 60000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`WORKSPACE_IO_TIMEOUT:${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
};

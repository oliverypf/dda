/**
 * Provider-neutral execution port.  Model adapters and Cordis plugins should
 * depend on this interface rather than on child_process or fs directly.
 */
export class ExecutorPort {
  async execute(_action, _request, _options = {}) {
    throw new Error('EXECUTOR_NOT_IMPLEMENTED');
  }

  async shell(request, options = {}) {
    return this.execute('shell', request, options);
  }

  async writeFile(request, options = {}) {
    return this.execute('write_file', request, options);
  }

  async test(request, options = {}) {
    return this.execute('test', request, options);
  }
}

export const isExecutorPort = (value) => value !== null && typeof value === 'object'
  && typeof value.execute === 'function';

import { cordisPlugin } from './cordis-plugin.mjs';
import { registerExecutorTools } from '../controlled-tools.mjs';

/** Provide the host-owned safety boundary and executor as Cordis services. */
export const executorPlugin = (executor) => cordisPlugin((ctx) => {
  if (!executor || typeof executor.shell !== 'function' || typeof executor.writeFile !== 'function' || typeof executor.test !== 'function') {
    throw new TypeError('EXECUTOR_PORT_INVALID');
  }
  ctx.provide('executor', executor);
  if (executor.monitor) ctx.provide('safetyMonitor', executor.monitor);
}, 'executor-windows');

/** Register model-facing side-effect tools only after registry and executor injection. */
export const executorToolsPlugin = ({ leaseProvider, onLeaseStarted, onLeaseConsumed, onLeaseFailed, networkAdapter } = {}) => cordisPlugin((ctx) => {
  registerExecutorTools(ctx.toolRegistry, ctx.executor, { leaseProvider, onLeaseStarted, onLeaseConsumed, onLeaseFailed, networkAdapter });
}, 'executor-tools', ['toolRegistry', 'executor']);

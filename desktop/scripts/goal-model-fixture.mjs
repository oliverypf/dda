import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';

export { TASK_SET_VERSION, GOAL_TASKS } from './goal-task-set.mjs';

export const flattenGoalTools = (tools, namespace) => (tools ?? []).flatMap(tool => tool.type === 'namespace'
  ? flattenGoalTools(tool.tools, tool.name)
  : [{ ...tool, name: namespace ? `${namespace}.${tool.name}` : tool.name }]);

export const emitGoalResponse = (res, rawOutput, usage, model = 'evidence-fixture') => {
  const outputs = Array.isArray(rawOutput) ? rawOutput : [rawOutput];
  const id = `resp_${randomUUID()}`;
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model, output: outputs, usage };
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
  for (const [index, output] of outputs.entries()) {
  const itemEvents = [{ type: 'response.output_item.added', output_index: 0, item: output.type === 'function_call' ? { ...output, arguments: '' } : { ...output, content: [] } }];
  if (output.type === 'function_call') {
    itemEvents.push({ type: 'response.function_call_arguments.delta', item_id: output.id, output_index: 0, delta: output.arguments },
      { type: 'response.function_call_arguments.done', item_id: output.id, output_index: 0, arguments: output.arguments });
  } else {
    itemEvents.push({ type: 'response.content_part.added', item_id: output.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: output.id, output_index: 0, content_index: 0, delta: output.content[0].text },
      { type: 'response.output_text.done', item_id: output.id, output_index: 0, content_index: 0, text: output.content[0].text },
      { type: 'response.content_part.done', item_id: output.id, output_index: 0, content_index: 0, part: output.content[0] });
  }
  itemEvents.push({ type: 'response.output_item.done', output_index: 0, item: output });
  events.push(...itemEvents.map(event => ({ ...event, output_index: index })));
  }
  events.push({ type: 'response.completed', response });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
};

export const startGoalFixture = async () => {
  let active;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!active) throw Error('NO_ACTIVE_BENCHMARK_RUN');
      const count = active.requests.length;
      const task = active.task;
      const input = JSON.stringify(body.input ?? '');
      const results = (Array.isArray(body.input) ? body.input : []).filter(item => item.type === 'function_call_output');
      let output;
      let toolKind;
      const planner = /Planner role/iu.test(String(body.instructions ?? ''));
      if (planner) {
        output = { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [],
          text: JSON.stringify({ planId: `plan-${task.taskId}`, steps: [{ stepId: 'inspect', summary: task.prompt, actionKind: 'READ' }], assumptions: [], acceptanceCriteria: [task.prompt] }) }] };
      } else if (task.acceptance === 'code') {
        const tools = flattenGoalTools(body.tools);
        const phase = active.codePhase ?? 0;
        const lastPhase = task.target === 'tags.mjs' ? 4 : 3;
        const recoveryNeedsTest = phase >= lastPhase && results.length === 0;
        if (phase < lastPhase || recoveryNeedsTest) {
          const write = phase === 1;
          const args = write ? { path: task.target, content: task.solution }
            : { command: 'node', args: phase === 0 ? task.initialCommand : phase === 2 && task.target === 'tags.mjs' ? ['--check', task.target] : ['--test', '--test-isolation=none'] };
          const tool = tools.find(item => write ? /file.*write/i.test(item.name) : /test.*execute/i.test(item.name))
            ?? tools.find(item => /(?:exec_command|shell_command|shell)$/i.test(item.name));
          if (!tool) throw Error('NO_ENGINEERING_TOOL');
          let callArgs = args;
          if (!/file.*write|test.*execute/i.test(tool.name)) {
            const command = write ? `Set-Content -LiteralPath '${task.target}' -Value '${task.solution.trimEnd().replaceAll("'", "''")}'`
              : `node ${args.args.join(' ')}`;
            callArgs = 'cmd' in (tool.parameters?.properties ?? {}) ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 3000 } : { command };
          }
          output = { type: 'function_call', id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: tool.name, arguments: JSON.stringify(callArgs), status: 'completed' };
          if (!recoveryNeedsTest) active.codePhase = phase + 1;
          toolKind = write ? 'CODE_WRITE' : 'TEST_OR_SYNTAX';
        } else {
          output = { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Code repaired and the real test command completed successfully.', annotations: [] }] };
        }
      } else if (results.length === 0 || (task.recoverable && !results.some(item => JSON.stringify(item.output).includes('GOAL_EVIDENCE_')))) {
        const tools = flattenGoalTools(body.tools);
        const missing = task.recoverable && !active.missingInjected;
        if (missing) active.missingInjected = true;
        const layout = task.acceptance === 'layout';
        const path = missing ? 'missing-evidence.txt' : 'README.md';
        const tool = tools.find(item => layout ? /workspace.*list/i.test(item.name) : /workspace.*read/i.test(item.name))
          ?? tools.find(item => /(?:exec_command|shell_command|shell)$/i.test(item.name));
        if (!tool) throw Error(`NO_COMPATIBLE_TOOL: ${tools.map(item => item.name).join(',')}`);
        let args;
        if (/workspace/i.test(tool.name)) args = { path: layout ? '' : path };
        else {
          const command = layout ? 'Get-ChildItem -Name' : `Get-Content -LiteralPath '${path}'`;
          const props = tool.parameters?.properties ?? {};
          args = 'cmd' in props ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 2000 } : { command };
        }
        output = { type: 'function_call', id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: tool.name, arguments: JSON.stringify(args), status: 'completed' };
        toolKind = missing ? 'MISSING_READ' : layout ? 'LIST' : 'README_READ';
      } else {
        // The answer is derived from the client-returned tool result. A
        // fabricated final sentence alone cannot pass the external grader.
        const marker = results.map(item => JSON.stringify(item.output)).join('\n').match(/GOAL_EVIDENCE_[a-f0-9]+/u)?.[0];
        const text = task.acceptance === 'layout'
          ? ['README.md', 'package.json', 'name.mjs', 'name.test.mjs'].filter(name => input.includes(name)).join(', ')
          : marker ?? 'No tool evidence marker was returned.';
        output = { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }] };
      }
      const usage = { input_tokens: 16, output_tokens: 8, total_tokens: 24, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
      active.requests.push({ sequence: count + 1, body, output, toolKind, usage });
      emitGoalResponse(res, output, usage);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const port = await listenOnFetchablePort(server);
  return { endpoint: `http://127.0.0.1:${port}/responses`, model: 'evidence-fixture', mode: 'fixture', privateEnvKeys: [],
    begin(task) { active = { task, requests: [] }; return active; },
    close: () => new Promise(done => server.close(done)) };
};

import { ModelUsage } from '../models/CodexTypes';

export interface ModelFunctionCall {
  name: string;
  arguments: string;
}

export interface ModelToolCall {
  id: string;
  type: string;
  function: ModelFunctionCall;
}

export interface ModelMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
  images?: string[];
  responseItems?: Object[];
  usage?: ModelUsage;
}

interface ToolFragment {
  index?: number;
  id?: string;
  function?: ModelFunctionCall;
}

interface AnswerFragment {
  content?: string;
  refusal?: string;
  tool_calls?: ToolFragment[];
}

interface AnswerChoice {
  index?: number;
  delta?: AnswerFragment;
  message?: AnswerFragment;
  finish_reason?: string;
}

interface CompletionFrame {
  choices?: AnswerChoice[];
  error?: Object;
  usage?: ChatUsage;
}

export interface InputTokenDetails {
  cached_tokens?: number;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: InputTokenDetails;
}

export function reportedUsage(input?: number, output?: number, cached?: number): ModelUsage | undefined {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 ||
    typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) { return undefined; }
  const usage: ModelUsage = { inputTokens: input, outputTokens: output };
  if (typeof cached === 'number' && Number.isSafeInteger(cached) && cached >= 0 && cached <= input) {
    usage.cachedTokens = cached;
  }
  return usage;
}

// HTTP chunks may split either an SSE event or a UTF-8 code point. The caller
// incrementally decodes bytes; this class frames complete SSE events.
export abstract class ModelEventStream {
  private buffer: string = '';
  private eventData: string[] = [];
  private received: number = 0;
  private jsonResponse: boolean = false;
  protected done: boolean = false;
  private eventName: string = '';
  protected abstract frame(payload: string, eventName: string): void;
  abstract finish(): ModelMessage;

  push(chunk: string): void {
    this.received += chunk.length;
    if (this.received > 4 * 1024 * 1024) {
      throw new Error('模型返回的数据过大，请缩小任务后重试。');
    }
    this.buffer += chunk;
    if (this.jsonResponse || this.buffer.trimStart().startsWith('{')) {
      this.jsonResponse = true;
      return;
    }
    let end = this.buffer.indexOf('\n');
    while (end >= 0) {
      const line = this.buffer.substring(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.substring(end + 1);
      this.line(line);
      end = this.buffer.indexOf('\n');
    }
  }

  private line(value: string): void {
    if (!value) {
      this.dispatchEvent();
    } else if (value.startsWith('data:')) {
      this.eventData.push(value.substring(5).trimStart());
    } else if (value.startsWith('event:')) {
      this.eventName = value.substring(6).trim();
    }
  }

  private dispatchEvent(): void {
    const name = this.eventName;
    this.eventName = '';
    if (!this.eventData.length) { return; }
    const payload = this.eventData.join('\n');
    this.eventData = [];
    if (payload.trim() === '[DONE]') {
      this.done = true;
    } else if (!this.done) {
      this.frame(payload, name);
    }
  }

  protected finishInput(): void {
    if (this.jsonResponse) {
      this.frame(this.buffer, '');
    } else {
      this.line(this.buffer.replace(/\r$/, ''));
      this.dispatchEvent();
    }
  }
}

export class ChatCompletionStream extends ModelEventStream {
  private finishReason: string = '';
  private text: string = '';
  private calls: ModelToolCall[] = [];
  private usage?: ModelUsage;
  private readonly onText: (value: string) => void;

  constructor(onText: (value: string) => void) {
    super();
    this.onText = onText;
  }

  protected frame(payload: string, _eventName: string): void {
    const data = JSON.parse(payload) as CompletionFrame;
    if (!data || data.error) { throw new Error('模型服务返回了错误，任务未完成。'); }
    if (data.usage) {
      this.usage = reportedUsage(data.usage.prompt_tokens, data.usage.completion_tokens, data.usage.prompt_tokens_details?.cached_tokens);
    }
    const choices = data.choices;
    if (!Array.isArray(choices) || !choices.length) { return; }
    const choice = choices[0];
    if (choice.index !== undefined && choice.index !== 0) { return; }
    const part = choice.delta ?? choice.message;
    const text = part?.content || part?.refusal;
    if (typeof text === 'string' && text.length) {
      this.text += text;
      this.onText(text);
    }
    if (part?.tool_calls) {
      for (let i = 0; i < part.tool_calls.length; i++) {
        const fragment = part.tool_calls[i];
        const index = fragment.index ?? i;
        if (!Number.isInteger(index) || index < 0 || index >= 16 || index > this.calls.length) {
          throw new Error('模型返回了无效的工具调用顺序。');
        }
        if (index === this.calls.length) {
          this.calls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
        }
        const call = this.calls[index];
        if (fragment.id) { call.id = fragment.id; }
        if (fragment.function?.name) { call.function.name += fragment.function.name; }
        if (fragment.function?.arguments) { call.function.arguments += fragment.function.arguments; }
      }
    }
    if (choice.finish_reason) { this.finishReason = choice.finish_reason; }
  }

  finish(): ModelMessage {
    this.finishInput();
    if (!this.done && !this.finishReason) { throw new Error('模型响应提前中断，请重试。'); }
    if (this.finishReason === 'length' || this.finishReason === 'content_filter') {
      throw new Error(this.finishReason === 'length' ? '模型输出达到长度限制，请缩小任务后重试。' : '模型服务中止了本次输出。');
    }
    if (this.calls.length) {
      for (const call of this.calls) {
        if (!call.id || !call.function.name || !call.function.arguments) {
          throw new Error('模型返回了不完整的工具调用。');
        }
      }
      return { role: 'assistant', content: this.text, tool_calls: this.calls, usage: this.usage };
    }
    if (!this.text.trim()) { throw new Error('模型没有返回可显示的回答。'); }
    return { role: 'assistant', content: this.text, usage: this.usage };
  }
}

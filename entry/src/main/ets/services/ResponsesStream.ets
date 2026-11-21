import { ModelUsage } from '../models/CodexTypes';
import { InputTokenDetails, ModelEventStream, ModelMessage, ModelToolCall, reportedUsage } from './ChatCompletionStream';

interface OutputPart {
  type: string;
  text?: string;
  refusal?: string;
}

interface OutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: OutputPart[];
}

interface ProviderResponse {
  status?: string;
  output?: OutputItem[];
  error?: Object;
  usage?: ResponseUsage;
}

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: InputTokenDetails;
}

interface ResponseFrame extends ProviderResponse {
  object?: string;
  type?: string;
  output_index?: number;
  item_id?: string;
  item?: OutputItem;
  arguments?: string;
  delta?: string;
  response?: ProviderResponse;
}

export class ResponsesStream extends ModelEventStream {
  private readonly onText: (text: string) => void;
  private text: string = '';
  private completed: boolean = false;
  private usage?: ModelUsage;
  private items: Map<number, OutputItem> = new Map();

  constructor(onText: (text: string) => void) {
    super();
    this.onText = onText;
  }

  protected frame(payload: string, eventName: string): void {
    const frame = JSON.parse(payload) as ResponseFrame;
    const type = eventName || frame.type || '';
    if (frame.error || type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
      throw new Error('模型服务未能完成本次响应。');
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (typeof frame.delta === 'string') {
        this.text += frame.delta;
        this.onText(frame.delta);
      }
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (frame.item && frame.output_index !== undefined) { this.items.set(frame.output_index, frame.item); }
    } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const item = frame.output_index !== undefined ? this.items.get(frame.output_index) : undefined;
      if (item?.type === 'function_call') {
        if (type.endsWith('.done')) { item.arguments = frame.arguments ?? item.arguments; }
        else { item.arguments = (item.arguments ?? '') + (frame.delta ?? ''); }
      }
    } else if (type === 'response.completed' || type === 'response.done' || frame.object === 'response') {
      const final = frame.response ?? frame;
      if (final.error || (final.status && final.status !== 'completed')) {
        throw new Error('模型响应尚未完成。');
      }
      if (final.output?.length) {
        this.items.clear();
        for (let n = 0; n < final.output.length; n++) { this.items.set(n, final.output[n]); }
      }
      this.usage = reportedUsage(final.usage?.input_tokens, final.usage?.output_tokens, final.usage?.input_tokens_details?.cached_tokens);
      this.completed = true;
    }
  }

  finish(): ModelMessage {
    this.finishInput();
    if (!this.completed) { throw new Error('模型响应提前中断，请重试。'); }
    const calls: ModelToolCall[] = [];
    const items: Object[] = [];
    const ids = new Set<string>();
    let completeText = '';
    const indices: number[] = Array.from(this.items.keys()).sort((a: number, b: number) => a - b);
    for (const index of indices) {
      const item = this.items.get(index);
      if (!item) { continue; }
      if (item.type === 'function_call') {
        if (!item.call_id || !item.name || !item.arguments || ids.has(item.call_id) || calls.length >= 16) {
          throw new Error('模型返回了无效的工具调用。');
        }
        ids.add(item.call_id);
        calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      } else if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text') { completeText += part.text ?? ''; }
          if (part.type === 'refusal') { completeText += part.refusal ?? ''; }
        }
      } else if (item.type !== 'reasoning') {
        continue;
      }
      items.push(item);
    }
    if (completeText.startsWith(this.text) && completeText.length > this.text.length) {
      this.onText(completeText.substring(this.text.length));
      this.text = completeText;
    }
    if (!calls.length && !this.text.trim()) { throw new Error('模型没有返回可显示的回答。'); }
    return { role: 'assistant', content: this.text, tool_calls: calls, responseItems: items, usage: this.usage };
  }
}

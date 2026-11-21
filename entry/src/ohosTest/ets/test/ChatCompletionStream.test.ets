import { describe, it, expect } from '@ohos/hypium';
import { ChatCompletionStream } from '../../../main/ets/services/ChatCompletionStream';
import { ResponsesStream } from '../../../main/ets/services/ResponsesStream';

export default function chatCompletionStreamTest() {
  describe('ResponsesStream', () => {
    it('streams text without duplicating the completed response', 0, () => {
      let text = '';
      const stream = new ResponsesStream((part: string) => { text += part; });
      stream.push('event: response.output_text.delta\ndata: {"delta":"好"}\n\n');
      expect(text).assertEqual('好');
      stream.push('data: {"type":"response.completed","response":{"status":"completed","usage":' +
        '{"input_tokens":7,"output_tokens":2,"input_tokens_details":{"cached_tokens":3}},"output":[' +
        '{"type":"message","content":[{"type":"output_text","text":"好的"}]}]}}\n\n');
      const answer = stream.finish();
      expect(answer.content).assertEqual('好的');
      expect(answer.usage?.inputTokens).assertEqual(7);
      expect(answer.usage?.cachedTokens).assertEqual(3);
      expect(text).assertEqual('好的');
    });

    it('preserves call IDs, completed arguments and opaque reasoning for tool follow-up', 0, () => {
      const stream = new ResponsesStream(() => {});
      stream.push('data: {"type":"response.output_item.done","output_index":0,"item":' +
        '{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"opaque"}}\n\n');
      stream.push('data: {"type":"response.output_item.added","output_index":1,"item":' +
        '{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":""}}\n\n');
      stream.push('data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{"}\n\n');
      stream.push('data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"}"}\n\n');
      stream.push('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      const answer = stream.finish();
      expect(answer.tool_calls?.[0].id).assertEqual('call_1');
      expect(answer.tool_calls?.[0].function.arguments).assertEqual('{}');
      expect(JSON.stringify(answer.responseItems)).assertContain('opaque');
    });

    it('fails an incomplete Responses turn without executing its tool requests', 0, () => {
      const stream = new ResponsesStream(() => {});
      let errorText = '';
      try {
        stream.push('data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n');
        stream.finish();
      } catch (error) { errorText = (error as Error).message; }
      expect(errorText).assertContain('完成');
    });
  });
  describe('ChatCompletionStream', () => {
    it('streams text split across HTTP chunks and ignores SSE comments', 0, () => {
      let liveText = '';
      const stream = new ChatCompletionStream((part: string) => { liveText += part; });
      stream.push(': keep-alive\r\n\r\ndata: {"cho');
      stream.push('ices":[{"delta":{"content":"你好"}}]}\r\n\r\n');
      expect(liveText).assertEqual('你好');
      stream.push('data: [DONE]\n\n');
      expect(stream.finish().content).assertEqual('你好');
    });

    it('assembles fragmented parallel tool calls', 0, () => {
      const stream = new ChatCompletionStream(() => {});
      stream.push('data: {"choices":[{"delta":{"tool_calls":[' +
        '{"index":0,"id":"first","function":{"name":"read_file","arguments":"{"}},' +
        '{"index":1,"id":"second","function":{"name":"list_directory","arguments":"{}"}}]}}]}\n\n');
      stream.push('data: {"choices":[{"delta":{"tool_calls":[' +
        '{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      const calls = stream.finish().tool_calls;
      expect(calls?.length).assertEqual(2);
      expect(calls?.[0].function.arguments).assertEqual('{}');
      expect(calls?.[1].id).assertEqual('second');
    });

    it('accepts a non-streaming JSON completion', 0, () => {
      const stream = new ChatCompletionStream(() => {});
      stream.push('{\n"choices": [{"message":{"content":"完成"}, "finish_reason":"stop"}]}');
      expect(stream.finish().content).assertEqual('完成');
    });

    it('reads the final usage-only chunk and keeps missing cache usage unknown', 0, () => {
      const stream = new ChatCompletionStream(() => {});
      stream.push('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      stream.push('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
      stream.push('data: [DONE]\n\n');
      const usage = stream.finish().usage;
      expect(usage?.inputTokens).assertEqual(12);
      expect(usage?.outputTokens).assertEqual(3);
      expect(usage?.cachedTokens === undefined).assertTrue();
    });

    it('rejects truncated event streams before executing tools', 0, () => {
      const stream = new ChatCompletionStream(() => {});
      stream.push('data: {"choices":[{"delta":{"tool_calls":[' +
        '{"index":0,"id":"one","function":{"name":"create_file","arguments":"{}"}}]}}]}\n\n');
      let message = '';
      try { stream.finish(); } catch (error) { message = (error as Error).message; }
      expect(message).assertContain('中断');
    });
  });
}

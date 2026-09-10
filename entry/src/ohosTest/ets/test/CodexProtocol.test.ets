import { describe, it, expect } from '@ohos/hypium';
import { CodexProtocol } from '../../../main/ets/services/CodexProtocol';

export default function codexProtocolTest() {
  describe('CodexProtocol', () => {
    it('builds the app-server initialize request', 0, () => {
      const raw: string = CodexProtocol.initialize(1, 'hmcodex', '0.1.0');
      const message = CodexProtocol.parse(raw);
      expect(message?.method).assertEqual('initialize');
      expect(message?.id).assertEqual(1);
    });

    it('builds the turn lifecycle request', 0, () => {
      const raw: string = CodexProtocol.turnStart(2, 'thread-1', '检查项目');
      const message = CodexProtocol.parse(raw);
      expect(message?.method).assertEqual('turn/start');
      expect(message?.id).assertEqual(2);
      expect(message?.params?.threadId).assertEqual('thread-1');
    });

    it('builds current and legacy approval responses', 0, () => {
      const current = CodexProtocol.parse(CodexProtocol.approvalResponse(3, true));
      expect(current?.result?.decision).assertEqual('accept');
      expect(CodexProtocol.approvalResponse(4, false, true)).assertContain('denied');
    });

    it('returns null for malformed messages', 0, () => {
      expect(CodexProtocol.parse('{not-json')).assertEqual(null);
    });
  });
}

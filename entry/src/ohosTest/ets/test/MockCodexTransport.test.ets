import { describe, it, expect } from '@ohos/hypium';
import {
  ConnectionState,
  SessionEvent,
  SessionEventKind
} from '../../../main/ets/models/CodexTypes';
import { MockCodexTransport } from '../../../main/ets/services/MockCodexTransport';

export default function mockCodexTransportTest() {
  describe('MockCodexTransport', () => {
    it('lists a deterministic workspace tree', 0, async () => {
      const transport: MockCodexTransport = new MockCodexTransport();
      await transport.connect(() => {});
      const entries = await transport.readDirectory('/');
      expect(entries.length).assertEqual(4);
      expect(entries[1].fileName).assertEqual('entry');
      const content: string = await transport.readFile('/README.md');
      expect(content).assertContain('# dda');
      await transport.disconnect();
    });

    it('pauses a command turn until approval is resolved', 0, async () => {
      const transport: MockCodexTransport = new MockCodexTransport();
      let approvalSeen: boolean = false;
      let connectedSeen: boolean = false;
      await transport.connect((event: SessionEvent) => {
        if (event.state === ConnectionState.Connected) {
          connectedSeen = true;
        }
        if (event.kind === SessionEventKind.ApprovalRequired) {
          approvalSeen = true;
          transport.resolveApproval(event.requestId ?? '', true);
        }
      });
      const threadId: string = await transport.startThread();
      await transport.sendTurn(threadId, 'run pwd');
      expect(connectedSeen).assertTrue();
      expect(approvalSeen).assertTrue();
      await transport.disconnect();
    });
  });
}

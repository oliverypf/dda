import { describe, it, expect } from '@ohos/hypium';
import { CodexProtocol } from '../../../main/ets/services/CodexProtocol';
import { permissionResponse, reviewPermissions } from '../../../main/ets/services/RemotePermissionApproval';

export default function codexProtocolTest() {
  describe('CodexProtocol', () => {
    it('builds the app-server initialize request', 0, () => {
      const raw: string = CodexProtocol.initialize(1, 'dda', '0.1.0');
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

    it('returns exactly the reviewed file grants for this turn', 0, () => {
      const message = CodexProtocol.parse('{"params":{"permissions":{"fileSystem":{"entries":[{"path":{"type":"path","path":"/repo/a"},"access":"read"}],"write":["/repo/b"]}}}}');
      const review = reviewPermissions(message?.params?.permissions, '/repo');
      expect(review?.display).assertEqual('仅限当前轮次\n读取 /repo/a\n写入 /repo/b');
      const grant = permissionResponse('requested', review ?? undefined);
      expect(grant).assertContain('"id":"requested"');
      expect(grant).assertContain('"permissions":' + JSON.stringify(message?.params?.permissions));
      expect(grant).assertContain('"scope":"turn"');
      expect(grant.includes('"decision"')).assertFalse();
      expect(permissionResponse(9)).assertContain('"permissions":{}');
    });

    it('denies the entire profile when a permission cannot be reviewed', 0, () => {
      const profiles = [
        '{"fileSystem":{"read":["/repo/a"],"write":["/repo/../outside"]}}',
        '{"fileSystem":{"read":["/repo/a"]},"network":{"enabled":true}}',
        '{"fileSystem":{"entries":[{"access":"read","path":{"type":"special","value":{"kind":"root"}}}]}}',
        '{"fileSystem":{"entries":[{"access":"write","path":{"type":"path","path":"/repo/a"},"extra":true}]}}',
        '{"fileSystem":{"read":["/other/path"]}}',
        '{"network":{"enabled":true}}'
      ];
      for (const raw of profiles) {
        const message = CodexProtocol.parse('{"params":{"permissions":' + raw + '}}');
        expect(reviewPermissions(message?.params?.permissions, '/repo') === null).assertTrue();
      }
    });

    it('returns null for malformed messages', 0, () => {
      expect(CodexProtocol.parse('{not-json')).assertEqual(null);
    });
  });
}

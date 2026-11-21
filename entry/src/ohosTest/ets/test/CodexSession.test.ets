import { describe, it, expect } from '@ohos/hypium';
import {
  CodexTransport, ConnectionState, SessionEventKind, SessionEventListener, WorkspaceEntry
} from '../../../main/ets/models/CodexTypes';
import { CodexSession } from '../../../main/ets/services/CodexSession';

class DeferredTransport implements CodexTransport {
  attempts: number = 0;
  starts: number = 0;
  sentThread: string = '';
  listener?: SessionEventListener;
  finishConnect?: () => void;

  async connect(listener: SessionEventListener): Promise<void> {
    this.attempts++;
    this.listener = listener;
    await new Promise<void>((resolve) => { this.finishConnect = resolve; });
    listener({ kind: SessionEventKind.ConnectionChanged, state: ConnectionState.Connected, id: 'ready' });
  }

  async disconnect(): Promise<void> {
    this.listener?.({ kind: SessionEventKind.ConnectionChanged, state: ConnectionState.Disconnected, id: 'closed' });
  }

  async startThread(): Promise<string> {
    return 'thread-' + ++this.starts;
  }

  async sendTurn(threadId: string, _prompt: string): Promise<string> {
    this.sentThread = threadId;
    return 'turn';
  }

  async readDirectory(_path: string): Promise<WorkspaceEntry[]> { return []; }
  async readFile(_path: string): Promise<string> { return ''; }
  resolveApproval(_requestId: string, _approved: boolean): void {}
}

export default function codexSessionTest() {
  describe('CodexSession', () => {
    it('shares a handshake and publishes ready after the thread is bound', 0, async () => {
      const transport = new DeferredTransport();
      const session = new CodexSession(transport);
      let readyThread = '';
      session.setListener(event => {
        if (event.state === ConnectionState.Connected) { readyThread = session.currentThread(); }
      });
      const connect = session.connect();
      const send = session.sendPrompt('hello');
      const list = session.readDirectory('/');
      expect(transport.attempts).assertEqual(1);
      transport.finishConnect?.();
      await connect;
      await send;
      await list;
      expect(transport.starts).assertEqual(1);
      expect(readyThread).assertEqual('thread-1');
      expect(transport.sentThread).assertEqual('thread-1');
    });

    it('retains the selected conversation across a dropped connection', 0, async () => {
      const transport = new DeferredTransport();
      const session = new CodexSession(transport);
      session.selectThread('saved');
      const connect = session.connect();
      transport.finishConnect?.();
      await connect;
      await transport.disconnect();
      const send = session.sendPrompt('continue');
      transport.finishConnect?.();
      await send;
      expect(transport.attempts).assertEqual(2);
      expect(transport.starts).assertEqual(0);
      expect(transport.sentThread).assertEqual('saved');
    });

    it('ignores late handshakes and events from a replaced transport', 0, async () => {
      const old = new DeferredTransport();
      const next = new DeferredTransport();
      const session = new CodexSession(old);
      let readyCount = 0;
      session.setListener(event => {
        if (event.state === ConnectionState.Connected) { readyCount++; }
      });
      const superseded = session.connect().then(() => false, () => true);
      await session.replaceTransport(next);
      const connect = session.connect();
      next.finishConnect?.();
      await connect;
      old.finishConnect?.();
      expect(await superseded).assertTrue();
      await old.disconnect();
      await session.sendPrompt('still connected');
      expect(readyCount).assertEqual(1);
      expect(old.starts).assertEqual(0);
      expect(next.attempts).assertEqual(1);
      expect(next.sentThread).assertEqual('thread-1');
    });
  });
}

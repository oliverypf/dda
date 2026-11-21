import { describe, expect, it } from '@ohos/hypium';
import { workspaceParts } from '../../../main/ets/services/LocalWorkspace';
import { decodeWorkbenchState, WorkbenchState } from '../../../main/ets/services/WorkbenchStore';
import { MessageRole } from '../../../main/ets/models/CodexTypes';
import { detectImageMime, validAttachments } from '../../../main/ets/services/LocalImages';
import { parseLocalSkill } from '../../../main/ets/services/LocalSkills';

export default function localPersistenceTest() {
  describe('LocalPersistence', () => {
    it('maps only rooted project paths and reserves staged writes', 0, () => {
      expect(workspaceParts('/').length).assertEqual(0);
      expect(workspaceParts('/源码/README.md').join('/')).assertEqual('源码/README.md');
      const rejected = ['relative', '/a/../b', '/./b', '/a//b', '/a/', '/a\\b', '/.pending-test', '/x\u0000'];
      for (const path of rejected) {
        let denied = false;
        try { workspaceParts(path); } catch { denied = true; }
        expect(denied).assertTrue();
      }
    });

    it('recovers drafts and messages and accepts earlier single-project snapshots', 0, () => {
      const state: WorkbenchState = {
        current: { threadId: 'local-1', title: '任务', draft: '继续',
          messages: [{ id: 'm1', role: MessageRole.User, text: '读一下' }] },
        tasks: [], instructions: '中文', memories: ['偏好'], baseUrl: 'https://example.com/v1', model: 'm'
      };
      const loaded = decodeWorkbenchState(JSON.stringify(state));
      expect(loaded.current.messages[0].text).assertEqual('读一下');
      expect(loaded.current.draft).assertEqual('继续');
      expect(loaded.current.projectId === undefined).assertTrue();
      state.projects = [{ id: 'p-123', name: '第二个项目' }];
      state.skills = ['复查'];
      state.current.projectId = 'p-123';
      expect(decodeWorkbenchState(JSON.stringify(state)).current.projectId).assertEqual('p-123');
    });

    it('rejects malformed history without replacing it with an empty session', 0, () => {
      const malformed = ['{}', 'null', '{"current":{"threadId":"x","messages":[null]}}'];
      for (const source of malformed) {
        let rejected = false;
        try { decodeWorkbenchState(source); } catch { rejected = true; }
        expect(rejected).assertTrue();
      }
    });

    it('checks image content type and prevents unsafe saved file references', 0, () => {
      const webp = new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76]);
      expect(detectImageMime(webp)).assertEqual('image/webp');
      expect(detectImageMime(new Uint8Array([255, 216, 255, 224]))).assertEqual('image/jpeg');
      const id = '01234567-89ab-4def-abcd-0123456789ab.jpg';
      expect(validAttachments([{ id: id, name: '示意图.jpg', mime: 'image/jpeg' }])).assertTrue();
      expect(validAttachments([{ id: '../' + id, name: 'x', mime: 'image/jpeg' }])).assertFalse();
      expect(validAttachments([{ id: id, name: 'x', mime: 'image/png' }])).assertFalse();
    });

    it('imports Markdown instructions and rejects an empty or malformed skill', 0, () => {
      const skill = parseLocalSkill('---\r\nname: "Review"\r\ndescription: >\r\n  Review this\r\n  project\r\n---\r\n# Review\r\nFirst read the tests.');
      expect(skill.name).assertEqual('Review');
      expect(skill.description).assertEqual('Review this project');
      expect(skill.body).assertContain('First read the tests.');
      const invalid = ['# Plain markdown', '---\nname: A\n---\nBody', '---\nname: A\ndescription: B\n---\n '];
      for (const value of invalid) {
        let rejected = false;
        try { parseLocalSkill(value); } catch { rejected = true; }
        expect(rejected).assertTrue();
      }
    });
  });
}

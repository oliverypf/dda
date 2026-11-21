import { describe, expect, it } from '@ohos/hypium';
import { parseProjectCommand, validateProjectCommand } from '../../../main/ets/services/LocalCommandExecutor';
import { checkJavaScript } from '../../../main/ets/services/LocalJavaScriptCheck';

export default function projectCommandsTest() {
  describe('Native project commands', () => {
    it('keeps a quoted project path as one argument', 0, () => {
      const command = parseProjectCommand('git hash-object "my files/note.txt"');
      expect(command.command).assertEqual('git');
      expect(command.args.length).assertEqual(2);
      expect(command.args[1]).assertEqual('my files/note.txt');
      expect(validateProjectCommand('npm', ['install']).length > 0).assertTrue();
    });

    it('checks JavaScript module syntax without evaluating the source', 0, () => {
      expect(checkJavaScript('/main.mjs', 'export const result = 1; throw Error("must never run");')).assertEqual('');
      expect(checkJavaScript('/main.mjs', 'export const result = ;')).assertContain('/main.mjs:1:');
    });
  });
}

import abilityTest from './Ability.test'
import codexProtocolTest from './CodexProtocol.test'
import mockCodexTransportTest from './MockCodexTransport.test'
import codexSessionTest from './CodexSession.test'
import chatCompletionStreamTest from './ChatCompletionStream.test'
import localPersistenceTest from './LocalPersistence.test'
import projectCommandsTest from './ProjectCommands.test'

export default function testsuite() {
  abilityTest()
  codexProtocolTest()
  mockCodexTransportTest()
  codexSessionTest()
  chatCompletionStreamTest()
  localPersistenceTest()
  projectCommandsTest()
}

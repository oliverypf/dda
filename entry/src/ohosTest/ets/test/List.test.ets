import abilityTest from './Ability.test'
import codexProtocolTest from './CodexProtocol.test'
import mockCodexTransportTest from './MockCodexTransport.test'

export default function testsuite() {
  abilityTest()
  codexProtocolTest()
  mockCodexTransportTest()
}

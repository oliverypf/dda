// Only tool receipts from this run can establish that an installation occurred.
export function installationEvidenceGap(goal, actions, { required } = {}) {
  if (required === false) return undefined;
  const instruction = String(goal ?? '').trim();
  const requestsInstall = /^(?:(?:请|麻烦|帮我|帮忙|给我|直接|现在|需要|重新|在(?:这台|本)[^，。]{0,12})\s*)*安装\s*\S/iu.test(instruction)
    || /^(?:please\s+)?(?:install|reinstall)\s+\S/iu.test(instruction)
    || /(?:需要|帮我|请|给我)安装[^。！？\n]*(?:软件|查看器|客户端|应用|浏览器)/u.test(instruction);
  if (required !== true && (!requestsInstall || /(?:[?？]$|安装(?:说明|教程|指南|方法|步骤|失败|报错|了吗)|不要安装|无需安装|不用安装|是否安装|需要安装吗|怎么|如何|how (?:can|do|to)|instructions|guide)/iu.test(instruction))) return undefined;
  const namedPackage = /(?:安装\s*|\binstall\s+)([a-z0-9][a-z0-9._+-]*)[。!！]?$/iu.exec(instruction)?.[1]?.toLowerCase();
  const installed = actions.some(action => {
    if (action.state !== 'SUCCEEDED' || action.invocationAttempted === false || action.name !== 'shell.execute') return false;
    const cmd = String(action.command ?? '').split(/[\\/]/u).at(-1).replace(/\.exe$/iu, '').toLowerCase();
    const args = Array.isArray(action.args) ? action.args.map(String) : [];
    if (args.some(arg => /^(?:--(?:help|dry-run|simulate|what-if|download-only)|-h|\/\?)$/iu.test(arg))) return false;
    if (['apt', 'apt-get'].includes(cmd) && args.includes('-s')) return false;
    if (args.at(-1) === '--version') return false;
    if (namedPackage && !args.some(arg => arg.toLowerCase().includes(namedPackage))) return false;
    return (['winget', 'choco', 'scoop', 'apt', 'apt-get', 'brew', 'dnf', 'yum', 'zypper', 'pip', 'pip3', 'npm', 'pnpm', 'gem'].includes(cmd) && args.includes('install'))
      || (cmd === 'msiexec' && args.some(arg => /^\/i$/iu.test(arg)));
  });
  return installed ? undefined : 'No successful software installation was observed.';
}

export function directResponseSatisfied(prompt, answer, images, actions) {
  if (actions.length || !answer?.trim()) return false;
  const exact = /^(?:please\s+)?(?:reply|respond|answer|say)(?:\s+(?:only|exactly|with))*\s+["“]?([^"”\n]{1,120})["”]?$/iu.exec(prompt.trim())
    ?? /^(?:请)?(?:只|仅)?(?:回复|回答|输出)[：:\s]*[“"]?([^”"\n]{1,120})[”"]?$/u.exec(prompt.trim());
  if (exact && answer.trim() === exact[1].trim()) return true;
  if (!images.length || /(?:无法|不能|未能)(?:查看|读取|看到|分析)(?:这张|该|所附)?(?:图|截图)|\b(?:can(?:not|'t)|unable to) (?:see|view|access|analy[sz]e) (?:the |this )?(?:image|screenshot)/iu.test(answer)) return false;
  if (/^(?:(?:图片|截图)?已(?:收到|识别)(?:粘贴|所附)?(?:的)?(?:图片|截图)?|(?:image|screenshot) (?:received|ok)|(?:ok|好的))[。.!！\s]*$/iu.test(answer.trim())) return false;
  return /^(?:请结合所附图片分析并处理。|(?:请)?(?:分析|描述|解释)(?:一下)?这(?:张|幅)(?:截图|图片|照片)[。！]?)$/u.test(prompt.trim());
}

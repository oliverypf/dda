/**
 * Turn browser worker failures into a stable code plus a short remedy.
 * Unstructured Playwright text otherwise collapses to "handler failed", so the
 * task shows a failure without saying what to do.
 */

const REMEDIES = Object.freeze({
  BROWSER_NOT_INSTALLED: '浏览器组件未安装，页面没有打开。请在 dda 的 runtime 目录（里面有 node_modules/playwright）执行 npx playwright install chromium，装好后重新发起任务。',
  BROWSER_RUNTIME_MISSING: '找不到 playwright 包，页面没有打开。请在 dda 的 runtime 目录执行 npm install，然后执行 npx playwright install chromium，再重试。',
  BROWSER_NAVIGATION_TIMEOUT: '页面在时限内没有加载完。可以稍后重试，或改用网络请求读取同一个地址。',
  BROWSER_NAVIGATION_FAILED: '页面没有打开，网络连接失败。请检查本机网络后重试，或改用网络请求读取同一个地址。',
  BROWSER_URL_INVALID: '页面地址不是合法的 http(s) 链接。请换一个完整网址。',
  BROWSER_TARGET_FORBIDDEN: '这个地址不能用浏览器打开。请换一个公网 http(s) 页面，或改用网络请求。',
  BROWSER_WORKER_UNAVAILABLE: '浏览器进程没有启动。请重试；若仍失败，在 dda 的 runtime 目录执行 npx playwright install chromium。',
  BROWSER_ALLOWLIST_INVALID: '还没有可用的网站许可，浏览器没有启动。'
});

const oneLine = (value, max = 180) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f╔╗╚╝║═╭╮╯╰│─]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const safeDetail = (value) => oneLine(value, 160)
  .replace(/https?:\/\/\S+/giu, (url) => url.split('?')[0])
  .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[secret]');

const codedError = (code, detail) => {
  const text = typeof detail === 'string' ? oneLine(detail, 500) : '';
  return new Error(text ? `${code}: ${text}` : code);
};

/**
 * @param {unknown} error
 * @returns {Error}
 */
export const describeBrowserFailure = (error) => {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const structured = /^([A-Z][A-Z0-9_]{1,96})(?::([\s\S]*))?$/u.exec(raw.trim());
  if (structured && !structured[1].startsWith('BROWSER_')) {
    return error instanceof Error ? error : new Error(raw.trim());
  }
  if (structured) {
    const detail = oneLine(structured[2] ?? '', 500);
    if (detail) return codedError(structured[1], detail);
    return codedError(structured[1], REMEDIES[structured[1]]);
  }
  const text = oneLine(raw, 500);
  if (/executable doesn't exist|download new browsers|npx playwright install/iu.test(text)) {
    return codedError('BROWSER_NOT_INSTALLED', REMEDIES.BROWSER_NOT_INSTALLED);
  }
  if (/cannot find (?:package|module) ['"]playwright['"]/iu.test(text)) {
    return codedError('BROWSER_RUNTIME_MISSING', REMEDIES.BROWSER_RUNTIME_MISSING);
  }
  if (/timeout \d+ms exceeded/iu.test(text)) {
    return codedError('BROWSER_NAVIGATION_TIMEOUT', REMEDIES.BROWSER_NAVIGATION_TIMEOUT);
  }
  if (/net::ERR_|NS_ERROR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/iu.test(text)) {
    return codedError('BROWSER_NAVIGATION_FAILED', REMEDIES.BROWSER_NAVIGATION_FAILED);
  }
  if (/^invalid url\b/iu.test(text)) {
    return codedError('BROWSER_URL_INVALID', REMEDIES.BROWSER_URL_INVALID);
  }
  const detail = safeDetail(text);
  return codedError('BROWSER_WORKER_FAILED', detail
    ? `浏览器没有打开：${detail}`
    : '浏览器没有打开，也没有返回具体原因。请重试；若仍失败，在 dda 的 runtime 目录执行 npx playwright install chromium。');
};

export const browserFailureRemedies = REMEDIES;

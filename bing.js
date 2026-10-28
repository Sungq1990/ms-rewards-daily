// content script：运行在 www.bing.com / cn.bing.com（油猴"自动搜索"脚本所在的页面）
// 职责：定位油猴脚本注入的"开始自动搜索"按钮并点击，触发自动搜索；
// 以及轮询按钮状态供后台判断脚本是否仍在运行。
// 注意：本脚本只应答自己的命令，对未知命令保持沉默，避免与同页其他内容脚本抢答。

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findControl() {
    const byId = document.getElementById('start-search-btn');
    if (byId) return byId;
    // 兜底：按文本查找（兼容按钮被重命名/包裹的情况）
    const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
    return (
      all.find((el) => {
        const t = (el.innerText || '').trim();
        return t === '开始自动搜索' || t === '停止搜索';
      }) || null
    );
  }

  async function triggerUserscript() {
    // 油猴脚本注入 UI 有延迟，最多等待约 30 秒
    for (let i = 0; i < 20; i++) {
      const el = findControl();
      if (el) {
        const text = (el.innerText || '').trim();
        if (text.includes('停止')) return { ok: true, alreadyRunning: true, text };
        if (text.includes('开始自动搜索')) {
          el.click();
          return { ok: true, clicked: true, text };
        }
        return { ok: false, error: `按钮状态未知：${text}` };
      }
      await sleep(1500);
    }
    return { ok: false, error: '未找到油猴“开始自动搜索”按钮（请确认 Tampermonkey 已启用该脚本并匹配此页面）' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const cmd = msg && msg.cmd;
    if (cmd !== 'PING' && cmd !== 'TRIGGER_USERSCRIPT' && cmd !== 'POLL_SEARCH') return false;
    (async () => {
      try {
        switch (cmd) {
          case 'PING':
            sendResponse({ ok: true, url: location.href });
            break;
          case 'TRIGGER_USERSCRIPT': {
            const r = await triggerUserscript();
            sendResponse({ ...r, url: location.href });
            break;
          }
          case 'POLL_SEARCH': {
            const el = findControl();
            sendResponse({
              ok: true,
              present: !!el,
              text: el ? (el.innerText || '').trim() : null,
              url: location.href,
            });
            break;
          }
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  });
})();

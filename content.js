// content script：运行在 rewards.bing.com / rewards.microsoft.com
// 职责：
// 1) 定位"每日活动"区块的 3 个任务卡片并真实点击（带 referrer，服务端据此计分）；
// 2) 定位"必应搜索连续打卡"卡片里的"立即搜索"入口并点击（打开必应新标签页）；
// 3) 搜索打卡完成后，领取页面上出现的"可领取"积分。
// 注意：该页面是 React 应用且懒渲染——需要展开折叠按钮并滚动进视口等待内容出现。
// 关键约束：Chrome 会把隐藏/后台标签页的定时器节流到每分钟一次，所以在页面里 await sleep()
// 等待渲染是不可靠的（60 次循环可能变成一小时）。因此这里的命令全部"扫一次就回"，
// 轮询与等待都交给 background（service worker 的定时器不受页面节流影响）。
// 本脚本只应答自己的命令，对未知命令保持沉默，避免与同页其他内容脚本抢答。

(() => {
  // 展开区块 + 滚动进视口 + 同步扫描任务链接
  // React 水合可能替换 #dailyset 节点，必须每轮重新查询，不能缓存引用

  // 找"每日活动"区块：#dailyset 优先，找不到再按标题文字兜底（防页面改 id）
  function dailySetSection() {
    const ds = document.querySelector('#dailyset');
    if (ds) return ds;
    const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
      .filter((el) => (el.textContent || '').trim().startsWith('每日活动'));
    for (const h of heads) {
      let n = h.parentElement;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        if (n.querySelectorAll('a[href]').length > 0) return n;
      }
    }
    return null;
  }

  // 只点标题旁真正的折叠开关；ⓘ「关于每日活动」是说明按钮，点它没用
  function expandDailySet(ds) {
    for (const b of ds.querySelectorAll('button[aria-expanded="false"]')) {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (/^关于/.test(label)) continue;
      b.click();
      return true;
    }
    return false;
  }

  // 只做一次同步扫描：必要时点开折叠按钮、滚动区块，立即返回（绝不 await）
  function scanDailySet() {
    const ds = dailySetSection();
    if (!ds) {
      window.scrollBy(0, 300);
      return { links: [], rendered: false, reason: '页面上没有 #dailyset 区块' };
    }
    const folded = expandDailySet(ds); // 折叠状态下先点开，否则点击卡片不计分
    const links = Array.from(ds.querySelectorAll('a[href]'));
    if (links.length > 0) return { links, rendered: true, reason: 'ok', folded };
    ds.scrollIntoView({ block: 'center' });
    return {
      links,
      rendered: false,
      reason: folded
        ? '已点开折叠按钮，卡片仍在渲染'
        : `区块已找到但没有任务卡片（button=${ds.querySelectorAll('button').length}）`,
    };
  }

  // 任务列表：{index, text, done, href}（"已完成"标记的卡片跳过不点）
  function tasksFromLinks(links) {
    return links.map((a, index) => {
      const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
      return { index, text: text.slice(0, 60), done: /已完成/.test(text), href: a.href };
    });
  }

  // 失败时的现场信息：页面是否可见、区块在不在、折叠按钮叫什么
  function pageDiag() {
    const ds = dailySetSection();
    return {
      visibility: document.visibilityState,
      focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
      readyState: document.readyState,
      path: location.pathname,
      dailySet: !!ds,
      dailyLinks: ds ? ds.querySelectorAll('a[href]').length : 0,
      folded: ds
        ? Array.from(ds.querySelectorAll('button[aria-expanded="false"]'))
          .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 12))
        : [],
    };
  }

  function collectSummary() {
    const ds = document.querySelector('#dailyset');
    const out = { url: location.href, cards: [], points: null, dailyCounter: null };
    if (ds) {
      out.cards = Array.from(ds.querySelectorAll('a[href]')).map((a) =>
        (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      );
    }
    const bodyText = document.body.innerText || '';
    const m = bodyText.match(/可用积分[\s\S]{0,40}?((?:\d{1,3}(?:,\d{3})+|\d+))/);
    if (m) out.points = m[1];
    const c = bodyText.match(/(\d+)\s*\/\s*(\d+)/g);
    if (c) out.dailyCounter = c.slice(0, 6);
    return out;
  }

  // 按任务描述（含序号）点击；每次重新扫描定位，避免 React 重渲染导致引用失效
  function clickTaskByInfo(task) {
    const r = scanDailySet();
    if (!r.rendered) throw new Error(`每日活动未渲染（${r.reason}）`);
    const target =
      r.links.find((a) => a.href === task.href) ||
      (task.index < r.links.length ? r.links[task.index] : null);
    if (!target) throw new Error('未找到目标任务卡片');
    const text = (target.innerText || '').replace(/\s+/g, ' ').trim();
    if (/已完成/.test(text)) return { skipped: true, href: target.href };
    target.click();
    return { skipped: false, href: target.href, total: r.links.length };
  }

  // ---------- 必应搜索连续打卡 ----------
  // 活动区"每天使用必应搜索"卡片内有一个"立即搜索"链接（target=_blank → bing.com/?form=ML2PCO）。
  // 卡片内容懒渲染，需要先展开折叠按钮并滚动到可视区域。

  function findSearchAnchor() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if ((n.nodeValue || '').trim() === '立即搜索') {
        const a = n.parentElement && n.parentElement.closest('a');
        if (a && /bing\.com/.test(a.href)) return a;
      }
    }
    return document.querySelector('a[href*="form=ML2PCO"]');
  }

  function getSearchCounter() {
    const m = (document.body.innerText || '').match(/搜索\s*[:：]\s*(\d+)\s*\/\s*(\d+)/);
    return m ? { cur: parseInt(m[1], 10), total: parseInt(m[2], 10), text: m[0].replace(/\s+/g, ' ') } : null;
  }

  // 一次同步扫描：找到就返回链接，找不到就点开折叠/滚动一下，立刻返回
  function scanSearchCard() {
    const found = findSearchAnchor();
    if (found) return found;
    // 展开包含"搜索: x/y"计数的卡片按钮
    const btns = Array.from(document.querySelectorAll('button[aria-expanded="false"]'));
    for (const b of btns) {
      const t = (b.innerText || '').replace(/\s+/g, ' ');
      if (/搜索\s*[:：]\s*\d/.test(t)) { b.click(); break; }
    }
    // 滚动到"必应 搜索: x/y"卡片
    const allBtns = Array.from(document.querySelectorAll('button'));
    const bing = allBtns.find((b) => /必应\s*搜索/.test((b.innerText || '').replace(/\s+/g, ' ')));
    if (bing) bing.scrollIntoView({ block: 'center' });
    else window.scrollBy(0, 500);
    return findSearchAnchor();
  }

  // ---------- 领取"可领取"积分 ----------
  // 真实结构（2026-10 实测）：
  //   右上角"可领取 3"卡片里有一个没有 role 的 div「领取 >」（React 绑点击、cursor:pointer），
  //   点它会打开右侧抽屉，抽屉里的黑色按钮「领取积分」才是真正到账的那一下。
  // 所以这里按"精确文案 + 点击 + 找二级确认按钮"的方式做，不依赖固定的 class 名。

  const CLAIM_TEXT = /^(领取|领取积分|领取奖励|领取积分奖励|立即领取|一键领取|点击领取|去领取|领取今天的奖励)$/;
  const CONFIRM_TEXT = /领取积分|立即领取|确认领取|确定|确认/;
  const CLAIM_REJECT = /已领取|领取过|不可领取|无法领取|未满足|领取记录|领取条件|领取说明|领取更多|权益说明/;
  const CLICKABLE = 'button, a, [role="button"], input[type="button"], input[type="submit"], div, span';

  function plainText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // 去掉首尾的箭头/空白，便于和"领取 >"这种文案对齐
  function coreText(t) {
    return t.replace(/^[>›»\s]+/, '').replace(/[>›»\s]+$/, '');
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
  }

  function isClickable(el) {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return true;
    if (el.getAttribute('role') === 'button') return true;
    return getComputedStyle(el).cursor === 'pointer';
  }

  // 只保留最内层元素：容器元素里必然有同名子节点，避免重复点击
  function hasSameTextChild(el, t) {
    return Array.from(el.children).some((d) => plainText(d) === t);
  }

  function claimTriggers() {
    const out = [];
    for (const el of document.querySelectorAll(CLICKABLE)) {
      const raw = plainText(el);
      if (!raw || raw.length > 10 || raw.indexOf('领取') < 0) continue;
      const t = coreText(raw);
      if (!CLAIM_TEXT.test(t)) continue;
      if (CLAIM_REJECT.test(raw)) continue;
      if (isDisabled(el) || !isVisible(el) || !isClickable(el)) continue;
      if (hasSameTextChild(el, raw)) continue;
      out.push({ el, text: t });
    }
    return out;
  }

  // 抽屉/弹窗里的"领取积分"确认按钮
  function findConfirmButton() {
    for (const el of document.querySelectorAll(CLICKABLE)) {
      if (isDisabled(el) || !isVisible(el)) continue;
      const t = plainText(el).replace(/\s+/g, '');
      if (!t || t.length > 14) continue;
      if (!CONFIRM_TEXT.test(t)) continue;
      if (CLAIM_REJECT.test(t)) continue;
      if (!isClickable(el)) continue;
      if (hasSameTextChild(el, plainText(el))) continue;
      return el;
    }
    return null;
  }

  // "可领取"可能是未激活的标签页或折叠面板，先点开；再滚动一圈触发懒渲染（同步完成，不等待）
  function expandClaimAreaSync() {
    for (const el of document.querySelectorAll('[role="tab"], button, [role="button"]')) {
      const t = plainText(el);
      if (!/^可领取/.test(t) || t.length > 10) continue;
      if (isDisabled(el) || !isVisible(el)) continue;
      const sel = el.getAttribute('aria-selected');
      const exp = el.getAttribute('aria-expanded');
      if (sel === 'false' || exp === 'false' || (sel === null && exp === null)) {
        el.click();
        break;
      }
    }
    const y0 = window.scrollY;
    const step = Math.max(400, Math.floor(window.innerHeight * 0.7));
    for (let i = 0; i < 8; i++) window.scrollBy(0, step);
    window.scrollTo(0, Math.max(0, y0));
  }

  // 领取拆成两步，中间的等待交给 background：
  //   SCAN    —— 点一个「领取」（拉开右侧抽屉）
  //   CONFIRM —— 点抽屉里的「领取积分」（真正到账）
  // 这样即使页面定时器被节流到 1 分钟一次，也不会卡死在页面里。
  // 同一文档内跨消息记住点过的元素/文案，避免多轮扫描重复点同一个按钮。
  // 允许同一元素点 2 次（万一抽屉还没渲染出来），同一文案最多 3 次防死循环。
  const claimClickCount = new WeakMap();
  const claimTextCount = new Map();

  function claimScanStep() {
    expandClaimAreaSync();
    const cands = claimTriggers().filter((c) => (claimClickCount.get(c.el) || 0) < 2);
    if (cands.length === 0) return { ok: true, none: true, diag: claimDiagnostics() };
    const c = cands[0];
    const n = (claimTextCount.get(c.text) || 0) + 1;
    if (n > 3) return { ok: true, none: true, diag: claimDiagnostics() };
    claimTextCount.set(c.text, n);
    claimClickCount.set(c.el, (claimClickCount.get(c.el) || 0) + 1);
    try {
      c.el.scrollIntoView({ block: 'center' });
      c.el.click();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, clicked: c.text, remaining: cands.length - 1 };
  }

  function claimConfirmStep() {
    const b = findConfirmButton();
    if (!b) return { ok: true, clicked: null };
    const text = plainText(b).replace(/\s+/g, '');
    try {
      b.click();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, clicked: text };
  }

  // 领取失败时用来判断原因：有没有"可领取"标记、有没有含"领取"的元素
  function claimDiagnostics() {
    const texts = [];
    for (const el of document.querySelectorAll(CLICKABLE)) {
      const t = plainText(el);
      if (t && t.indexOf('领取') >= 0 && t.length <= 14) texts.push(t);
    }
    return {
      claimableMarks: Array.from(document.querySelectorAll('*'))
        .filter((el) => /^可领取/.test(plainText(el)) && plainText(el).length <= 10).length,
      claimTexts: Array.from(new Set(texts)).slice(0, 10),
      triggers: claimTriggers().map((c) => c.text),
    };
  }

  // ---------- 积分赚取页（/earn）的"日常任务" ----------
  // 该页的"日常任务"区块里，每张卡片本身就是一个 a[href]（整块可点），
  // 已完成的卡片文字里带"已完成"；未完成的点击后通常在新标签页打开题目/内容页。

  function earnHeading() {
    const nodes = Array.from(document.querySelectorAll('h1, h2, h3, h4, div, span'));
    const exact = nodes.filter((el) => (el.textContent || '').trim() === '日常任务');
    const pool = exact.length ? exact : nodes.filter((el) => {
      const t = (el.textContent || '').trim();
      return t.startsWith('日常任务') && t.length <= 10;
    });
    // 取后代最少（最像标题本身）的那个
    pool.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    return pool[0] || null;
  }

  function findEarnSection() {
    const h = earnHeading();
    if (!h) return null;
    let node = h;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      node = node.parentElement;
      if (node && node.querySelectorAll('a[href]').length >= 2) return node;
    }
    return null;
  }

  // 一次同步扫描（不等待），找不到区块就滚动一下让 background 下一轮再问
  function scanEarnSection() {
    const sec = findEarnSection();
    if (sec && sec.querySelectorAll('a[href]').length >= 2) return sec;
    if (sec) sec.scrollIntoView({ block: 'center' });
    else window.scrollBy(0, 500);
    return findEarnSection();
  }

  // 卡片里的积分徽标是一个只含数字（可能带 +）的小元素
  function badgePoints(a) {
    for (const el of a.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (/^[+＋]?\d{1,4}$/.test(t)) return Number(t.replace(/^[+＋]/, ''));
    }
    return null;
  }

  function listEarnTasks(sec) {
    const byHref = new Map();
    for (const a of sec.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href) continue;
      const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const label = (a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const text = t.length >= label.length ? t : label;
      const rec = {
        href,
        text: text.slice(0, 80),
        done: /已完成/.test(text),
        points: badgePoints(a),
      };
      // 同一张卡片可能有外层链接 + 内部图片链接，保留信息更全的那条
      const prev = byHref.get(href);
      if (!prev || rec.text.length > prev.text.length) byHref.set(href, rec);
    }
    return Array.from(byHref.values());
  }

  function findEarnTasks() {
    const sec = scanEarnSection();
    if (!sec) return { ok: true, found: false, tasks: [], url: location.href };
    const tasks = listEarnTasks(sec);
    return { ok: true, found: tasks.length > 0, tasks, url: location.href };
  }

  function clickEarnTaskByHref(href) {
    const sec = scanEarnSection();
    if (!sec) throw new Error('未找到"日常任务"区块');
    const links = Array.from(sec.querySelectorAll('a[href]')).filter((a) => a.href === href);
    const target = links.find((a) => !/已完成/.test((a.textContent || ''))) || links[0];
    if (!target) throw new Error('未找到目标任务卡片');
    if (/已完成/.test((target.textContent || ''))) return { skipped: true };
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { skipped: false };
  }

  const MY_CMDS = [
    'PING', 'DIAG', 'TIMER_PROBE', 'FIND_TASKS', 'CLICK_TASK', 'FIND_SEARCH_TASK', 'CLICK_SEARCH',
    'CLAIM_SCAN', 'CLAIM_CONFIRM', 'FIND_EARN_TASKS', 'CLICK_EARN_TASK', 'SUMMARY',
  ];

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const cmd = msg && msg.cmd;
    if (!MY_CMDS.includes(cmd)) return false; // 只应答自己的命令
    (async () => {
      try {
        switch (cmd) {
          case 'PING':
            sendResponse({
              ok: true,
              url: location.href,
              visibility: document.visibilityState,
              timeOrigin: performance.timeOrigin || 0,
            });
            break;
          case 'DIAG':
            sendResponse({ ok: true, diag: pageDiag(), timeOrigin: performance.timeOrigin || 0 });
            break;
          case 'TIMER_PROBE': {
            // 用来判断页面定时器是否被节流：正常情况下几十毫秒就回信
            const t0 = Date.now();
            setTimeout(() => {
              try { sendResponse({ ok: true, ms: Date.now() - t0, visibility: document.visibilityState }); } catch (e) { /* 页面已卸载 */ }
            }, 0);
            break;
          }
          case 'FIND_TASKS': {
            const r = scanDailySet();
            if (!r.rendered) {
              sendResponse({ ok: true, ready: false, reason: r.reason, diag: pageDiag() });
              break;
            }
            const tasks = tasksFromLinks(r.links);
            sendResponse({ ok: true, ready: true, count: tasks.length, tasks, summary: collectSummary() });
            break;
          }
          case 'CLICK_TASK': {
            const r = clickTaskByInfo(msg.task);
            sendResponse({ ok: true, ...r });
            break;
          }
          case 'FIND_SEARCH_TASK': {
            const a = scanSearchCard();
            sendResponse({ ok: true, found: !!a, href: a ? a.href : null, counter: getSearchCounter() });
            break;
          }
          case 'CLICK_SEARCH': {
            const a = scanSearchCard();
            if (!a) { sendResponse({ ok: false, error: '未找到“立即搜索”入口' }); break; }
            const href = a.href;
            a.click();
            sendResponse({ ok: true, href });
            break;
          }
          case 'CLAIM_SCAN':
            sendResponse(claimScanStep());
            break;
          case 'CLAIM_CONFIRM':
            sendResponse(claimConfirmStep());
            break;
          case 'FIND_EARN_TASKS':
            sendResponse(findEarnTasks());
            break;
          case 'CLICK_EARN_TASK': {
            const r = clickEarnTaskByHref(msg.href);
            sendResponse({ ok: true, ...r });
            break;
          }
          case 'SUMMARY':
            sendResponse({ ok: true, summary: collectSummary() });
            break;
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步响应
  });
})();

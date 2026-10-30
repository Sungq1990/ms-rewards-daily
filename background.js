// background service worker：调度（每天随机时间 / 固定间隔+抖动）+ 任务执行主流程 + 标签页管理

const ALARM_RUN = 'mrd-run';
const DASHBOARD_RE = /^https:\/\/rewards\.(bing|microsoft)\.com\/(dashboard)?\??/;
const DEFAULTS = {
  enabled: true,
  mode: 'daily',            // 'daily' 每天一次随机时刻 | 'interval' 固定间隔+抖动
  dailyStart: '08:00',      // 每天随机时间窗口起点
  dailyEnd: '22:00',        // 每天随机时间窗口终点
  intervalMin: 240,         // 间隔模式：每 N 分钟
  jitterPct: 15,            // 间隔模式：随机抖动百分比
  dwellMinSec: 12,          // 任务页最短停留
  dwellMaxSec: 25,          // 任务页最长停留
  searchAfterDaily: true,   // 每日任务完成后触发必应搜索打卡（油猴自动搜索）
  earnAfterDaily: true,     // 每日任务完成后，点击"积分赚取"页日常任务
  searchTimeoutMin: 15,     // 等待自动搜索脚本结束的最长时间（分钟）
  closeSearchTabAfterFinish: true, // 搜索脚本结束后关闭搜索标签页
  claimPointsAfter: true,   // 搜索打卡后领取页面上出现的"可领取"积分
};
let running = false;
let keepAliveTimer = null;

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function keepAlive(on) {
  if (on && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  } else if (!on && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function getSettings() {
  const st = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(st.settings || {}) };
}

async function getState() {
  const st = await chrome.storage.local.get(['lastRun', 'nextRunAt', 'lastClaim']);
  return { lastRun: st.lastRun || null, nextRunAt: st.nextRunAt || null, lastClaim: st.lastClaim || null };
}

async function saveState(patch) {
  await chrome.storage.local.set(patch);
}

function setBadge(text, color = '#d83b01') {
  chrome.action.setBadgeText({ text: text || '' });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    });
  } catch (e) { /* 通知失败不影响主流程 */ }
}

// ---------- 调度 ----------
function parseHM(s) {
  const [h, m] = String(s || '').split(':').map((x) => parseInt(x, 10));
  return { h: isNaN(h) ? 8 : h, m: isNaN(m) ? 0 : m };
}

// 计算下一次运行时间（毫秒时间戳）
function computeNextRun(settings, now = new Date()) {
  if (settings.mode === 'interval') {
    const base = settings.intervalMin * 60000;
    const jitter = Math.max(0, Math.min(80, settings.jitterPct)) / 100;
    const delta = base * (1 + (Math.random() * 2 - 1) * jitter);
    return Date.now() + Math.max(60000, delta);
  }
  // daily：在今天 [start, end] 窗口内随机；若已过则明天同窗口随机
  const s = parseHM(settings.dailyStart);
  const e = parseHM(settings.dailyEnd);
  const startMs = new Date(now); startMs.setHours(s.h, s.m, 0, 0);
  const endMs = new Date(now); endMs.setHours(e.h, e.m, 0, 0);
  const winStart = startMs.getTime() <= endMs.getTime() ? startMs.getTime() : endMs.getTime();
  const winEnd = startMs.getTime() <= endMs.getTime() ? endMs.getTime() : startMs.getTime();
  const todayDone = (st) => !!st && !!st.lastRun && new Date(st.lastRun.startedAt).toDateString() === now.toDateString();
  // 同步读不到 storage，这里由调用方传入 todayAlreadyRun 判断
  return { winStart, winEnd, isToday: true };
}

async function scheduleNext(settings, { skipTodayCheck = false } = {}) {
  const now = Date.now();
  let when;
  if (settings.mode === 'interval') {
    const r = computeNextRun(settings);
    when = r;
  } else {
    const { winStart, winEnd } = computeNextRun(settings);
    const st = await getState();
    // 今天已成功执行过（任何原因：自动/手动/补跑）就排到明天，避免一天内重复跑
    const ranToday = !!st.lastRun && st.lastRun.ok !== false
      && new Date(st.lastRun.startedAt).toDateString() === new Date().toDateString();
    if (!ranToday && winEnd > now) {
      const lo = Math.max(winStart, now);
      when = randInt(lo, Math.max(lo + 60000, winEnd));
    } else {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const { winStart: ts, winEnd: te } = computeNextRun(settings, tomorrow);
      when = randInt(ts, te);
    }
  }
  when = Math.max(now + 15000, when);
  await chrome.alarms.create(ALARM_RUN, { when });
  await saveState({ nextRunAt: when });
  return when;
}

// 浏览器启动/安装时：如果今天的随机时刻已错过且今天没跑过，就补跑一次
chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (!settings.enabled) return;
  const st = await getState();
  const ranToday = !!st.lastRun && new Date(st.lastRun.startedAt).toDateString() === new Date().toDateString();
  const next = st.nextRunAt || 0;
  if (next && next <= Date.now()) {
    runTasks('startup-missed');
  } else if (settings.mode === 'daily' && !ranToday && !next) {
    await scheduleNext(settings);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get('settings');
  if (!cur.settings) await chrome.storage.local.set({ settings: DEFAULTS });
  const settings = await getSettings();
  await scheduleNext(settings);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RUN) {
    (async () => {
      const settings = await getSettings();
      if (!settings.enabled) { await scheduleNext(settings); return; }
      await runTasks('auto');
    })();
  }
});

// ---------- 任务执行 ----------
function findDashboardTabs() {
  return chrome.tabs.query({ url: ['https://rewards.bing.com/*', 'https://rewards.microsoft.com/*'] });
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; cleanup(); resolve(v); } };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const cleanup = () => chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(true); }).catch(() => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

// reload 之后先等它真的进入 loading，再等 complete；
// 否则在页面还没开始跳转时就拿到旧的 "complete"，会在旧文档上操作
async function waitTabReloaded(tabId, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'loading') break;
    await sleep(150);
  }
  return waitTabComplete(tabId, timeoutMs);
}

function sendToTab(tabId, msg, timeoutMs = 40000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({
          ok: false,
          timeout: true,
          error: `页面脚本 ${Math.round(timeoutMs / 1000)} 秒未响应（标签页可能被 Chrome 挂起或节流）`,
        });
      }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: 'no response' });
    });
  });
}

async function waitForContentScript(tabId, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await sendToTab(tabId, { cmd: 'PING' }, 3000);
    if (r.ok) return r;
    await sleep(1200);
  }
  return null;
}

// 页面处于后台/被遮挡时，前台化窗口和标签页是唯一能让 Chrome 停止节流的手段
async function bringToFront(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
    if (!win.focused) await chrome.windows.update(tab.windowId, { focused: true });
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (e) {
    return false;
  }
}

// 重新加载并等到"新文档"就绪：旧文档上发的消息会随导航一起丢失，所以要等 timeOrigin 变化
async function reloadForFresh(tabId, timeoutMs = 45000) {
  const before = await sendToTab(tabId, { cmd: 'PING' }, 2500);
  const oldOrigin = before && before.ok ? before.timeOrigin : 0;
  await chrome.tabs.reload(tabId).catch(() => {});
  await waitTabReloaded(tabId, timeoutMs);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const p = await sendToTab(tabId, { cmd: 'PING' }, 2500);
    if (p && p.ok) {
      if (!oldOrigin || (p.timeOrigin && p.timeOrigin !== oldOrigin)) return p;
    }
    await sleep(500);
  }
  return null;
}

// 页面是否真的可见（hidden 时 Chrome 会把定时器节流到 1 次/分钟）
async function pageDiag(tabId) {
  const d = await sendToTab(tabId, { cmd: 'DIAG' }, 4000);
  return d && d.ok ? d.diag : null;
}

function diagText(diag) {
  if (!diag) return '页面无响应';
  const parts = [`可见性=${diag.visibility || '?'}`];
  if (diag.focused === false) parts.push('窗口未聚焦');
  parts.push(diag.dailySet ? `#dailyset 在，卡片 ${diag.dailyLinks} 个` : '无 #dailyset');
  if (diag.folded && diag.folded.length) parts.push(`仍折叠：[${diag.folded.join(',')}]`);
  return parts.join('，');
}

// 轮询"每日活动"直到卡片渲染出来。页面里的 setTimeout 会被 Chrome 节流，
// 所以等待和重试全部由 background（service worker，不受页面节流影响）来做。
async function findTasksReady(tabId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let tries = 0;
  let unresponsive = 0;
  let reloaded = false;
  let lastReason = '页面未返回结果';
  let lastDiag = null;
  while (Date.now() < deadline) {
    tries++;
    const r = await sendToTab(tabId, { cmd: 'FIND_TASKS' }, 12000);
    if (r && r.ok && r.ready && r.tasks && r.tasks.length) return { ...r, tries };
    if (r && r.timeout) unresponsive++;
    else if (r && r.reason) lastReason = r.reason;
    if (r && r.diag) lastDiag = r.diag;

    // 页面整体无响应（可能被 Chrome 挂起/冻结）：重新加载一次再继续
    if (unresponsive >= 3 && !reloaded) {
      reloaded = true;
      unresponsive = 0;
      await reloadForFresh(tabId, 45000);
      await sleep(1500);
      continue;
    }
    // 每 5 次尝试重新前台化一次，避免窗口最小化/被遮挡导致页面一直 hidden
    if (tries % 5 === 0) await bringToFront(tabId);
    await sleep(2000);
  }
  if (!lastDiag) lastDiag = await pageDiag(tabId);
  const err = new Error(`每日活动未渲染：${lastReason}（${diagText(lastDiag)}；已重试 ${tries} 次）`);
  err.diag = lastDiag;
  throw err;
}

async function waitSearchEntry(tabId, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sendToTab(tabId, { cmd: 'FIND_SEARCH_TASK' }, 12000);
    if (last && last.ok && last.found) return last;
    await sleep(1500);
  }
  return last || { ok: false, error: '未找到“立即搜索”入口' };
}

async function findEarnReady(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sendToTab(tabId, { cmd: 'FIND_EARN_TASKS' }, 12000);
    if (last && last.ok && last.found) return last;
    await sleep(1500);
  }
  return last || { ok: false, error: '未找到“日常任务”区块' };
}


// 等待新任务标签页出现（相对 before 集合的新增页面）
function waitForNewTab(beforeIds, timeoutMs = 20000, urlRe = /^https:\/\/(www|cn)\.bing\.com\//) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tab) => { if (!done) { done = true; chrome.tabs.onCreated.removeListener(onCreated); clearInterval(poll); resolve(tab); } };
    const onCreated = (tab) => { if (tab && !beforeIds.has(tab.id)) finish(tab); };
    chrome.tabs.onCreated.addListener(onCreated);
    // 竞态兜底：轮询对比
    const poll = setInterval(async () => {
      const all = await chrome.tabs.query({});
      const fresh = all.find((t) => !beforeIds.has(t.id) && urlRe.test(t.url || ''));
      if (fresh) finish(fresh);
    }, 800);
    setTimeout(() => finish(null), timeoutMs);
  });
}

const SEARCH_STATUS_TEXT = {
  'already-done': '今日已完成',
  'not-found': '未找到入口',
  'click-failed': '点击失败',
  'no-tab': '未打开搜索页',
  'content-not-ready': '搜索页未就绪',
  'trigger-failed': '未触发油猴',
  triggered: '已触发',
  'already-running': '已在运行',
  finished: '已完成',
  'finished-tab-closed': '已完成',
  'timeout-running': '已触发（仍在运行）',
  error: '出错',
  skipped: '已跳过',
};

// 必应搜索连续打卡：点击"立即搜索"→ 新标签页 → 触发油猴"开始自动搜索"→ 等脚本结束
async function runSearchStep(dashTabId, settings, result, opts = {}) {
  const info = { status: 'skipped', startedAt: Date.now() };
  result.searchStep = info;
  try {
    const find = await waitSearchEntry(dashTabId, 40000);
    info.counterBefore = find && find.counter ? find.counter.text : null;
    if (!find || !find.found) {
      info.status = 'not-found';
      info.error = (find && (find.error || find.reason)) || '未找到“立即搜索”入口';
      return info;
    }
    if (!opts.force && find.counter && find.counter.total > 0 && find.counter.cur >= find.counter.total) {
      info.status = 'already-done';
      return info;
    }

    const tabsBefore = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const click = await sendToTab(dashTabId, { cmd: 'CLICK_SEARCH' }, 20000);
    if (!click || !click.ok) {
      info.status = 'click-failed';
      info.error = (click && click.error) || '点击“立即搜索”失败';
      return info;
    }

    const tab = await waitForNewTab(tabsBefore, 20000);
    if (!tab) {
      info.status = 'no-tab';
      info.error = '未检测到新打开的搜索标签页';
      return info;
    }
    info.tabId = tab.id;
    await waitTabComplete(tab.id, 45000);

    // 等 bing.js 就绪
    let ready = false;
    for (let i = 0; i < 20; i++) {
      const r = await sendToTab(tab.id, { cmd: 'PING' }, 3000);
      if (r && r.ok) { ready = true; break; }
      await sleep(1200);
    }
    if (!ready) {
      info.status = 'content-not-ready';
      info.error = '搜索页脚本未就绪';
      return info;
    }

    // 触发油猴"开始自动搜索"
    const trig = await sendToTab(tab.id, { cmd: 'TRIGGER_USERSCRIPT' }, 45000);
    if (!trig || !trig.ok) {
      info.status = 'trigger-failed';
      info.error = (trig && trig.error) || '触发油猴脚本失败';
      return info;
    }
    info.status = trig.alreadyRunning ? 'already-running' : 'triggered';
    info.triggeredAt = Date.now();
    setBadge('搜索中', '#107c10');
    await notify('微软积分每日任务', '已触发必应自动搜索，等待打卡完成…');

    // 轮询按钮状态直到脚本结束或超时
    const deadline = Date.now() + Math.max(1, settings.searchTimeoutMin || 8) * 60000;
    let absent = 0;
    while (Date.now() < deadline) {
      await sleep(8000);
      const exists = await chrome.tabs.get(tab.id).then(() => true).catch(() => false);
      if (!exists) { info.status = 'finished-tab-closed'; break; }
      const poll = await sendToTab(tab.id, { cmd: 'POLL_SEARCH' }, 5000);
      if (!poll || !poll.ok) continue;
      if (!poll.present) {
        absent++;
        if (absent >= 15) { info.status = 'finished'; break; } // 按钮消失且持续较久（约2分钟），视为结束
        continue;
      }
      absent = 0;
      if (poll.text && poll.text.includes('开始自动搜索')) { info.status = 'finished'; break; }
    }
    info.finishedAt = Date.now();
    if (info.status === 'triggered' || info.status === 'already-running') info.status = 'timeout-running';

    // 结束后关闭搜索标签页（可配置）
    if (settings.closeSearchTabAfterFinish && (info.status === 'finished' || info.status === 'finished-tab-closed')) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }

    // 回读打卡计数（先把仪表盘激活，避免后台节流）
    try {
      await chrome.tabs.update(dashTabId, { active: true });
      await sleep(1500);
      const after = await sendToTab(dashTabId, { cmd: 'FIND_SEARCH_TASK' }, 30000);
      if (after && after.counter) info.counterAfter = after.counter.text;
    } catch (e) { /* 回读失败不影响结果 */ }
    return info;
  } catch (e) {
    info.status = 'error';
    info.error = String((e && e.message) || e);
    return info;
  }
}

const EARN_STATUS_TEXT = {
  clicked: '已点击',
  none: '无需执行',
  error: '出错',
  skipped: '已跳过',
};

// 积分赚取页（/earn）的"日常任务"：与首页每日活动不同，这里要逐张卡片点击
async function runEarnStep(settings, result) {
  const info = { status: 'skipped', startedAt: Date.now(), clicked: 0, tasks: [] };
  result.earnStep = info;
  let tab = null;
  let created = false;
  try {
    const all = await chrome.tabs.query({ url: 'https://rewards.bing.com/*' });
    tab = all.find((t) => /\/earn(\?|#|$)/.test(t.url || '')) || null;
    if (!tab) {
      tab = await chrome.tabs.create({ url: 'https://rewards.bing.com/earn', active: false });
      created = true;
    }
    await bringToFront(tab.id);
    await waitTabComplete(tab.id, 45000);
    if (!(await waitForContentScript(tab.id, 25))) {
      info.status = 'error';
      info.error = '积分赚取页脚本未就绪';
      return info;
    }

    const find = await findEarnReady(tab.id, 45000);
    if (!find || !find.ok) {
      info.status = 'error';
      info.error = (find && find.error) || '定位“日常任务”区块失败';
      return info;
    }
    info.tasks = find.tasks || [];
    if (!find.found) info.reason = find.reason || '未找到“日常任务”区块';
    info.total = info.tasks.length;
    const withPoints = info.tasks.filter((t) => t.points != null).length;
    const pending = info.tasks.filter((t) => !t.done && (withPoints === 0 || t.points != null));
    info.pending = pending.length;
    if (pending.length === 0) {
      info.status = 'none';
      return info;
    }

    for (const task of pending) {
      if (info.clicked >= 10) break;
      const tabsBefore = new Set((await chrome.tabs.query({})).map((t) => t.id));
      const click = await sendToTab(tab.id, { cmd: 'CLICK_EARN_TASK', href: task.href }, 30000);
      if (!click || !click.ok || click.skipped) continue;
      const nt = await waitForNewTab(tabsBefore, 15000, /^https?:\/\//);
      if (nt && nt.id !== tab.id) {
        await waitTabComplete(nt.id, 45000);
        const dwell = randInt(settings.dwellMinSec, Math.max(settings.dwellMinSec, settings.dwellMaxSec));
        await sleep(dwell * 1000);
        chrome.tabs.remove(nt.id).catch(() => {});
      } else {
        // 站内跳转：页面自己被换掉了，等一会儿再拉回积分赚取页
        await sleep(4000);
        const cur = await chrome.tabs.get(tab.id).catch(() => null);
        if (cur && !/\/earn/.test(cur.url || '')) {
          await chrome.tabs.update(tab.id, { url: 'https://rewards.bing.com/earn' }).catch(() => {});
          await waitTabReloaded(tab.id, 45000);
          await waitForContentScript(tab.id, 15);
        }
      }
      info.clicked++;
      setBadge(`赚取${info.clicked}`, '#107c10');
      await sleep(randInt(2500, 6000));
      // 卡片状态会变，重新取一次列表
      const again = await sendToTab(tab.id, { cmd: 'FIND_EARN_TASKS' }, 15000);
      if (again && again.ok && again.tasks) info.tasks = again.tasks;
    }
    info.status = info.clicked > 0 ? 'clicked' : 'none';
    setBadge('✓', '#107c10');
    setTimeout(() => setBadge(''), 6000);
  } catch (e) {
    info.status = 'error';
    info.error = String((e && e.message) || e);
  } finally {
    if (created && tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
  info.finishedAt = Date.now();
  return info;
}

const CLAIM_STATUS_TEXT = {
  claimed: '已领取',
  none: '无可领取项',
  error: '出错',
  skipped: '已跳过',
};

// 领取"可领取"积分：这些奖励是搜索打卡完成后才出现的，所以要先刷新仪表盘再扫描。
// 每一步都是"扫一次就回"，等待放在这里（service worker 的定时器不会被页面节流拖慢）。
async function runClaimStep(dashTabId, result) {
  const info = { status: 'skipped', startedAt: Date.now(), clicked: [] };
  result.claimStep = info;
  const rounds = 8;
  let errors = 0;
  try {
    await bringToFront(dashTabId);
    if (!(await reloadForFresh(dashTabId, 45000))) {
      info.status = 'error';
      info.error = '页面刷新后没有就绪';
      return info;
    }
    await sleep(2000);
    let emptyStreak = 0;
    for (let i = 0; i < rounds; i++) {
      const scan = await sendToTab(dashTabId, { cmd: 'CLAIM_SCAN' }, 20000);
      if (scan && scan.diag) info.diag = scan.diag;
      if (!scan || !scan.ok) {
        // 撞上刷新/页面卡顿时重试一次，连续失败才算错
        if (++errors >= 2) {
          info.status = 'error';
          info.error = (scan && scan.error) || '领取扫描失败';
          return info;
        }
        await sleep(1500);
        continue;
      }
      errors = 0;
      if (scan.none) {
        // 卡片可能还没渲染出来：连扫两轮都空才收工
        if (++emptyStreak >= 2) break;
        await sleep(2500);
        continue;
      }
      emptyStreak = 0;
      if (scan.clicked) info.clicked.push(scan.clicked);
      await sleep(1600);
      // 抽屉/弹窗里的「领取积分」：点到找不到为止
      for (let k = 0; k < 4; k++) {
        const c = await sendToTab(dashTabId, { cmd: 'CLAIM_CONFIRM' }, 15000);
        if (!c || !c.ok || !c.clicked) break;
        await sleep(1200);
      }
      await sleep(600);
    }
    const sum = await sendToTab(dashTabId, { cmd: 'SUMMARY' }, 10000);
    if (sum && sum.ok && sum.summary && sum.summary.points) info.points = sum.summary.points;
    info.status = info.clicked.length > 0 ? 'claimed' : 'none';
  } catch (e) {
    info.status = 'error';
    info.error = String((e && e.message) || e);
  }
  info.finishedAt = Date.now();
  return info;
}

// 只领取积分（手动按钮用）：不点任务、不触发搜索，直接刷新仪表盘并领取
async function runClaimOnly(reason = 'manual-claim') {
  if (running) return { ok: false, error: '已有任务在运行，请稍后再试' };
  running = true;
  keepAlive(true);
  setBadge('...', '#d83b01');
  const result = { ok: true, reason, startedAt: Date.now(), clicked: 0, pointsAfter: null };
  try {
    const existing = await findDashboardTabs();
    const dash = existing.find((t) => /\/dashboard|\/$/.test((t.url || '').replace(/[?#].*$/, ''))) || existing[0];
    const tab = dash || await chrome.tabs.create({ url: 'https://rewards.bing.com/dashboard', active: true });
    await bringToFront(tab.id);
    await waitTabComplete(tab.id);

    await runClaimStep(tab.id, result);
    result.clicked = result.claimStep && result.claimStep.clicked ? result.claimStep.clicked.length : 0;
    const sum = await sendToTab(tab.id, { cmd: 'SUMMARY' }, 10000);
    if (sum.ok && sum.summary && sum.summary.points) result.pointsAfter = sum.summary.points;
    result.ok = result.claimStep.status !== 'error';

    if (result.ok) {
      setBadge(result.clicked ? `+${result.clicked}` : '0', result.clicked ? '#107c10' : '#605e5c');
      setTimeout(() => setBadge(''), 8000);
      await notify('微软积分领取', result.clicked
        ? `已领取 ${result.clicked} 项积分。`
        : '未发现可领取的积分。');
    } else {
      setBadge('!', '#d83b01');
      setTimeout(() => setBadge(''), 8000);
      await notify('微软积分领取失败', result.claimStep.error || '未知错误');
    }
  } catch (e) {
    result.ok = false;
    result.error = String((e && e.message) || e);
    setBadge('!', '#d83b01');
    setTimeout(() => setBadge(''), 8000);
    await notify('微软积分领取失败', result.error);
  } finally {
    result.finishedAt = Date.now();
    await saveState({ lastClaim: result });
    running = false;
    keepAlive(false);
  }
  return result;
}

async function runTasks(reason = 'manual') {
  if (running) return { ok: false, error: '已有任务在运行' };
  running = true;
  keepAlive(true);
  setBadge('...', '#d83b01');
  const settings = await getSettings();
  const result = { ok: true, reason, startedAt: Date.now(), total: 0, clicked: 0, error: null, pointsBefore: null, pointsAfter: null };

  let dashTab = null;
  try {
    // 1. 找到或打开仪表盘
    const existing = await findDashboardTabs();
    const dash = existing.find((t) => /\/dashboard|\/$/.test((t.url || '').replace(/[?#].*$/, ''))) || existing[0];
    if (dash) {
      dashTab = dash;
    } else {
      dashTab = await chrome.tabs.create({ url: 'https://rewards.bing.com/dashboard', active: false });
    }

    // 2. 先记下用户原来的活动标签页（结束后还原），再把这个标签页切到前台并激活窗口：
    //    后台标签页/最小化窗口的定时器和懒渲染会被 Chrome 节流
    let prevTab = null;
    try {
      const activeTabs = await chrome.tabs.query({ active: true, windowId: dashTab.windowId });
      prevTab = activeTabs[0] && activeTabs[0].id !== dashTab.id ? activeTabs[0].id : null;
    } catch (e) { /* 取不到就最后不还原 */ }
    await bringToFront(dashTab.id);

    // 刷新后要等到"新文档"就绪，避免在正在被替换的旧页面上操作
    if (dash) await reloadForFresh(dashTab.id);
    else await waitTabComplete(dashTab.id);

    // 3. 等 content script 就绪
    const ready = await waitForContentScript(dashTab.id);
    if (!ready) throw new Error('无法连接仪表盘页面脚本（请确认已登录微软积分并停留在 rewards.bing.com）');
    result.visibility = ready.visibility || null;

    // 4. 轮询等"每日活动"渲染（等待放在后台，页面里的定时器会被 Chrome 节流）
    const find = await findTasksReady(dashTab.id, 120000);
    const tasks = find.tasks || [];
    result.total = tasks.length;
    result.attempts = find.tries || null;
    result.pending = tasks.filter((t) => !t.done).length;
    result.summary = find.summary || null;
    if (find.summary && find.summary.points) result.pointsBefore = find.summary.points;

    // 5. 逐个点击未完成的任务；点击后的新标签页停留随机时间再关闭
    const pending = tasks.filter((t) => !t.done);
    if (pending.length === 0) {
      result.clicked = 0;
      result.note = '今日任务均已完成，无需执行';
      setBadge('✓', '#107c10');
      setTimeout(() => setBadge(''), 6000);
    }
    for (let i = 0; i < pending.length; i++) {
      const tabsBefore = new Set((await chrome.tabs.query({})).map((t) => t.id));
      const click = await sendToTab(dashTab.id, { cmd: 'CLICK_TASK', task: pending[i] });
      if (!click.ok) {
        result.error = result.error || `任务「${pending[i].text}」点击失败：${click.error}`;
        continue;
      }
      if (click.skipped) continue;
      const taskTab = await waitForNewTab(tabsBefore, 20000);
      if (taskTab) {
        await waitTabComplete(taskTab.id, 45000);
        const dwell = randInt(settings.dwellMinSec, Math.max(settings.dwellMinSec, settings.dwellMaxSec)) * 1000;
        await sleep(dwell);
        chrome.tabs.remove(taskTab.id).catch(() => {});
      } else {
        // 没监测到新标签页（可能被拦截），等待一段时间后继续
        await sleep(randInt(settings.dwellMinSec, settings.dwellMaxSec) * 1000);
      }
      result.clicked++;
      setBadge(`${result.clicked}/${pending.length}`);
      await sleep(randInt(3000, 8000)); // 任务间隔，行为更接近真人
    }

    // 5. 积分赚取页的"日常任务"
    if (settings.earnAfterDaily !== false) {
      await runEarnStep(settings, result);
      // 回到仪表盘，继续后面的搜索打卡
      await chrome.tabs.update(dashTab.id, { active: true }).catch(() => {});
      await sleep(1000);
    }

    // 6. 必应搜索连续打卡：点击"立即搜索"→新标签页→触发油猴自动搜索
    if (settings.searchAfterDaily) {
      await runSearchStep(dashTab.id, settings, result);
    }

    // 7. 领取"可领取"积分（搜索打卡完成后才会出现）
    if (settings.claimPointsAfter !== false) {
      await runClaimStep(dashTab.id, result);
    }

    // 8. 回读结果
    await sleep(2000);
    const sum = await sendToTab(dashTab.id, { cmd: 'SUMMARY' }, 10000);
    if (sum.ok && sum.summary) {
      if (sum.summary.points) result.pointsAfter = sum.summary.points;
      result.afterSummary = sum.summary;
    }
    setBadge('✓', '#107c10');
    setTimeout(() => setBadge(''), 8000);
    const searchNote = result.searchStep && result.searchStep.status
      ? `；搜索打卡：${SEARCH_STATUS_TEXT[result.searchStep.status] || result.searchStep.status}`
      : '';
    const earnNote = result.earnStep && result.earnStep.status
      ? `；赚取任务：${result.earnStep.clicked
        ? `${result.earnStep.clicked} 个`
        : (EARN_STATUS_TEXT[result.earnStep.status] || result.earnStep.status)}`
      : '';
    const claimNote = result.claimStep && result.claimStep.status
      ? `；领取：${result.claimStep.clicked && result.claimStep.clicked.length
        ? `${result.claimStep.clicked.length} 项`
        : (CLAIM_STATUS_TEXT[result.claimStep.status] || result.claimStep.status)}`
      : '';
    await notify('微软积分每日任务', result.clicked > 0
      ? `已执行 ${result.clicked} 个每日任务${result.pointsAfter && result.pointsBefore ? `，积分 ${result.pointsBefore} → ${result.pointsAfter}` : ''}${earnNote}${searchNote}${claimNote}。`
      : (result.note || '每日任务已全部完成') + earnNote + searchNote + claimNote);

    // 9. 还原用户原来的活动标签页（搜索标签页如仍在运行则保持不动）
    if (prevTab != null) {
      chrome.tabs.update(prevTab, { active: true }).catch(() => {});
    }
  } catch (e) {
    result.ok = false;
    result.error = String((e && e.message) || e);
    if (e && e.diag) result.diag = e.diag;
    setBadge('!', '#d83b01');
    setTimeout(() => setBadge(''), 10000);
    await notify('微软积分每日任务失败', result.error);
  } finally {
    result.finishedAt = Date.now();
    await saveState({ lastRun: result });
    running = false;
    keepAlive(false);
    const s = await getSettings();
    if (s.enabled) await scheduleNext(s);
  }
  return result;
}

// ---------- 消息接口（popup 调用） ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.cmd) {
        case 'GET_STATUS': {
          const settings = await getSettings();
          const st = await getState();
          sendResponse({ ok: true, settings, lastRun: st.lastRun, lastClaim: st.lastClaim, nextRunAt: st.nextRunAt, running });
          break;
        }
        case 'RUN_CLAIM': {
          const r = await runClaimOnly(msg.reason || 'manual-claim');
          sendResponse(r);
          break;
        }
        case 'RUN_NOW': {
          const r = await runTasks(msg.reason || 'manual');
          sendResponse(r);
          break;
        }
        case 'SAVE_SETTINGS': {
          const merged = { ...(await getSettings()), ...(msg.settings || {}) };
          await chrome.storage.local.set({ settings: merged });
          await scheduleNext(merged);
          const st = await getState();
          sendResponse({ ok: true, settings: merged, nextRunAt: st.nextRunAt });
          break;
        }
        case 'RESCHEDULE': {
          const s = await getSettings();
          const when = await scheduleNext(s, { skipTodayCheck: true });
          sendResponse({ ok: true, nextRunAt: when });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown cmd' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

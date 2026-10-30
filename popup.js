const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
    else resolve(r);
  }));
}

const SEARCH_TEXT = {
  'already-done': '今日已完成',
  'not-found': '未找到入口',
  'click-failed': '点击失败',
  'no-tab': '未打开搜索页',
  'content-not-ready': '搜索页未就绪',
  'trigger-failed': '未触发油猴',
  triggered: '已触发（后台继续跑）',
  'already-running': '已在运行',
  finished: '已完成',
  'finished-tab-closed': '已完成',
  'timeout-running': '已触发（仍在运行）',
  error: '出错',
  skipped: '已跳过',
};

const CLAIM_TEXT = {
  claimed: '已领取',
  none: '无可领取项',
  error: '出错',
  skipped: '已跳过',
};

const EARN_TEXT = {
  clicked: '已点击',
  none: '无需执行',
  error: '出错',
  skipped: '已跳过',
};

function earnText(step) {
  if (!step || !step.status) return '';
  if (step.clicked) return `已点击 ${step.clicked} 个`;
  if (step.status === 'none') return step.total ? '今日已全部完成' : '未找到任务';
  return EARN_TEXT[step.status] || step.status;
}

function claimText(step) {
  if (!step || !step.status) return '';
  if (step.clicked && step.clicked.length) return `已领取 ${step.clicked.length} 项`;
  return CLAIM_TEXT[step.status] || step.status;
}

function renderStatus(st) {
  const lr = st.lastRun;
  $('lastRun').textContent = lr ? fmtTime(lr.finishedAt || lr.startedAt) : '—';
  if (lr) {
    let res = lr.ok ? `完成 ${lr.clicked}/${lr.total} 个任务` : `失败：${(lr.error || '未知错误').slice(0, 180)}`;
    if (lr.earnStep && lr.earnStep.status) {
      res += `；赚取任务：${earnText(lr.earnStep)}`;
    }
    if (lr.searchStep && lr.searchStep.status) {
      res += `；搜索打卡：${SEARCH_TEXT[lr.searchStep.status] || lr.searchStep.status}`;
    }
    if (lr.claimStep && lr.claimStep.status) {
      res += `；领取：${claimText(lr.claimStep)}`;
    }
    $('lastResult').textContent = res;
    $('lastResult').classList.toggle('bad', !lr.ok || (lr.searchStep && lr.searchStep.status === 'trigger-failed'));
    if (lr.pointsAfter) $('points').textContent = lr.pointsAfter + ' 分';
  }
  $('nextRun').textContent = st.nextRunAt ? fmtTime(st.nextRunAt) : '—';
  $('runningTag').classList.toggle('hidden', !st.running);
  $('runNow').disabled = !!st.running;
  $('claimNow').disabled = !!st.running;

  const s = st.settings || {};
  // 用户正在改表单时不要用已保存的值覆盖输入框（否则 5 秒后的自动刷新会把改动刷回去）
  if (!settingsDirty) {
    $('enabled').checked = !!s.enabled;
    $('earnAfterDaily').checked = s.earnAfterDaily !== false;
    $('searchAfterDaily').checked = s.searchAfterDaily !== false;
    $('searchNoWait').checked = s.searchNoWait !== false;
    $('claimPointsAfter').checked = s.claimPointsAfter !== false;
    $('mode').value = s.mode || 'daily';
    $('dailyStart').value = s.dailyStart || '08:00';
    $('dailyEnd').value = s.dailyEnd || '22:00';
    $('intervalMin').value = s.intervalMin ?? 240;
    $('jitterPct').value = s.jitterPct ?? 15;
    $('dwellMinSec').value = s.dwellMinSec ?? 12;
    $('dwellMaxSec').value = s.dwellMaxSec ?? 25;
    $('searchTimeoutMin').value = s.searchTimeoutMin ?? 15;
  }
  syncModeFields();
}

function syncModeFields() {
  const m = $('mode').value;
  $('dailyFields').classList.toggle('hidden', m !== 'daily');
  $('intervalFields').classList.toggle('hidden', m !== 'interval');
}

// 设置表单是否已被用户改动过；改动过就不再让自动刷新覆盖
let settingsDirty = false;
const FORM_FIELDS = [
  'mode', 'dailyStart', 'dailyEnd', 'intervalMin', 'jitterPct',
  'dwellMinSec', 'dwellMaxSec', 'searchTimeoutMin',
  'earnAfterDaily', 'searchAfterDaily', 'searchNoWait', 'claimPointsAfter',
];
for (const id of FORM_FIELDS) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener('input', () => { settingsDirty = true; });
  el.addEventListener('change', () => { settingsDirty = true; });
}

async function refresh() {
  const st = await send({ cmd: 'GET_STATUS' });
  if (st.ok) renderStatus(st);
}

$('mode').addEventListener('change', syncModeFields);

$('runNow').addEventListener('click', async () => {
  $('runNow').disabled = true;
  $('runningTag').classList.remove('hidden');
  const r = await send({ cmd: 'RUN_NOW', reason: 'manual-popup' });
  $('runningTag').classList.add('hidden');
  if (!r.ok) {
    $('log').textContent = '执行失败：' + (r.error || '未知错误');
    $('log').classList.remove('hidden');
  }
  await refresh();
});

$('claimNow').addEventListener('click', async () => {
  $('claimNow').disabled = true;
  $('runNow').disabled = true;
  $('runningTag').classList.remove('hidden');
  const r = await send({ cmd: 'RUN_CLAIM', reason: 'manual-popup' });
  $('runningTag').classList.add('hidden');
  const log = $('log');
  if (!r.ok) {
    log.textContent = '领取失败：' + (r.error || (r.claimStep && r.claimStep.error) || '未知错误');
    log.style.background = '#fff4f2';
    log.style.borderColor = '#f1c5be';
    log.style.color = '#a4262c';
  } else {
    const n = r.clicked || 0;
    log.textContent = n
      ? `已领取 ${n} 项积分${r.pointsAfter ? `，当前可用积分 ${r.pointsAfter}` : ''}。`
      : '未发现可领取的积分。';
    log.style.background = n ? '#f1faf3' : '#fff4f2';
    log.style.borderColor = n ? '#bfe3c9' : '#f1c5be';
    log.style.color = n ? '#107c10' : '#a4262c';
  }
  log.classList.remove('hidden');
  await refresh();
});

$('saveSettings').addEventListener('click', async () => {
  const settings = {
    enabled: $('enabled').checked,
    earnAfterDaily: $('earnAfterDaily').checked,
    searchAfterDaily: $('searchAfterDaily').checked,
    searchNoWait: $('searchNoWait').checked,
    claimPointsAfter: $('claimPointsAfter').checked,
    mode: $('mode').value,
    dailyStart: $('dailyStart').value || '08:00',
    dailyEnd: $('dailyEnd').value || '22:00',
    intervalMin: Math.max(30, parseInt($('intervalMin').value, 10) || 240),
    jitterPct: Math.max(0, Math.min(80, parseInt($('jitterPct').value, 10) || 15)),
    dwellMinSec: Math.max(5, parseInt($('dwellMinSec').value, 10) || 12),
    dwellMaxSec: Math.max(5, parseInt($('dwellMaxSec').value, 10) || 25),
    searchTimeoutMin: Math.max(1, Math.min(60, parseInt($('searchTimeoutMin').value, 10) || 8)),
  };
  if (settings.dwellMaxSec < settings.dwellMinSec) settings.dwellMaxSec = settings.dwellMinSec;
  const r = await send({ cmd: 'SAVE_SETTINGS', settings });
  if (r.ok) {
    settingsDirty = false;
    $('saveSettings').textContent = '已保存 ✓';
    setTimeout(() => { $('saveSettings').textContent = '保存设置'; }, 1500);
    await refresh();
  }
});

$('enabled').addEventListener('change', async () => {
  await send({ cmd: 'SAVE_SETTINGS', settings: { enabled: $('enabled').checked } });
  await refresh();
});

refresh();
// 运行期间自动刷新状态
setInterval(refresh, 5000);

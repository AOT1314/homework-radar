// 在 GitHub Actions 里跑：从 Supabase 读作业 → 判断临期/逾期 → 推 ntfy。
// 环境变量：RADAR_SPACE（同步空间 UUID）、NTFY_TOPIC（ntfy 主题名）
const SUPABASE_URL = 'https://dgyviuahsopeeiundtvt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_LyrOxLS6G7Dj8vS10mPGWw_kntSN1JM';
const NTFY_SERVER = 'https://ntfy.sh';

const space = (process.env.RADAR_SPACE || '').trim();
const topic = (process.env.NTFY_TOPIC || '').trim();
if (!space) { console.error('缺少 RADAR_SPACE 仓库变量'); process.exit(1); }

const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_assignments`, {
  method: 'POST',
  headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ p_space_id: space, p_changes: [], p_since: 0 }),
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) {
  console.error('读取云端失败:', response.status, (await response.text()).slice(0, 160));
  process.exit(1);
}
const rows = ((await response.json()).changes || []).filter((row) => !row.deleted);
const items = rows.map((row) => row.payload).filter((item) => item?.title && item?.due);

// Bark 的 device key：优先环境变量，其次同步空间里的 config:bark 行（改 key 不用重新部署）
const configRow = rows.find((row) => row.id === 'config:bark');
const barkKey = (process.env.BARK_KEY || configRow?.payload?.key || '')
  .replace(/^https?:\/\/api\.day\.app\//, '')
  .replace(/\/+$/, '')
  .split('/')[0];

// 去重：workflow 挂了三个时间点互为备份，这里保证同一天只推一次
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const lastPush = rows.find((row) => row.id === 'config:last-push')?.payload?.date;
if (lastPush === today) {
  console.log(`今天（${today}）已经推送过，跳过。`);
  process.exit(0);
}

const now = Date.now();
const HOUR = 3600 * 1000;
const open = items.filter((item) => !item.done);
const overdue = open.filter((item) => new Date(item.due).getTime() < now);
const soon = open.filter((item) => {
  const diff = new Date(item.due).getTime() - now;
  return diff >= 0 && diff <= 24 * HOUR;
});
const tomorrow = open.filter((item) => {
  const diff = new Date(item.due).getTime() - now;
  return diff > 24 * HOUR && diff <= 48 * HOUR;
});
const week = open
  .filter((item) => {
    const diff = new Date(item.due).getTime() - now;
    return diff > 48 * HOUR && diff <= 7 * 24 * HOUR;
  })
  .sort((a, b) => new Date(a.due) - new Date(b.due));

const shanghai = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
};

const fmt = (item) => {
  const due = new Date(item.due);
  const remain = (due.getTime() - now) / HOUR;
  const tail = remain < 0 ? `已逾期 ${Math.abs(remain).toFixed(0)}h` : remain < 24 ? `剩 ${remain.toFixed(1)}h` : `剩 ${(remain / 24).toFixed(1)}d`;
  return `· ${shanghai(due)} ${item.subject}｜${item.title}（${tail}）`;
};

const lines = [];
if (overdue.length) lines.push('【已逾期】', ...overdue.map(fmt), '');
if (soon.length) lines.push('【24 小时内】', ...soon.map(fmt), '');
if (tomorrow.length) lines.push('【48 小时内】', ...tomorrow.map(fmt));
if (week.length) lines.push('【未来 7 天】', ...week.slice(0, 5).map(fmt));

if (!lines.length) {
  console.log('48 小时内没有到期作业，今天不推送。');
  process.exit(0);
}

const title = overdue.length
  ? `⚠ 有 ${overdue.length} 项已逾期`
  : soon.length
    ? `⏰ 今天还有 ${soon.length} 项要交`
    : tomorrow.length
      ? '作业雷达 · 明天有截止'
      : '作业雷达 · 今日清单';

// Bark 优先（iOS 即时），ntfy 作为备份
let barkOk = false;
if (barkKey) {
  const bark = await fetch('https://api.day.app/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_key: barkKey,
      title,
      body: lines.join('\n'),
      group: '作业雷达',
      level: overdue.length ? 'timeSensitive' : 'active',
      icon: 'https://aot1314.github.io/homework-radar/icons/icon-192.png',
    }),
    signal: AbortSignal.timeout(20000),
  }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
  barkOk = Boolean(bark.ok);
  console.log(barkOk ? 'Bark 已推送' : `Bark 推送失败 ${bark.status}`);
} else {
  console.log('未配置 Bark key，跳过');
}

if (!topic) {
  console.log('【未配置 NTFY_TOPIC，跳过 ntfy】');
  console.log(title);
  console.log(lines.join('\n'));
  process.exit(barkOk ? 0 : 0);
}

const push = await fetch(`${NTFY_SERVER}/`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    topic,
    title,
    message: lines.join('\n'),
    priority: overdue.length ? 5 : soon.length ? 4 : 3,
    tags: overdue.length ? ['warning', 'books'] : ['books'],
  }),
  signal: AbortSignal.timeout(20000),
});

console.log(title);
console.log(lines.join('\n'));
console.log(push.ok ? 'ntfy 已推送' : `ntfy 推送失败 ${push.status}`);

// 记录今天已推送，避免后面几个 cron 时间点重复打扰
if (push.ok || barkOk) {
  const mark = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_assignments`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      p_space_id: space,
      p_changes: [{ id: 'config:last-push', payload: { date: today, at: new Date().toISOString() }, updatedAt: Date.now(), deleted: false }],
      p_since: 0,
    }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  console.log(mark?.ok ? '已记录今日推送时间' : '记录推送时间失败（不影响本次推送）');
}

process.exit(push.ok || barkOk ? 0 : 1);

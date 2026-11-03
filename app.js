'use strict';
/* 晨读 — all keys stay on this device; there is no server. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const view = $('#view');

/* ---------- storage ---------- */
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const idb = (() => {
  let p; const mem = new Map();
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('chendu', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const q = fn(db.transaction('kv', mode).objectStore('kv'));
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  }));
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => mem.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => mem.set(k, v)),
    keys: () => tx('readonly', s => s.getAllKeys()).catch(() => [...mem.keys()]),
    del: k => tx('readwrite', s => s.delete(k)).catch(() => mem.delete(k))
  };
})();
const keys = () => ls.get('keys', {});
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

/* ---------- network ---------- */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function getJSON(url, name) {
  let r;
  try { r = await fetch(url); }
  catch { throw new ApiError(`连不上${name}。先到设置里核对 key，再检查网络。`); }
  if (r.status === 401 || r.status === 403) throw new ApiError(`${name}的 key 不对。到设置里检查一下。`, r.status);
  if (r.status === 429) throw new ApiError(`${name}今天的请求次数用完了，明天会恢复。`, 429);
  if (!r.ok) throw new ApiError(`${name}返回错误（${r.status}）。`, r.status);
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
/* Streaming keeps slow answers from hitting Safari's request timeout. */
async function readStream(r) {
  let buf = '', text = '';
  const take = line => {
    if (!line.startsWith('data:')) return;
    try { text += (JSON.parse(line.slice(5).trim()).candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''); } catch {}
  };
  if (!r.body?.getReader) { (await r.text()).split(/\r?\n/).forEach(take); return text; }
  const rd = r.body.getReader(), dec = new TextDecoder();
  for (;;) {
    const {done, value} = await rd.read();
    if (done) break;
    buf += dec.decode(value, {stream: true});
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    lines.forEach(take);
  }
  take(buf);
  return text;
}
async function gemini(prompt, json = true) {
  let last;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r, text;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'x-goog-api-key': keys().gemini},
          body: JSON.stringify({contents: [{parts: [{text: prompt}]}], generationConfig: {temperature: .2, ...(json ? {responseMimeType: 'application/json'} : {})}})
        });
        if (r.ok) text = await readStream(r);
      } catch (e) {
        last = new ApiError(`连不上 Gemini（${e.name}：${e.message}）。请让 App 停留在前台再试。`);
        await sleep(1500);
        continue;
      }
      if (r.ok) {
        if (!text) { last = new ApiError('Gemini 没有返回内容。'); break; }
        if (!json) return text.trim();
        try { return JSON.parse(text.replace(/^\s*```(?:json)?|```\s*$/g, '').trim()); }
        catch { last = new ApiError('Gemini 返回的格式不对，再试一次。'); continue; }
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        const body = await r.text();
        if (r.status === 400 && !/api.?key/i.test(body)) { last = new ApiError(`Gemini 拒绝了这次请求（${r.status}）。`); break; }
        throw new ApiError('Gemini 的 key 不对。到设置里检查一下。', r.status);
      }
      last = new ApiError(r.status === 429 ? 'Gemini 请求太频繁或今天额度用完了。' : `Gemini 返回错误（${r.status}）。`, r.status);
      if (r.status === 404) break;
      await sleep(r.status === 429 ? 6000 * (attempt + 1) : 1500);
    }
  }
  throw last;
}

/* Quick translation: no key and no AI quota. AI is kept for choosing stories and explaining words. */
async function gtOne(t) {
  const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(t)}`);
  if (!r.ok) throw new ApiError(`翻译服务返回错误（${r.status}）。`);
  return (await r.json())[0].map(x => x[0]).join('');
}
async function translate(text) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > 1500) {
    let cut = rest.lastIndexOf('. ', 1500);
    if (cut < 300) cut = 1500;
    parts.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  const out = [];
  for (const p of parts) {
    try { out.push(await gtOne(p)); }
    catch { out.push(await gemini(`把这段英文新闻翻译成简体中文，只输出译文：\n${p}`, false)); }
  }
  return out.join('');
}
async function mapLimit(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({length: Math.min(n, list.length)}, async () => {
    while (i < list.length) { const k = i++; await fn(list[k], k); }
  }));
}

/* ---------- sources ---------- */
const GUARDIAN_TOPIC = {'US news': '美国政治', 'World news': '国际', Business: '经济与科技', Technology: '经济与科技', Environment: '气候与环境'};
const topicOf = a => a.topic || GUARDIAN_TOPIC[a.section] || (/politic|^us$|u\.s\./i.test(a.section || '') ? '美国政治' : /world/i.test(a.section || '') ? '国际' : /business|tech|econom/i.test(a.section || '') ? '经济与科技' : /climate|environment|science/i.test(a.section || '') ? '气候与环境' : /art|film|movie|music|book|culture|tv|sport|style/i.test(a.section || '') ? '文化娱乐' : '国际');
async function fetchFeeds() {
  try {
    const r = await fetch(`feeds.json?t=${Math.floor(Date.now() / 3e5)}`);
    if (!r.ok) return [];
    return ((await r.json()).items || []).map(a => ({...a, full: !!a.paras}));
  } catch { return []; }
}
const SECTIONS = 'us-news|world|business|environment|technology|film|tv-and-radio|music|culture|books|sport';
async function fetchGuardian() {
  const from = new Date(Date.now() - 36 * 3600e3).toISOString().slice(0, 10);
  const u = new URLSearchParams({'api-key': keys().guardian, section: SECTIONS, type: 'article', 'from-date': from, 'order-by': 'newest', 'page-size': '60', 'show-fields': 'headline,trailText,byline,wordcount,shortUrl'});
  const d = await getJSON(`https://content.guardianapis.com/search?${u}`, '卫报');
  return (d.response?.results || []).filter(a => +(a.fields?.wordcount || 0) >= 250).map(mapGuardian);
}
async function fetchNYT() {
  if (!keys().nyt) return [];
  const out = [];
  for (const s of ['home', 'arts']) {
    const d = await getJSON(`https://api.nytimes.com/svc/topstories/v2/${s}.json?api-key=${encodeURIComponent(keys().nyt)}`, '纽约时报');
    for (const a of d.results || []) {
      if (!a.title || !a.url || !a.abstract) continue;
      if (Date.now() - new Date(a.published_date) > 48 * 3600e3) continue;
      out.push({source: 'New York Times', side: 'us', full: false, url: a.url, section: a.section, title: a.title, abstract: a.abstract, byline: a.byline || '', date: a.published_date});
    }
  }
  const seen = new Set();
  return out.filter(a => !seen.has(a.url) && seen.add(a.url)).slice(0, 40);
}
function mapGuardian(a) {
  return {source: 'The Guardian', side: 'intl', full: true, gid: a.id, url: a.webUrl, section: a.sectionName, shortUrl: a.fields?.shortUrl || '',
    title: a.fields?.headline || a.webTitle, abstract: stripTags(a.fields?.trailText), byline: a.fields?.byline || '', date: a.webPublicationDate};
}
function stripTags(h) { return new DOMParser().parseFromString(h || '', 'text/html').body.textContent.trim(); }

const TOPICS = ['美国政治', '国际', '经济与科技', '气候与环境', '文化娱乐'];
async function buildBrief() {
  const results = await Promise.allSettled([fetchGuardian(), fetchNYT(), fetchFeeds()]);
  const cands = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (!cands.length) throw new ApiError(failed[0] || '过去一天没有抓到新闻。');
  const perSource = {};
  const pool = cands.filter(a => (perSource[a.source] = (perSource[a.source] || 0) + 1) <= 12);
  const list = pool.map((a, i) => ({i, source: a.source, topic: topicOf(a), title: a.title, abstract: (a.abstract || '').slice(0, 160)}));
  let items;
  try {
    const res = await gemini(`你是一位给中文读者编早报的资深编辑。读者住在美国，想跟上美国和国际新闻，并融入美国社会，也关心娱乐文化。
从下面的候选新闻中选出最重要的 18 条，合起来 5–10 分钟读完。要求：
- 重要的事件优先，不选小众或琐碎内容；同一事件只留一条。
- 来源尽量多样，不要集中在一两家媒体；同一来源不超过 4 条。
- topic 只能从这些里选：${TOPICS.join('、')}。文化娱乐选 2–3 条，美国政治和国际占大头。
- zh_title：准确、不夸张的中文标题，不超过 24 个字。
- zh_summary：凝练的中文摘要，不超过 60 个字，说清发生了什么和为什么重要；陌生的美国人名、机构顺带说明。只使用候选内容里有的事实，没有摘要的只概括标题，不要补充，不要加入自己的立场。
- 按重要性排序，第一条是今天最重要的新闻。
只输出 JSON：{"items":[{"i":候选序号,"topic":"","zh_title":"","zh_summary":""}]}

候选：
${JSON.stringify(list)}`);
    items = (res.items || []).filter(x => pool[x.i]).map(x => ({...pool[x.i], topic: TOPICS.includes(x.topic) ? x.topic : topicOf(pool[x.i]), zhTitle: x.zh_title, zhSummary: x.zh_summary}));
    if (!items.length) throw new ApiError('Gemini 没有选出新闻。');
  } catch (e) {
    /* AI unavailable: still give a translated brief, chosen by simple rotation across sources. */
    const seen = {}, picked = [];
    for (const a of pool) { const k = a.source + topicOf(a); if (!seen[k] && picked.length < 18) { seen[k] = 1; picked.push(a); } }
    items = picked.map(a => ({...a, topic: topicOf(a)}));
    await mapLimit(items, 4, async a => { a.zhTitle = await translate(a.title).catch(() => a.title); a.zhSummary = a.abstract ? await translate(a.abstract).catch(() => a.abstract) : ''; });
    failed.push('AI 选稿暂时不可用，这期按来源轮流选取。');
  }
  items.forEach((a, n) => a.id = `${today()}-${n}`);
  const brief = {date: today(), items, warning: failed[0] || '', read: []};
  await idb.set(`b2:${today()}`, brief);
  prune();
  return brief;
}
async function prune() {
  const all = await idb.keys(), cutoff = Date.now() - 7 * 864e5;
  for (const k of all) {
    const m = String(k).match(/(\d{4}-\d{2}-\d{2})/);
    if (m && new Date(m[1]) < cutoff) idb.del(k);
  }
}

/* ---------- brief view ---------- */
let current = null, lastView = 'brief';
const registry = new Map();
const WEEK = '日一二三四五六';
function mastHTML(b) {
  const d = new Date(), read = b ? b.read.length : 0, total = b ? b.items.length : 0, pct = total ? read / total * 100 : 0;
  const mins = total ? Math.max(1, Math.round(b.items.slice(read ? 0 : 0).reduce((s, a) => s + (a.zhSummary || '').length + a.zhTitle.length, 0) / 350)) : 0;
  return `<header class="mast"><h1 class="date">${d.getMonth()+1}月${d.getDate()}日，周${WEEK[d.getDay()]}</h1>
    <p class="sub">${total ? `昨天以来的 ${total} 条新闻，摘要约 ${mins} 分钟读完。已读 ${read} 条。` : '正在整理昨天以来的新闻。'}</p>
    <div class="horizon" aria-hidden="true"><div class="fill" style="width:${pct}%"></div><div class="sun" style="left:calc(14px + (100% - 28px) * ${pct / 100})"></div></div></header>`;
}
async function showBrief(force) {
  setTab('brief'); lastView = 'brief';
  document.body.classList.remove('reading');
  if (!keys().guardian || !keys().gemini) return showSettings(true);
  let b = force ? null : await idb.get(`b2:${today()}`);
  if (!b) {
    view.innerHTML = mastHTML(null) + '<p class="loading">正在抓取并翻译，第一次打开要等大约一分钟，请停留在这个页面。</p>';
    try { b = await buildBrief(); }
    catch (e) {
      const old = await latestBrief();
      view.innerHTML = mastHTML(null) + `<p class="error">${esc(e.message)}</p><div class="row"><button class="btn solid" id="retry">再试一次</button>${old ? '<button class="btn" id="oldb">看上一期</button>' : ''}<button class="btn" id="toset">打开设置</button></div>`;
      $('#retry').onclick = () => showBrief(true);
      $('#toset').onclick = () => showSettings();
      if (old) $('#oldb').onclick = () => renderBrief(old);
      return;
    }
  }
  renderBrief(b);
}
async function latestBrief() {
  const ks = (await idb.keys()).filter(k => String(k).startsWith('b2:')).sort();
  return ks.length ? idb.get(ks[ks.length - 1]) : null;
}
function renderBrief(b) {
  current = b; lastView = 'brief';
  b.items.forEach(a => registry.set(a.id, a));
  let html = mastHTML(b), lastTopic = null, first = true;
  if (b.warning) html += `<p class="note">${esc(b.warning)}</p>`;
  const ordered = [];
  for (const t of TOPICS) b.items.filter(a => a.topic === t).forEach(a => ordered.push(a));
  for (const a of ordered) {
    if (a.topic !== lastTopic) { html += `<h2 class="topic">${esc(a.topic)}</h2>`; lastTopic = a.topic; }
    html += `<button class="item${first ? ' lead' : ''}${b.read.includes(a.id) ? ' read' : ''}" data-id="${esc(a.id)}"><h3>${esc(a.zhTitle)}</h3>${a.zhSummary ? `<p>${esc(a.zhSummary)}</p>` : ''}<div class="src">${esc(a.source)}${a.full ? '' : '，打开可看原文'}</div></button>`;
    first = false;
  }
  html += `<div class="row"><button class="btn" id="refresh">重新抓取今天的新闻</button></div>`;
  view.innerHTML = html;
  view.querySelectorAll('.item').forEach(el => el.onclick = () => showArticle(el.dataset.id));
  $('#refresh').onclick = () => showBrief(true);
  window.scrollTo(0, ls.get('briefScroll', 0));
}

/* ---------- article view ---------- */
const wrapWords = t => esc(t).replace(/[A-Za-z][A-Za-z’'-]*/g, m => `<span class="w">${m}</span>`);
async function showArticle(id) {
  const a = registry.get(id);
  ls.set(lastView === 'live' ? 'liveScroll' : 'briefScroll', window.scrollY);
  document.body.classList.add('reading');
  history.pushState({article: id}, '');
  if (current && current.items.some(x => x.id === id) && !current.read.includes(id)) { current.read.push(id); idb.set(`b2:${current.date}`, current); }
  window.scrollTo(0, 0);
  view.innerHTML = `<button class="back" id="back">‹ 返回</button>
    <h1 class="art-zh-title">${esc(a.zhTitle || a.title)}</h1>
    <h2 class="art-en-title">${wrapWords(a.title)}</h2>
    <p class="art-meta">${esc(a.source)}${a.byline ? '，' + esc(a.byline) : ''}</p><div id="body"></div><div id="comments"></div>`;
  $('#back').onclick = () => history.back();
  if (a.full) return loadFull(a);
  $('#body').innerHTML = `${a.abstract ? `<div class="pair"><p class="zh wait" data-s="1">翻译中</p><p class="en">${wrapWords(a.abstract)}</p></div>` : ''}
    <div class="paywall"><p class="note">${esc(a.source)}只提供标题和摘要，全文要到原网站看，部分媒体需要订阅。</p>
    <div class="row"><a class="btn solid" href="${esc(a.url)}" target="_blank" rel="noopener">打开原文</a></div></div>`;
  $('#comments').innerHTML = '<h2 class="c-title">读者评论</h2><p class="note">这家媒体的评论只能到原文页面查看。</p>';
  const sEl = view.querySelector('[data-s]');
  if (sEl) { const set = t => { sEl.textContent = t; sEl.classList.remove('wait'); }; if (a.zhSummary) set(a.zhSummary); else translate(a.abstract).then(set).catch(() => set('')); }
}
async function loadFull(a) {
  const body = $('#body'), key = `article:${a.id}`;
  let art = await idb.get(key);
  if (!art && a.paras) { art = {en: a.paras, zh: a.paras.map(() => null)}; await idb.set(key, art); }
  if (!art) {
    body.innerHTML = '<p class="loading">正在打开全文。</p>';
    try {
      const d = await getJSON(`https://content.guardianapis.com/${a.gid.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({'api-key': keys().guardian, 'show-fields': 'body'})}`, '卫报');
      const doc = new DOMParser().parseFromString(d.response?.content?.fields?.body || '', 'text/html');
      const paras = [...doc.querySelectorAll('p,h2')].map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 1);
      if (!paras.length) throw new ApiError('这篇文章没有可读取的正文。');
      art = {en: paras, zh: paras.map(() => null)};
      await idb.set(key, art);
    } catch (e) {
      body.innerHTML = `<p class="error">${esc(e.message)}</p><div class="row"><a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">打开原文</a></div>`;
      return;
    }
  }
  body.innerHTML = art.en.map((t, i) => `<div class="pair"><p class="zh wait" data-z="${i}">${art.zh[i] ? '' : '翻译中'}</p><p class="en">${wrapWords(t)}</p></div>`).join('') +
    `<div class="row"><a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">打开原文</a></div>`;
  art.zh.forEach((z, i) => z && setZh(i, z));
  loadComments(a);
  translateRest(a, art, key, body);
}
function setZh(i, text) {
  const el = view.querySelector(`[data-z="${i}"]`);
  if (el) { el.textContent = text; el.classList.remove('wait'); }
}
async function translateRest(a, art, key, body) {
  const todo = art.en.map((t, i) => i).filter(i => !art.zh[i]);
  let failed = 0, lastErr = '';
  await mapLimit(todo, 4, async i => {
    if (!body.isConnected) return;
    try { art.zh[i] = await translate(art.en[i]); setZh(i, art.zh[i]); }
    catch (e) { failed++; lastErr = e.message; }
  });
  if (todo.length) await idb.set(key, art);
  if (failed && body.isConnected) {
    view.querySelectorAll('.zh.wait').forEach(el => el.textContent = '');
    const box = document.createElement('div');
    box.innerHTML = `<p class="error">有 ${failed} 段没翻译出来：${esc(lastErr)}</p><div class="row"><button class="btn">继续翻译</button></div>`;
    body.prepend(box);
    box.querySelector('button').onclick = () => { box.remove(); view.querySelectorAll('.zh.wait').forEach(el => el.textContent = '翻译中'); translateRest(a, art, key, body); };
  }
}

/* ---------- comments ---------- */
async function loadComments(a) {
  const box = $('#comments');
  if (!box) return;
  const m = (a.shortUrl || '').match(/\/p\/[A-Za-z0-9]+/);
  if (!m) return;
  box.innerHTML = '<h2 class="c-title">读者评论</h2><p class="note">正在加载评论。</p>';
  let d;
  try {
    const r = await fetch(`https://discussion.theguardian.com/discussion-api/discussion${m[0]}?orderBy=mostrecommended&pageSize=15&displayThreaded=false&displayResponses=false&page=1`);
    if (r.status === 404) { box.innerHTML = '<h2 class="c-title">读者评论</h2><p class="note">这篇文章没有开放评论。</p>'; return; }
    if (!r.ok) throw 0;
    d = (await r.json()).discussion;
  } catch { box.innerHTML = '<h2 class="c-title">读者评论</h2><p class="note">评论暂时加载不出来。</p>'; return; }
  const cs = (d?.comments || []).map(c => ({who: c.userProfile?.displayName || '读者', likes: c.numRecommends || 0, text: stripTags(c.body)})).filter(c => c.text);
  if (!cs.length) { box.innerHTML = `<h2 class="c-title">读者评论</h2><p class="note">${d?.isClosedForComments ? '这篇文章没有开放评论。' : '还没有评论。'}</p>`; return; }
  box.innerHTML = `<h2 class="c-title">读者评论（共 ${d.commentCount}）</h2><p class="note">来自卫报读者，按获赞数排序，不代表报道立场。</p>
    <div class="row"><button class="btn" id="c-tr">翻译这些评论</button></div>` +
    cs.map((c, i) => `<div class="comment"><p class="c-who">${esc(c.who)}，${c.likes} 赞</p><p class="zh" data-c="${i}" hidden></p><p class="en">${wrapWords(c.text)}</p></div>`).join('');
  $('#c-tr').onclick = async e => {
    const b = e.target; b.disabled = true; b.textContent = '翻译中';
    try {
      await mapLimit(cs, 4, async (c, i) => { const el = box.querySelector(`[data-c="${i}"]`); if (el) { el.textContent = await translate(c.text); el.hidden = false; } });
      b.remove();
    } catch (err) { b.disabled = false; b.textContent = '再试一次翻译'; const p = document.createElement('p'); p.className = 'error'; p.textContent = err.message; b.after(p); }
  };
}

/* ---------- live feed ---------- */
let liveTimer = null, liveItems = [];
const ago = d => { const m = Math.max(0, Math.round((Date.now() - new Date(d)) / 6e4)); return m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
async function fetchLiveGuardian() {
  const u = new URLSearchParams({'api-key': keys().guardian, section: SECTIONS, type: 'article', 'order-by': 'newest', 'page-size': '30', 'show-fields': 'headline,trailText,byline,wordcount,shortUrl'});
  const d = await getJSON(`https://content.guardianapis.com/search?${u}`, '卫报');
  return (d.response?.results || []).map(mapGuardian);
}
async function fetchLiveNYT() {
  if (!keys().nyt) return [];
  const d = await getJSON(`https://api.nytimes.com/svc/news/v3/content/all/all.json?limit=30&api-key=${encodeURIComponent(keys().nyt)}`, '纽约时报');
  return (d.results || []).filter(a => a.title && a.url && a.abstract).map(a => ({source: 'New York Times', full: false, url: a.url, section: a.section, title: a.title, abstract: a.abstract, byline: a.byline || '', date: a.published_date}));
}
let liveTopic = '全部', liveNote = '';
function renderLive(note) {
  if (note) liveNote = note;
  if (lastView !== 'live' || document.body.classList.contains('reading')) return;
  const y = window.scrollY;
  const shown = liveItems.filter(a => liveTopic === '全部' || topicOf(a) === liveTopic);
  const sources = new Set(liveItems.map(a => a.source)).size;
  view.innerHTML = `<h1 class="page-title">实时新闻</h1><p class="note live-note">${esc(liveNote)} 共 ${sources} 家来源。</p>
    <div class="chips">${['全部', ...TOPICS].map(t => `<button class="chip${t === liveTopic ? ' on' : ''}" data-t="${t}">${t}</button>`).join('')}</div>` + shown.map(a =>
    `<button class="item" data-id="${esc(a.id)}"><h3>${esc(a.zhTitle || a.title)}</h3>${a.zhSummary ? `<p>${esc(a.zhSummary)}</p>` : ''}<div class="src">${esc(a.source)}，${ago(a.date)}</div></button>`).join('');
  view.querySelectorAll('.item').forEach(el => el.onclick = () => showArticle(el.dataset.id));
  view.querySelectorAll('.chip').forEach(el => el.onclick = () => { liveTopic = el.dataset.t; renderLive(); window.scrollTo(0, 0); });
  window.scrollTo(0, y);
}
async function refreshLive() {
  const rs = await Promise.allSettled([fetchLiveGuardian(), fetchLiveNYT(), fetchFeeds()]);
  const fresh = rs.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const fail = rs.find(r => r.status === 'rejected');
  if (!fresh.length) { if (lastView === 'live' && !liveItems.length) { view.innerHTML = `<h1 class="page-title">实时新闻</h1><p class="error">${esc(fail?.reason?.message || '暂时没有抓到新闻。')}</p><div class="row"><button class="btn solid" id="live-retry">再试一次</button></div>`; $('#live-retry').onclick = refreshLive; } return; }
  const zh = (await idb.get('liveZh')) || {};
  fresh.sort((a, b) => new Date(b.date) - new Date(a.date));
  const per = {};
  liveItems = fresh.filter(a => (per[a.source] = (per[a.source] || 0) + 1) <= 10).slice(0, 120);
  liveItems.forEach(a => { a.id = 'live-' + a.url; Object.assign(a, zh[a.url] || {}); registry.set(a.id, a); });
  const time = new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
  renderLive(`${time} 更新。`);
  const todo = liveItems.filter(a => !a.zhTitle);
  let n = 0;
  await mapLimit(todo, 5, async a => {
    try {
      a.zhTitle = await gtOne(a.title);
      if (a.abstract) a.zhSummary = await gtOne(a.abstract.slice(0, 300));
      zh[a.url] = {zhTitle: a.zhTitle, zhSummary: a.zhSummary || ''};
    } catch {}
    if (++n % 10 === 0) renderLive();
  });
  if (todo.length) {
    const keep = {}; liveItems.forEach(a => { if (zh[a.url]) keep[a.url] = zh[a.url]; });
    await idb.set('liveZh', keep);
    renderLive();
  }
}
function showLive() {
  setTab('live'); lastView = 'live'; document.body.classList.remove('reading');
  if (!keys().guardian || !keys().gemini) return showSettings(true);
  if (liveItems.length) renderLive('正在检查新内容。');
  else view.innerHTML = '<h1 class="page-title">实时新闻</h1><p class="loading">正在抓取最新新闻。</p>';
  refreshLive();
  clearInterval(liveTimer);
  liveTimer = setInterval(() => { if (lastView === 'live' && !document.hidden && !document.body.classList.contains('reading')) refreshLive(); }, 5 * 60e3);
}

/* ---------- dictionary ---------- */
let dictP;
const loadDict = () => dictP || (dictP = fetch('dict.json').then(r => { if (!r.ok) throw 0; return r.json(); }).catch(e => { dictP = null; throw e; }));
function lookup(D, raw) {
  const w = raw.toLowerCase().replace(/[’]/g, "'").replace(/'s$|'$/, '');
  const hit = k => D.w[k] ? {word: k, ph: D.w[k][0], tr: D.w[k][1], from: k === w ? '' : w} : null;
  let r = hit(w) || (D.f[w] && hit(D.f[w]));
  if (r) return r;
  const tries = [[/ies$/, 'y'], [/ied$/, 'y'], [/ing$/, ''], [/ing$/, 'e'], [/ed$/, ''], [/ed$/, 'e'], [/es$/, ''], [/s$/, ''], [/ly$/, ''], [/er$/, ''], [/est$/, '']];
  for (const [re, sub] of tries) if (re.test(w) && (r = hit(w.replace(re, sub)))) return r;
  const dbl = w.match(/^(.*([bdgmnprt]))\2(ing|ed)$/);
  if (dbl && (r = hit(dbl[1]))) return r;
  return w.includes('-') ? (hit(w.split('-').pop())) : null;
}
const sheet = $('#sheet'), back = $('#sheet-back');
function closeSheet() { sheet.hidden = back.hidden = true; view.querySelectorAll('.w.on').forEach(x => x.classList.remove('on')); }
back.onclick = closeSheet;
function sentenceOf(el) {
  const t = el.closest('p,h2')?.textContent || '';
  const word = el.textContent, pos = t.indexOf(word);
  const parts = t.match(/[^.!?]+[.!?”"']*\s*/g) || [t];
  return (parts.find(s => s.includes(word)) || t).trim().slice(0, 400) || t.slice(Math.max(0, pos - 100), pos + 100);
}
async function openWord(el) {
  closeSheet(); el.classList.add('on');
  const raw = el.textContent, sentence = sentenceOf(el);
  sheet.hidden = back.hidden = false;
  sheet.innerHTML = `<div class="head">${esc(raw)}</div><p class="note">查询中</p>`;
  let r = null, failed = false;
  try { r = lookup(await loadDict(), raw); } catch { failed = true; }
  const word = r?.word || raw.toLowerCase();
  const saved = ls.get('words', []).some(x => x.word === word);
  sheet.innerHTML = `<div class="head">${esc(word)}</div>
    ${r?.from ? `<p class="ph">由 ${esc(r.from)} 变形而来</p>` : ''}${r?.ph ? `<p class="ph">/${esc(r.ph)}/</p>` : ''}
    <p class="defs">${r ? esc(r.tr) : failed ? '词典加载失败，检查网络后再试。' : '词典里没有这个词，可能是人名或专有名词。'}</p>
    <div class="ctx" id="ctx" hidden></div>
    <div class="row"><button class="btn solid" id="ctxb">这句里什么意思</button><button class="btn" id="say">发音</button><button class="btn" id="save">${saved ? '已加入生词本' : '加入生词本'}</button></div>`;
  $('#say').onclick = () => { try { const u = new SpeechSynthesisUtterance(word); u.lang = 'en-US'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {} };
  $('#save').onclick = () => {
    const list = ls.get('words', []);
    if (!list.some(x => x.word === word)) { list.unshift({word, ph: r?.ph || '', tr: r?.tr || '', ex: sentence}); ls.set('words', list); }
    $('#save').textContent = '已加入生词本';
  };
  $('#ctxb').onclick = async () => {
    const box = $('#ctx'), btn = $('#ctxb');
    box.hidden = false; box.textContent = '正在分析这句话'; btn.disabled = true;
    try {
      box.textContent = await gemini(`英文句子：${JSON.stringify(sentence)}
用简体中文说明其中 "${raw}" 在这句话里的意思，一到两句话；如果它是习语或固定搭配的一部分，指出完整搭配。最后另起一行给出整句的中文翻译。只输出这些内容，不用 Markdown。`, false);
      box.style.whiteSpace = 'pre-line';
    } catch (e) {
      try { box.textContent = '整句翻译：' + await translate(sentence); }
      catch { box.textContent = e.message; btn.disabled = false; }
    }
  };
}
view.addEventListener('click', e => {
  if (!e.target.classList?.contains('w')) return;
  const s = getSelection();
  if (s && !s.isCollapsed) return;
  openWord(e.target);
});

/* phrase translation: select text in English to translate it */
const selBtn = $('#sel-btn');
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  const inEn = s && !s.isCollapsed && s.anchorNode?.parentElement?.closest('.en,.art-en-title');
  selBtn.hidden = !(inEn && s.toString().trim().includes(' '));
});
selBtn.onclick = async () => {
  const text = getSelection().toString().trim().slice(0, 600);
  selBtn.hidden = true; closeSheet();
  sheet.hidden = back.hidden = false;
  sheet.innerHTML = `<p class="en" style="margin:0">${esc(text)}</p><p class="defs" id="st">翻译中</p>`;
  try {
    $('#st').textContent = await translate(text);
  } catch (e) { $('#st').textContent = e.message; }
};

/* ---------- vocabulary ---------- */
function showWords() {
  setTab('words'); lastView = 'words'; document.body.classList.remove('reading');
  const list = ls.get('words', []);
  view.innerHTML = `<h1 class="page-title">生词本</h1>` + (list.length
    ? list.map((x, i) => `<div class="word-row"><button data-del="${i}">删除</button><b>${esc(x.word)}</b>${x.ph ? ` <span class="note">/${esc(x.ph)}/</span>` : ''}<div class="d">${esc(x.tr)}</div><div class="ex">${esc(x.ex)}</div></div>`).join('')
    : `<p class="note">读文章时点一个英文单词，再点“加入生词本”，它就会连同原句保存在这里。</p>`);
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const l = ls.get('words', []); l.splice(+b.dataset.del, 1); ls.set('words', l); showWords(); });
}

/* ---------- themes ---------- */
const THEMES = [['粉色', '#EC6A9C'], ['紫色', '#9B72CF'], ['蓝色', '#4F86C6'], ['绿色', '#4FA37A'], ['橙色', '#E58A3C']];
function applyTheme() {
  const t = ls.get('theme', {accent: '#EC6A9C', night: false});
  const r = document.documentElement;
  r.style.setProperty('--accent', t.accent);
  r.toggleAttribute('data-night', !!t.night);
  const meta = document.querySelector('meta[name=theme-color]');
  requestAnimationFrame(() => { if (meta) meta.content = getComputedStyle(document.body).backgroundColor; });
}
function themeHTML() {
  const t = ls.get('theme', {accent: '#EC6A9C', night: false});
  return `<h2 class="c-title">主题色</h2><div class="swatches">${THEMES.map(([n, c]) => `<button class="sw${t.accent.toLowerCase() === c.toLowerCase() ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="${n}"></button>`).join('')}
    <label class="custom">自选<input type="color" id="t-custom" value="${esc(t.accent)}"></label></div>
    <label class="night"><input type="checkbox" id="t-night"${t.night ? ' checked' : ''}> 夜间模式</label>`;
}
function bindTheme() {
  const set = patch => { ls.set('theme', {...ls.get('theme', {accent: '#EC6A9C', night: false}), ...patch}); applyTheme(); };
  view.querySelectorAll('.sw').forEach(b => b.onclick = () => { set({accent: b.dataset.c}); view.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === b)); });
  $('#t-custom').oninput = e => { set({accent: e.target.value}); view.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); };
  $('#t-night').onchange = e => set({night: e.target.checked});
}

/* ---------- settings ---------- */
function showSettings(first) {
  setTab('settings'); lastView = 'settings'; document.body.classList.remove('reading');
  const k = keys();
  view.innerHTML = `<h1 class="page-title">${first ? '填好 key 就能开始' : '设置'}</h1>
  ${themeHTML()}<h2 class="c-title">Key</h2>
  <p class="note">这些 key 都免费，只保存在这台手机上。BBC、NPR、华盛顿邮报标题等来源不需要 key。</p>
  <label>卫报 Guardian key（必填）<small>提供全文。<a href="https://bonobo.capi.gutools.co.uk/register/developer" target="_blank" rel="noopener">免费申请</a></small><input type="text" id="k-g" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.guardian || '')}"></label>
  <label>Google Gemini key（必填）<small>负责挑选早报新闻和解释单词。<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">免费申请</a></small><input type="text" id="k-a" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.gemini || '')}"></label>
  <label>纽约时报 NYT key（可选）<small>提供头条、实时快讯和摘要，不含全文。<a href="https://developer.nytimes.com/get-started" target="_blank" rel="noopener">免费申请</a></small><input type="text" id="k-n" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.nyt || '')}"></label>
  <p class="error" id="set-err" hidden></p>
  <div class="row"><button class="btn solid" id="save-k">保存并打开早报</button></div>`;
  bindTheme();
  $('#save-k').onclick = () => {
    const g = $('#k-g').value.trim(), a = $('#k-a').value.trim(), n = $('#k-n').value.trim();
    if (!g || !a) { const e = $('#set-err'); e.hidden = false; e.textContent = '卫报和 Gemini 的 key 都要填。'; return; }
    ls.set('keys', {guardian: g, gemini: a, nyt: n});
    showBrief();
  };
}

/* ---------- shell ---------- */
function setTab(t) { document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); closeSheet(); }
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => ({brief: () => showBrief(), live: showLive, words: showWords, settings: () => showSettings()})[b.dataset.tab]());
window.addEventListener('popstate', () => { closeSheet(); document.body.classList.remove('reading'); if (lastView === 'live') { const y = ls.get('liveScroll', 0); renderLive(); window.scrollTo(0, y); } else if (current) renderBrief(current); else showBrief(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (!document.hidden) $('#retry')?.click(); });
applyTheme();
showBrief();

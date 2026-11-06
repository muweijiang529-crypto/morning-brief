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
  let r;
  try { r = await timed(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(t)}`, 10000); }
  catch { throw new ApiError('连不上翻译服务，或者等太久了。'); }
  if (r.status === 429) throw new ApiError('翻译服务暂时限流，过一会儿再试。', 429);
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
    out.push(await gtOne(p));
  }
  return out.join('');
}
async function mapLimit(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({length: Math.min(n, list.length)}, async () => {
    while (i < list.length) { const k = i++; await fn(list[k], k); }
  }));
}

/* ---------- finished data from the cloud ---------- */
const DATA = 'https://raw.githubusercontent.com/muweijiang529-crypto/morning-brief/data/';
const TOPICS = ['美国政治', '国际', '经济与科技', '气候与环境', '文化娱乐'];
const registry = new Map();
function stripTags(h) { return new DOMParser().parseFromString(h || '', 'text/html').body.textContent.trim(); }
async function timed(url, ms = 15000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, {signal: c.signal, cache: 'no-cache'}); }
  finally { clearTimeout(t); }
}
function normalize(a) {
  a.zhTitle = a.zh_title || a.zhTitle || '';
  a.zhSummary = a.zh_summary || a.zhSummary || '';
  a.full = !!(a.paras || (a.gid && keys().guardian));
  registry.set(a.id, a);
  return a;
}
const store = {feeds: null, brief: null, loading: null};
async function loadCached() {
  if (!store.feeds) store.feeds = await idb.get('feeds') || null;
  if (!store.brief) store.brief = await idb.get('brief') || null;
  store.feeds?.items.forEach(normalize);
  store.brief?.items.forEach(normalize);
}
/* Download the latest files. Old data stays on screen if anything fails. */
function refreshData() {
  if (store.loading) return store.loading;
  store.loading = (async () => {
    const stamp = Math.floor(Date.now() / 6e4);
    const [f, b] = await Promise.all(['feeds', 'brief'].map(async n => {
      const r = await timed(`${DATA}${n}.json?t=${stamp}`, 25000);
      if (!r.ok) throw new ApiError(`数据暂时取不到（${r.status}）。`);
      return r.json();
    }));
    const changed = f.updated !== store.feeds?.updated, briefChanged = b.date !== store.brief?.date || b.built !== store.brief?.built;
    store.feeds = f; store.brief = b;
    f.items.forEach(normalize); b.items.forEach(normalize);
    idb.set('feeds', f); idb.set('brief', b);
    return {changed, briefChanged};
  })().finally(() => { store.loading = null; });
  return store.loading;
}
async function prune() {
  const all = await idb.keys(), used = new Set([...(store.brief?.items || []), ...(store.feeds?.items || [])].map(a => `article:${a.id}`));
  for (const k of all) if (String(k).startsWith('article:') && !used.has(k)) idb.del(k);
}
const readSet = () => new Set(ls.get('read', []));
function markRead(id) { const r = ls.get('read', []); if (!r.includes(id)) { r.push(id); ls.set('read', r.slice(-400)); } }

/* ---------- list rendering ---------- */
let lastView = 'brief', listState = null;
const WEEK = '日一二三四五六';
const ago = d => { const m = Math.max(0, Math.round((Date.now() - new Date(d)) / 6e4)); return m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
function itemHTML(a, opts = {}) {
  const read = readSet().has(a.id);
  const img = a.image ? `<img class="thumb" loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(a.image)}">` : '';
  return `<button class="item${opts.lead ? ' lead' : ''}${read ? ' read' : ''}${a.image ? ' has-img' : ''}" data-id="${esc(a.id)}">${img}<span class="tx"><h3>${esc(a.zhTitle || a.title)}</h3>${a.zhSummary ? `<p>${esc(a.zhSummary)}</p>` : ''}<span class="src">${esc(a.source)}，${ago(a.date)}${a.full ? '，可读全文' : ''}</span></span></button>`;
}
function bindItems(root) {
  root.querySelectorAll('.item:not([data-b])').forEach(el => {
    el.dataset.b = 1;
    el.onclick = () => showArticle(el.dataset.id);
    const im = el.querySelector('img');
    if (im) im.onerror = () => { im.remove(); el.classList.remove('has-img'); };
  });
}
/* Endless list: more stories load as you reach the bottom. */
let endless = null;
function startEndless(pool, host) {
  endless?.disconnect();
  let i = 0;
  const sentinel = document.createElement('div');
  sentinel.className = 'more-end';
  host.after(sentinel);
  const step = () => {
    const part = pool.slice(i, i + 20); i += part.length;
    host.insertAdjacentHTML('beforeend', part.map(a => itemHTML(a)).join(''));
    bindItems(host);
    if (i >= pool.length) { endless?.disconnect(); sentinel.textContent = pool.length ? '已经看完新闻库了。下拉可以检查新内容。' : ''; }
    else sentinel.textContent = '正在加载更多';
  };
  step();
  endless = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) step(); }, {rootMargin: '800px'});
  endless.observe(sentinel);
}
function statusLine() {
  const f = store.feeds;
  if (!f) return '';
  const m = Math.round((Date.now() - new Date(f.updated)) / 6e4);
  return m < 1 ? '刚刚更新' : m < 60 ? `${m} 分钟前更新` : `${Math.round(m / 60)} 小时前更新`;
}
const skeleton = n => `<div class="skel">${'<div></div>'.repeat(n)}</div>`;

/* ---------- brief view ---------- */
function briefDateText(s) { const d = new Date(s + 'T12:00:00'); return `${d.getMonth() + 1}月${d.getDate()}日，周${WEEK[d.getDay()]}`; }
function renderBrief() {
  lastView = 'brief'; setTab('brief'); document.body.classList.remove('reading'); endless?.disconnect();
  const b = store.brief;
  if (!b) {
    view.innerHTML = `<header class="mast"><h1 class="date">晨读</h1><p class="sub">正在取今天的新闻。</p></header>${skeleton(5)}<p class="error" id="load-err" hidden></p>`;
    return;
  }
  const read = readSet(), done = b.items.filter(a => read.has(a.id)).length, total = b.items.length, pct = total ? done / total * 100 : 0;
  const mins = Math.max(3, Math.round(b.items.reduce((s, a) => s + (a.zhSummary || '').length + (a.zhTitle || '').length, 0) / 350));
  let html = `<header class="mast"><h1 class="date">${briefDateText(b.date)}</h1>
    <p class="sub">今日早报 ${total} 条，约 ${mins} 分钟读完。已读 ${done} 条。</p>
    <div class="horizon" aria-hidden="true"><div class="fill" style="width:${pct}%"></div><div class="sun" style="left:calc(14px + (100% - 28px) * ${pct / 100})"></div></div></header>`;
  const lead = b.items[0];
  html += `<div id="brief-list">${itemHTML(lead, {lead: true})}`;
  for (const t of TOPICS) {
    const inTopic = b.items.slice(1).filter(a => a.topic === t);
    if (inTopic.length) html += `<h2 class="topic">${t}</h2>` + inTopic.map(a => itemHTML(a)).join('');
  }
  html += `</div><h2 class="topic more-title">更多新闻</h2><div id="more-list"></div>`;
  view.innerHTML = html;
  bindItems($('#brief-list'));
  const used = new Set(b.items.map(a => a.url));
  startEndless((store.feeds?.items || []).filter(a => !used.has(a.url)), $('#more-list'));
}

/* ---------- pull to refresh ---------- */
const pull = document.createElement('div');
pull.id = 'pull'; pull.textContent = '下拉检查新内容';
document.body.prepend(pull);
let pullY = null;
document.addEventListener('touchstart', e => { pullY = (window.scrollY <= 0 && !document.body.classList.contains('reading') && ['brief', 'live'].includes(lastView)) ? e.touches[0].clientY : null; }, {passive: true});
document.addEventListener('touchmove', e => {
  if (pullY === null) return;
  const d = Math.min(e.touches[0].clientY - pullY, 110);
  if (d <= 0) { pull.style.transform = ''; return; }
  pull.style.transform = `translateY(${d}px)`;
  pull.textContent = d > 70 ? '松开刷新' : '下拉检查新内容';
}, {passive: true});
document.addEventListener('touchend', async e => {
  if (pullY === null) return;
  const d = e.changedTouches[0].clientY - pullY; pullY = null;
  if (d > 70) { pull.textContent = '正在检查'; pull.style.transform = 'translateY(70px)'; await syncNow(true); }
  pull.style.transform = '';
});
function toast(t) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.append(el); }
  el.textContent = t; el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2600);
}
async function syncNow(tell) {
  const hadBrief = !!store.brief;
  try {
    const {changed, briefChanged} = await refreshData();
    const y = window.scrollY, reading = document.body.classList.contains('reading');
    if (!reading && (changed || briefChanged || !hadBrief)) {
      if (lastView === 'brief' && (briefChanged || y < 50 || !hadBrief)) renderBrief();
      else if (lastView === 'live' && y < 50) renderLive();
      else if (changed) toast('有新内容，回到顶部下拉查看');
    }
    if (tell) toast(changed ? '已更新' : `已是最新，${statusLine()}`);
    prune();
  } catch (e) {
    if (!store.brief) { const el = $('#load-err'); if (el) { el.hidden = false; el.innerHTML = `${esc(e.name === 'AbortError' ? '网络太慢，没有取到新闻。' : e.message || '没有取到新闻。')} <button class="btn" id="retry">再试一次</button>`; $('#retry').onclick = () => { el.hidden = true; syncNow(); }; } }
    else if (tell) toast('现在连不上网络，先显示已保存的内容');
  }
}

/* ---------- article view ---------- */
const wrapWords = t => esc(t).replace(/[A-Za-z][A-Za-z’'-]*/g, m => `<span class="w">${m}</span>`);
async function showArticle(id) {
  const a = registry.get(id);
  ls.set(lastView === 'live' ? 'liveScroll' : 'briefScroll', window.scrollY);
  document.body.classList.add('reading');
  history.pushState({article: id}, '');
  markRead(id);
  window.scrollTo(0, 0);
  view.innerHTML = `<button class="back" id="back">‹ 返回</button>
    <h1 class="art-zh-title">${esc(a.zhTitle || a.title)}</h1>
    <h2 class="art-en-title">${wrapWords(a.title)}</h2>
    <p class="art-meta">${esc(a.source)}，${ago(a.date)}</p>${a.image ? `<img class="art-img" referrerpolicy="no-referrer" alt="" src="${esc(a.image)}" onerror="this.remove()">` : ''}<div id="body"></div><div id="related"></div><div id="comments"></div>`;
  $('#back').onclick = () => history.back();
  if (a.full) return loadFull(a);
  $('#body').innerHTML = `${a.abstract ? `<div class="pair"><p class="zh wait" data-s="1">翻译中</p><p class="en">${wrapWords(a.abstract)}</p></div>` : ''}
    <div class="paywall"><p class="note">${a.gid ? '到“设置”填入卫报 key 后，可以在这里读全文。' : esc(a.source) + '在这里只有标题或摘要。全文要到原网站看，部分媒体需要订阅。'}</p>
    <div class="row"><a class="btn solid" href="${esc(a.url)}" target="_blank" rel="noopener">打开原文</a></div></div>`;
  $('#comments').innerHTML = '<h2 class="c-title">读者评论</h2><p class="note">这家媒体的评论只能到原文页面查看。</p>';
  if (keys().guardian) loadRelated(a);
  const sEl = view.querySelector('[data-s]');
  if (sEl) { const set = t => { sEl.textContent = t; sEl.classList.remove('wait'); }; if (a.zhSummary) set(a.zhSummary); else translate(a.abstract).then(set).catch(() => set('')); }
}
const artJobs = new Map();
function articleData(a) {
  const key = `article:${a.id}`;
  if (artJobs.has(key)) return artJobs.get(key);
  const job = (async () => {
    let art = await idb.get(key);
    if (art) { if (art.shortUrl) a.shortUrl = art.shortUrl; return art; }
    if (a.paras) art = {en: a.paras, zh: a.paras.map(() => null)};
    else {
      const d = await getJSON(`https://content.guardianapis.com/${a.gid.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({'api-key': keys().guardian, 'show-fields': 'body,shortUrl'})}`, '卫报');
      const f = d.response?.content?.fields || {};
      const doc = new DOMParser().parseFromString(f.body || '', 'text/html');
      const paras = [...doc.querySelectorAll('p,h2')].map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 1);
      if (!paras.length) throw new ApiError('这篇文章没有可读取的正文。');
      art = {en: paras, zh: paras.map(() => null), shortUrl: f.shortUrl || ''};
      a.shortUrl = art.shortUrl;
    }
    await idb.set(key, art);
    return art;
  })().finally(() => artJobs.delete(key));
  artJobs.set(key, job);
  return job;
}
function fillTranslation(art, key, onPara, onProgress) {
  const run = (async () => {
    let failed = 0, lastErr = '';
    const todo = art.en.map((t, i) => i).filter(i => !art.zh[i]);
    let done = 0;
    await mapLimit(todo, 3, async i => {
      if (art.zh[i]) return;
      try { art.zh[i] = await translate(art.en[i]); onPara?.(i, art.zh[i]); }
      catch (e) { failed++; lastErr = e.message; }
      onProgress?.(++done, todo.length);
      if (done % 5 === 0) idb.set(key, art);
    });
    if (todo.length) await idb.set(key, art);
    return {failed, lastErr};
  })();
  return run;
}
async function loadFull(a) {
  const body = $('#body'), key = `article:${a.id}`;
  body.innerHTML = skeleton(4);
  let art;
  try { art = await articleData(a); }
  catch (e) {
    if (!body.isConnected) return;
    body.innerHTML = `<p class="error">${esc(e.message)}</p><div class="row"><a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">打开原文</a></div>`;
    return;
  }
  if (!body.isConnected) return;
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
  const bar = document.createElement('p');
  bar.className = 'tr-progress';
  if (art.zh.some(z => !z)) body.prepend(bar);
  const {failed, lastErr} = await fillTranslation(art, key, (i, z) => { if (body.isConnected) setZh(i, z); },
    (n, all) => { bar.textContent = `正在翻译 ${n}/${all} 段`; });
  bar.remove();
  if (failed && body.isConnected) {
    view.querySelectorAll('.zh.wait').forEach(el => el.textContent = '');
    const box = document.createElement('div');
    box.innerHTML = `<p class="error">有 ${failed} 段没翻译出来：${esc(lastErr)}</p><div class="row"><button class="btn">继续翻译</button></div>`;
    body.prepend(box);
    box.querySelector('button').onclick = () => { box.remove(); view.querySelectorAll('.zh.wait').forEach(el => el.textContent = '翻译中'); translateRest(a, art, key, body); };
  }
}

/* ---------- same event, readable in full ---------- */
const STOP = new Set('the a an of to in on for and or as at by with from is are was were be been his her their its it this that after over into amid says said say new will has have had not but about who what why how more than up out'.split(' '));
async function loadRelated(a) {
  const box = $('#related');
  if (!box) return;
  const words = a.title.replace(/[^A-Za-z0-9' -]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w.toLowerCase())).slice(0, 5);
  if (words.length < 2) return;
  const from = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10);
  const u = new URLSearchParams({'api-key': keys().guardian, q: words.join(' OR '), 'query-fields': 'headline', type: 'article', 'from-date': from, 'order-by': 'relevance', 'page-size': '10', 'show-fields': 'headline,trailText,byline,wordcount,shortUrl'});
  let list;
  try { list = (await getJSON(`https://content.guardianapis.com/search?${u}`, '卫报')).response?.results || []; } catch { return; }
  const score = t => { const h = t.toLowerCase(); return words.filter(w => h.includes(w.toLowerCase())).length; };
  const hits = list.map(mapGuardian).map(x => ({x, n: score(x.title)})).filter(o => o.n >= Math.min(3, Math.ceil(words.length * .6))).sort((p, q) => q.n - p.n).slice(0, 3).map(o => o.x);
  if (!hits.length || !box.isConnected) return;
  await mapLimit(hits, 3, async h => { h.id = 'rel-' + h.url; h.zhTitle = await translate(h.title).catch(() => h.title); registry.set(h.id, h); });
  if (!box.isConnected) return;
  box.innerHTML = `<h2 class="c-title">可能相关的全文报道</h2><p class="note">由关键词匹配，来自卫报，不一定是同一件事。</p>` +
    hits.map(h => `<button class="item" data-id="${esc(h.id)}"><h3>${esc(h.zhTitle)}</h3><div class="src">The Guardian，可读全文</div></button>`).join('');
  box.querySelectorAll('.item').forEach(el => el.onclick = () => showArticle(el.dataset.id));
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
let liveTopic = '全部';
function renderLive() {
  lastView = 'live'; setTab('live'); document.body.classList.remove('reading'); endless?.disconnect();
  const f = store.feeds;
  if (!f) { view.innerHTML = `<h1 class="page-title">实时新闻</h1>${skeleton(5)}<p class="error" id="load-err" hidden></p>`; return; }
  const shown = f.items.filter(a => liveTopic === '全部' || a.topic === liveTopic);
  const sources = Object.values(f.counts || {}).filter(Boolean).length;
  view.innerHTML = `<h1 class="page-title">实时新闻</h1><p class="note live-note">${statusLine()}，${sources} 家媒体，${f.total} 条。</p>
    <div class="chips">${['全部', ...TOPICS].map(t => `<button class="chip${t === liveTopic ? ' on' : ''}" data-t="${t}">${t}</button>`).join('')}</div><div id="live-list"></div>`;
  view.querySelectorAll('.chip').forEach(el => el.onclick = () => { liveTopic = el.dataset.t; renderLive(); window.scrollTo(0, 0); });
  startEndless(shown, $('#live-list'));
}
const showLive = () => { renderLive(); window.scrollTo(0, 0); syncNow(); };

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
  endless?.disconnect(); setTab('words'); lastView = 'words'; document.body.classList.remove('reading');
  const list = ls.get('words', []);
  view.innerHTML = `<h1 class="page-title">生词本</h1>` + (list.length
    ? list.map((x, i) => `<div class="word-row"><button data-del="${i}">删除</button><b>${esc(x.word)}</b>${x.ph ? ` <span class="note">/${esc(x.ph)}/</span>` : ''}<div class="d">${esc(x.tr)}</div><div class="ex">${esc(x.ex)}</div></div>`).join('')
    : `<p class="note">读文章时点一个英文单词，再点“加入生词本”，它就会连同原句保存在这里。</p>`);
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const l = ls.get('words', []); l.splice(+b.dataset.del, 1); ls.set('words', l); showWords(); });
}

/* ---------- themes ---------- */
const THEMES = [['粉色', '#EC6A9C'], ['紫色', '#9B72CF'], ['蓝色', '#4F86C6'], ['绿色', '#4FA37A'], ['橙色', '#E58A3C']];
function applySize() { view.style.zoom = ls.get('size', 1); }
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
    <label class="night"><input type="checkbox" id="t-night"${t.night ? ' checked' : ''}> 夜间模式</label>
    <h2 class="c-title">字号</h2><div class="chips sizes">${[['标准', 1], ['大', 1.12], ['特大', 1.25]].map(([n, v]) => `<button class="chip${ls.get('size', 1) === v ? ' on' : ''}" data-size="${v}">${n}</button>`).join('')}</div>`;
}
function bindTheme() {
  const set = patch => { ls.set('theme', {...ls.get('theme', {accent: '#EC6A9C', night: false}), ...patch}); applyTheme(); };
  view.querySelectorAll('.sw').forEach(b => b.onclick = () => { set({accent: b.dataset.c}); view.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === b)); });
  $('#t-custom').oninput = e => { set({accent: e.target.value}); view.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); };
  $('#t-night').onchange = e => set({night: e.target.checked});
  view.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { ls.set('size', +b.dataset.size); applySize(); view.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('on', x === b)); });
}

/* ---------- settings ---------- */
function showSettings(first) {
  endless?.disconnect(); setTab('settings'); lastView = 'settings'; document.body.classList.remove('reading');
  const k = keys();
  view.innerHTML = `<h1 class="page-title">设置</h1>
  ${themeHTML()}<h2 class="c-title">Key</h2>
  <p class="note">看新闻不需要 key。填了 key 可以多两个功能，都只保存在这台手机上。</p>
  <label>卫报 Guardian key<small>在 App 里读卫报全文和评论。<a href="https://bonobo.capi.gutools.co.uk/register/developer" target="_blank" rel="noopener">免费申请</a></small><input type="text" id="k-g" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.guardian || '')}"></label>
  <label>Google Gemini key<small>解释单词在句子里的意思。<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">免费申请</a></small><input type="text" id="k-a" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.gemini || '')}"></label>
  <p class="error" id="set-err" hidden></p>
  <div class="row"><button class="btn solid" id="save-k">保存</button></div>`;
  bindTheme();
  $('#save-k').onclick = () => {
    ls.set('keys', {guardian: $('#k-g').value.trim(), gemini: $('#k-a').value.trim()});
    store.feeds?.items.forEach(normalize); store.brief?.items.forEach(normalize);
    toast('已保存');
  };
}

/* ---------- shell ---------- */
function setTab(t) { document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); closeSheet(); }
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => ({brief: () => { renderBrief(); window.scrollTo(0, 0); syncNow(); }, live: showLive, words: showWords, settings: () => showSettings()})[b.dataset.tab]());
window.addEventListener('popstate', () => {
  closeSheet(); document.body.classList.remove('reading');
  if (lastView === 'live') { renderLive(); window.scrollTo(0, ls.get('liveScroll', 0)); }
  else { renderBrief(); window.scrollTo(0, ls.get('briefScroll', 0)); }
});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
/* Coming back to the app (next morning, or after a while) always checks for new content. */
let lastSync = 0;
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastSync > 6e4) { lastSync = Date.now(); syncNow(); } });
setInterval(() => { if (!document.hidden && !document.body.classList.contains('reading')) { lastSync = Date.now(); syncNow(); } }, 5 * 60e3);
window.addEventListener('error', () => {});
window.addEventListener('unhandledrejection', e => e.preventDefault());
applyTheme();
applySize();
(async () => {
  try { await loadCached(); } catch {}
  renderBrief();
  lastSync = Date.now();
  syncNow();
})();

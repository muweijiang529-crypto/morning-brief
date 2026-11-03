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
async function gemini(prompt, json = true) {
  let last;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'x-goog-api-key': keys().gemini},
          body: JSON.stringify({contents: [{parts: [{text: prompt}]}], generationConfig: {temperature: .2, ...(json ? {responseMimeType: 'application/json'} : {})}})
        });
      } catch { throw new ApiError('连不上 Gemini。检查网络后再试。'); }
      if (r.ok) {
        const data = await r.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (!text) { last = new ApiError('Gemini 没有返回内容。'); break; }
        if (!json) return text.trim();
        try { return JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim()); }
        catch { last = new ApiError('Gemini 返回的格式不对，再试一次。'); continue; }
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        const body = await r.text();
        if (r.status === 400 && !/api.?key/i.test(body)) { last = new ApiError('Gemini 拒绝了这次请求。'); break; }
        throw new ApiError('Gemini 的 key 不对。到设置里检查一下。', r.status);
      }
      last = new ApiError(r.status === 429 ? 'Gemini 请求太频繁或今天额度用完了。' : `Gemini 返回错误（${r.status}）。`, r.status);
      if (r.status === 404) break;
      await sleep(r.status === 429 ? 6000 * (attempt + 1) : 1500);
    }
  }
  throw last;
}

/* ---------- sources ---------- */
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
      out.push({source: 'New York Times', full: false, url: a.url, section: a.section, title: a.title, abstract: a.abstract, byline: a.byline || '', date: a.published_date});
    }
  }
  const seen = new Set();
  return out.filter(a => !seen.has(a.url) && seen.add(a.url)).slice(0, 40);
}
function mapGuardian(a) {
  return {source: 'The Guardian', full: true, gid: a.id, url: a.webUrl, section: a.sectionName, shortUrl: a.fields?.shortUrl || '',
    title: a.fields?.headline || a.webTitle, abstract: stripTags(a.fields?.trailText), byline: a.fields?.byline || '', date: a.webPublicationDate};
}
function stripTags(h) { return new DOMParser().parseFromString(h || '', 'text/html').body.textContent.trim(); }

const TOPICS = ['美国政治', '国际', '经济与科技', '气候与环境', '文化娱乐'];
async function buildBrief() {
  const results = await Promise.allSettled([fetchGuardian(), fetchNYT()]);
  const cands = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (!cands.length) throw new ApiError(failed[0] || '过去一天没有抓到新闻。');
  const list = cands.map((a, i) => ({i, source: a.source, section: a.section, title: a.title, abstract: (a.abstract || '').slice(0, 220)}));
  const res = await gemini(`你是一位给中文读者编早报的资深编辑。读者住在美国，想跟上美国和国际新闻，并融入美国社会，也关心娱乐文化。
从下面的候选新闻中选出最重要的 15 条，合起来 5–10 分钟读完。要求：
- 重要的事件优先，不选小众或琐碎内容；同一事件只留一条，优先留 source 为 The Guardian 的（有全文）。
- topic 只能从这些里选：${TOPICS.join('、')}。文化娱乐选 2–3 条，美国政治和国际占大头。
- zh_title：准确、不夸张的中文标题，不超过 28 个字。
- zh_summary：两句话的中文摘要，先说发生了什么，再说为什么重要或背景；对中国读者不熟悉的美国人名、机构要顺带说明。只使用候选内容里有的事实，不要补充，不要加入自己的立场。
- 按重要性排序，第一条是今天最重要的新闻。
只输出 JSON：{"items":[{"i":候选序号,"topic":"","zh_title":"","zh_summary":""}]}

候选：
${JSON.stringify(list)}`);
  const items = (res.items || []).filter(x => cands[x.i]).map(x => ({...cands[x.i], topic: TOPICS.includes(x.topic) ? x.topic : '国际', zhTitle: x.zh_title, zhSummary: x.zh_summary}));
  if (!items.length) throw new ApiError('Gemini 没有选出新闻，再试一次。');
  items.forEach((a, n) => a.id = `${today()}-${n}`);
  const brief = {date: today(), items, warning: failed[0] || '', read: []};
  await idb.set(`brief:${today()}`, brief);
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
  const mins = total ? Math.max(1, Math.round(b.items.slice(read ? 0 : 0).reduce((s, a) => s + a.zhSummary.length + a.zhTitle.length, 0) / 350)) : 0;
  return `<header class="mast"><h1 class="date">${d.getMonth()+1}月${d.getDate()}日，周${WEEK[d.getDay()]}</h1>
    <p class="sub">${total ? `昨天以来的 ${total} 条新闻，摘要约 ${mins} 分钟读完。已读 ${read} 条。` : '正在整理昨天以来的新闻。'}</p>
    <div class="horizon" aria-hidden="true"><div class="fill" style="width:${pct}%"></div><div class="sun" style="left:calc(14px + (100% - 28px) * ${pct / 100})"></div></div></header>`;
}
async function showBrief(force) {
  setTab('brief'); lastView = 'brief';
  document.body.classList.remove('reading');
  if (!keys().guardian || !keys().gemini) return showSettings(true);
  let b = force ? null : await idb.get(`brief:${today()}`);
  if (!b) {
    view.innerHTML = mastHTML(null) + '<p class="loading">正在抓取并翻译，第一次打开要等大约半分钟。</p>';
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
  const ks = (await idb.keys()).filter(k => String(k).startsWith('brief:')).sort();
  return ks.length ? idb.get(ks[ks.length - 1]) : null;
}
function renderBrief(b) {
  current = b; lastView = 'brief';
  b.items.forEach(a => registry.set(a.id, a));
  let html = mastHTML(b), lastTopic = null, first = true;
  if (b.warning) html += `<p class="note">${esc(b.warning)} 这期只用了能连上的来源。</p>`;
  const ordered = [];
  for (const t of TOPICS) b.items.filter(a => a.topic === t).forEach(a => ordered.push(a));
  for (const a of ordered) {
    if (a.topic !== lastTopic) { html += `<h2 class="topic">${esc(a.topic)}</h2>`; lastTopic = a.topic; }
    html += `<button class="item${first ? ' lead' : ''}${b.read.includes(a.id) ? ' read' : ''}" data-id="${esc(a.id)}"><h3>${esc(a.zhTitle)}</h3><p>${esc(a.zhSummary)}</p><div class="src">${esc(a.source)}${a.full ? '' : '，摘要'}</div></button>`;
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
  if (current && current.items.some(x => x.id === id) && !current.read.includes(id)) { current.read.push(id); idb.set(`brief:${current.date}`, current); }
  window.scrollTo(0, 0);
  view.innerHTML = `<button class="back" id="back">‹ 返回</button>
    <h1 class="art-zh-title">${esc(a.zhTitle || a.title)}</h1>
    <h2 class="art-en-title">${wrapWords(a.title)}</h2>
    <p class="art-meta">${esc(a.source)}${a.byline ? '，' + esc(a.byline) : ''}</p><div id="body"></div><div id="comments"></div>`;
  $('#back').onclick = () => history.back();
  if (a.full) return loadFull(a);
  $('#body').innerHTML = `<div class="pair"><p class="zh">${esc(a.zhSummary || '')}</p><p class="en">${wrapWords(a.abstract)}</p></div>
    <div class="paywall"><p class="note">《纽约时报》的接口只提供摘要。用图书馆证领取免费通行证后，可以读全文。</p>
    <div class="row"><a class="btn solid" href="${esc(a.url)}" target="_blank" rel="noopener">打开原文</a></div></div>`;
  $('#comments').innerHTML = '<h2 class="c-title">读者评论</h2><p class="note">《纽约时报》的评论只能在原文页面查看。</p>';
}
async function loadFull(a) {
  const body = $('#body'), key = `article:${a.id}`;
  let art = await idb.get(key);
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
    `<div class="row"><a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">在卫报打开原文</a></div>`;
  art.zh.forEach((z, i) => z && setZh(i, z));
  loadComments(a);
  translateRest(a, art, key, body);
}
function setZh(i, text) {
  const el = view.querySelector(`[data-z="${i}"]`);
  if (el) { el.textContent = text; el.classList.remove('wait'); }
}
async function translateRest(a, art, key, body) {
  const SIZE = 8;
  for (;;) {
    if (!body.isConnected) return;
    const todo = [];
    art.zh.forEach((z, i) => { if (!z && todo.length < SIZE) todo.push(i); });
    if (!todo.length) return;
    try {
      const res = await gemini(`把下面的英文新闻段落翻译成自然、准确的简体中文，供中文读者逐段对照。人名、机构名第一次出现时用常见中文译名。不要增删内容，不要合并段落。
文章标题：${a.title}
只输出 JSON：{"zh":["第1段译文", ...]}，数组长度必须是 ${todo.length}。
段落：${JSON.stringify(todo.map(i => art.en[i]))}`);
      if (!Array.isArray(res.zh) || res.zh.length !== todo.length) throw new ApiError('Gemini 返回的段落数不对。');
      todo.forEach((i, n) => { art.zh[i] = String(res.zh[n]); setZh(i, art.zh[i]); });
      await idb.set(key, art);
    } catch (e) {
      if (!body.isConnected) return;
      view.querySelectorAll('.zh.wait').forEach(el => el.textContent = '');
      const box = document.createElement('div');
      box.innerHTML = `<p class="error">后面的段落还没翻译：${esc(e.message)}</p><div class="row"><button class="btn">继续翻译</button></div>`;
      body.prepend(box);
      box.querySelector('button').onclick = () => { box.remove(); view.querySelectorAll('.zh.wait').forEach(el => el.textContent = '翻译中'); translateRest(a, art, key, body); };
      return;
    }
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
      const res = await gemini(`把下面的英文读者评论翻译成自然的简体中文，保留原有语气，不要删改。只输出 JSON：{"zh":[...]}，数组长度必须是 ${cs.length}。\n${JSON.stringify(cs.map(c => c.text))}`);
      cs.forEach((c, i) => { const el = box.querySelector(`[data-c="${i}"]`); if (el && res.zh?.[i]) { el.textContent = res.zh[i]; el.hidden = false; } });
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
function renderLive(note) {
  if (lastView !== 'live' || document.body.classList.contains('reading')) return;
  view.innerHTML = `<h1 class="page-title">实时新闻</h1><p class="note live-note">${esc(note)}</p>` + liveItems.map(a =>
    `<button class="item" data-id="${esc(a.id)}"><h3>${esc(a.zhTitle || a.title)}</h3><p>${esc(a.zhSummary || a.abstract)}</p><div class="src">${esc(a.source)}，${ago(a.date)}</div></button>`).join('');
  view.querySelectorAll('.item').forEach(el => el.onclick = () => showArticle(el.dataset.id));
}
async function refreshLive() {
  let note = '';
  const rs = await Promise.allSettled([fetchLiveGuardian(), fetchLiveNYT()]);
  const fresh = rs.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const fail = rs.find(r => r.status === 'rejected');
  if (!fresh.length) { if (lastView === 'live' && !liveItems.length) { view.innerHTML = `<h1 class="page-title">实时新闻</h1><p class="error">${esc(fail?.reason?.message || '暂时没有抓到新闻。')}</p><div class="row"><button class="btn solid" id="live-retry">再试一次</button></div>`; $('#live-retry').onclick = refreshLive; } return; }
  const zh = (await idb.get('liveZh')) || {};
  fresh.sort((a, b) => new Date(b.date) - new Date(a.date));
  liveItems = fresh.slice(0, 40);
  liveItems.forEach(a => { a.id = 'live-' + a.url; Object.assign(a, zh[a.url] || {}); registry.set(a.id, a); });
  const time = new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
  note = `${time} 更新，打开时每 5 分钟自动刷新。${fail ? fail.reason.message : ''}`;
  renderLive(note);
  const todo = liveItems.filter(a => !a.zhTitle).slice(0, 20);
  if (!todo.length) return;
  try {
    const res = await gemini(`把这些英文新闻翻译成简体中文。zh_title 是准确、不夸张的标题；zh_summary 是一句话摘要，只用给出的内容。只输出 JSON：{"items":[{"zh_title":"","zh_summary":""}]}，数组长度必须是 ${todo.length}。\n${JSON.stringify(todo.map(a => ({title: a.title, abstract: (a.abstract || '').slice(0, 220)})))}`);
    todo.forEach((a, i) => { const r = res.items?.[i]; if (r?.zh_title) { a.zhTitle = r.zh_title; a.zhSummary = r.zh_summary; zh[a.url] = {zhTitle: a.zhTitle, zhSummary: a.zhSummary}; } });
    const keep = {}; liveItems.forEach(a => { if (zh[a.url]) keep[a.url] = zh[a.url]; });
    await idb.set('liveZh', keep);
    renderLive(note);
  } catch (e) { renderLive(`${note} 中文翻译暂时不可用：${e.message}`); }
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
    } catch (e) { box.textContent = e.message; btn.disabled = false; }
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
    $('#st').textContent = await gemini(`把这段英文翻译成简体中文。如果是习语或固定搭配，再用一句话解释它的用法。只输出这些内容，不用 Markdown。\n${JSON.stringify(text)}`, false);
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
  <p class="note">这些 key 都免费，只保存在这台手机上。</p>
  <label>卫报 Guardian key（必填）<small>提供全文。<a href="https://bonobo.capi.gutools.co.uk/register/developer" target="_blank" rel="noopener">免费申请</a></small><input type="text" id="k-g" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.guardian || '')}"></label>
  <label>Google Gemini key（必填）<small>负责选新闻和翻译。<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">免费申请</a></small><input type="text" id="k-a" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(k.gemini || '')}"></label>
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
window.addEventListener('popstate', () => { closeSheet(); document.body.classList.remove('reading'); if (lastView === 'live') { const y = ls.get('liveScroll', 0); renderLive('返回列表。'); window.scrollTo(0, y); } else if (current) renderBrief(current); else showBrief(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
applyTheme();
showBrief();

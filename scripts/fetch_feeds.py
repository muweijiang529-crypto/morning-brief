#!/usr/bin/env python3
"""Runs in the cloud: collect public feeds, translate new headlines and summaries, build the morning brief.
Phones only read the finished JSON, so opening the app never waits for this work.
Full text is kept only for outlets that publish under a republishing licence."""
import concurrent.futures as cf, email.utils, hashlib, html, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

DATA_URL = 'https://raw.githubusercontent.com/muweijiang529-crypto/morning-brief/data/'
NY = ZoneInfo('America/New_York')
TOPICS = ['美国政治', '国际', '经济与科技', '气候与环境', '文化娱乐']
BRIEF_SIZE = 18
BRIEF_HOUR = 5        # first run after 5:00 New York time builds the day's brief
KEEP_HOURS = 72
MAX_ITEMS = 1200
TRANSLATE_BUDGET = 700
STARTED = time.time()
DEADLINE = STARTED + 8 * 60

def gn(site, extra=''):
    q = urllib.parse.quote(f'site:{site} {extra}when:2d'.strip())
    return f'https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en'

# (source, url, topic, side, keeps full text)
FEEDS = [
 ('New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', '美国政治', 'us', 0),
 ('New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', '美国政治', 'us', 0),
 ('New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', '国际', 'us', 0),
 ('New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml', '气候与环境', 'us', 0),
 ('New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml', '文化娱乐', 'us', 0),
 ('The Guardian', 'https://www.theguardian.com/us-news/rss', '美国政治', 'intl', 0),
 ('The Guardian', 'https://www.theguardian.com/world/rss', '国际', 'intl', 0),
 ('The Guardian', 'https://www.theguardian.com/business/rss', '经济与科技', 'intl', 0),
 ('The Guardian', 'https://www.theguardian.com/technology/rss', '经济与科技', 'intl', 0),
 ('The Guardian', 'https://www.theguardian.com/environment/rss', '气候与环境', 'intl', 0),
 ('The Guardian', 'https://www.theguardian.com/culture/rss', '文化娱乐', 'intl', 0),
 ('BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml', '国际', 'intl', 0),
 ('BBC', 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', '美国政治', 'intl', 0),
 ('BBC', 'https://feeds.bbci.co.uk/news/business/rss.xml', '经济与科技', 'intl', 0),
 ('BBC', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', '气候与环境', 'intl', 0),
 ('BBC', 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', '文化娱乐', 'intl', 0),
 ('NPR', 'https://feeds.npr.org/1014/rss.xml', '美国政治', 'us', 0),
 ('NPR', 'https://feeds.npr.org/1004/rss.xml', '国际', 'us', 0),
 ('NPR', 'https://feeds.npr.org/1008/rss.xml', '文化娱乐', 'us', 0),
 ('PBS NewsHour', 'https://www.pbs.org/newshour/feeds/rss/politics', '美国政治', 'us', 0),
 ('Politico', 'https://rss.politico.com/politics-news.xml', '美国政治', 'us', 0),
 ('The Hill', 'https://thehill.com/feed/', '美国政治', 'us', 0),
 ('Fox News', 'https://moxie.foxnews.com/google-publisher/politics.xml', '美国政治', 'us', 0),
 ('CBS News', 'https://www.cbsnews.com/latest/rss/main', '美国政治', 'us', 0),
 ('Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', '国际', 'intl', 0),
 ('DW', 'https://rss.dw.com/xml/rss-en-all', '国际', 'intl', 0),
 ('The Independent', 'https://www.independent.co.uk/news/world/rss', '国际', 'intl', 0),
 ('NBC News', 'https://feeds.nbcnews.com/nbcnews/public/news', '美国政治', 'us', 0),
 ('France 24', 'https://www.france24.com/en/rss', '国际', 'intl', 0),
 ('Variety', 'https://variety.com/feed/', '文化娱乐', 'us', 0),
 # Official feeds with summaries come first, so duplicates from search keep the summary.
 ('Wall Street Journal', 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', '国际', 'us', 0),
 ('Wall Street Journal', 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', '经济与科技', 'us', 0),
 ('Bloomberg', 'https://feeds.bloomberg.com/politics/news.rss', '美国政治', 'us', 0),
 ('Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss', '经济与科技', 'us', 0),
 ('China Daily 中国日报', 'https://www.chinadaily.com.cn/rss/china_rss.xml', '国际', 'cn', 0),
 ('China Daily 中国日报', 'https://www.chinadaily.com.cn/rss/world_rss.xml', '国际', 'cn', 0),
 ('Global Times 环球时报', 'https://www.globaltimes.cn/rss/outbrain.xml', '国际', 'cn', 0),
 ('Xinhua 新华社', 'https://english.news.cn/rss/worldrss.xml', '国际', 'cn', 0),
 ('Washington Post', 'https://feeds.washingtonpost.com/rss/politics', '美国政治', 'us', 0),
 ('Washington Post', 'https://feeds.washingtonpost.com/rss/world', '国际', 'us', 0),
 ('Washington Post', gn('washingtonpost.com'), '美国政治', 'us', 0),
 ('Associated Press', gn('apnews.com'), '美国政治', 'us', 0),
 ('Reuters', gn('reuters.com'), '国际', 'intl', 0),
 ('Wall Street Journal', gn('wsj.com'), '经济与科技', 'us', 0),
 ('Bloomberg', gn('bloomberg.com'), '经济与科技', 'us', 0),
 ('Xinhua 新华社', gn('english.news.cn'), '国际', 'cn', 0),
 ('China Daily 中国日报', gn('chinadaily.com.cn'), '国际', 'cn', 0),
 ('Global Times 环球时报', gn('globaltimes.cn'), '国际', 'cn', 0),
 ('SCMP 南华早报', 'https://www.scmp.com/rss/91/feed', '国际', 'cn', 0),
 ('ProPublica', 'https://www.propublica.org/feeds/propublica/main', '美国政治', 'us', 1),
 ('The Conversation', 'https://theconversation.com/us/articles.atom', '经济与科技', 'us', 1),
 ('Global Voices', 'https://globalvoices.org/feed/', '国际', 'intl', 1),
]
PER_FEED = 20
MC = '{http://purl.org/rss/1.0/modules/content/}encoded'
ATOM = '{http://www.w3.org/2005/Atom}'
DC = '{http://purl.org/dc/elements/1.1/}'
MEDIA = '{http://search.yahoo.com/mrss/}'
UA = {'User-Agent': 'Mozilla/5.0 (personal news reader)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*'}
TOPIC_WORDS = [
 ('气候与环境', r'climate|emission|carbon|wildfire|flood|hurricane|drought|renewable|solar|cop3\d|pollution|environment'),
 ('文化娱乐', r'film|movie|oscar|grammy|emmy|album|actor|actress|singer|box office|netflix|broadway|taylor swift|tv show|festival'),
 ('经济与科技', r'\bai\b|openai|chip|tariff|inflation|stocks?|markets?|fed\b|earnings|economy|startup|tesla|nvidia|bitcoin|crypto|bank'),
]

def http(url, data=None, headers=None, timeout=25):
    rq = urllib.request.Request(url, data=data, headers=headers or UA)
    with urllib.request.urlopen(rq, timeout=timeout) as r:
        return r.read()

def text(h):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', h or ''))).strip()

def paragraphs(h):
    ps = [text(x) for x in re.findall(r'<(?:p|h2)\b[^>]*>(.*?)</(?:p|h2)>', h or '', re.S | re.I)]
    return [p for p in ps if len(p) > 1]

def when(s):
    if not s: return None
    try:
        d = email.utils.parsedate_to_datetime(s)
    except Exception:
        try: d = datetime.fromisoformat(s.strip().replace('Z', '+00:00'))
        except Exception: return None
    if d.tzinfo is None: d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)

def image_of(e, raw_html):
    best, size = '', -1
    for c in e:
        if c.tag in (MEDIA + 'content', MEDIA + 'thumbnail') or c.tag == 'enclosure':
            u = c.get('url') or ''
            kind = c.get('type') or c.get('medium') or 'image'
            if not u.startswith('https://') or 'image' not in kind: continue
            w = int(re.sub(r'\D', '', c.get('width') or '') or 1)
            if w > size: best, size = u, w
        elif c.tag == MEDIA + 'group':
            found = image_of(c, '')
            if found: best = best or found
    if not best:
        m = re.search(r'<img[^>]+src=["\'](https://[^"\']+)', raw_html or '')
        if m and not re.search(r'pixel|tracker|feedburner|1x1', m.group(1)): best = m.group(1)
    return html.unescape(best)

def guardian_id(url):
    m = re.match(r'https://www\.theguardian\.com/(.+)$', url)
    return m.group(1).split('?')[0] if m else ''

def parse(xml, source, topic, side, licensed):
    root = ET.fromstring(xml)
    entries = [e for e in root.iter() if e.tag.split('}')[-1] in ('item', 'entry')]
    out, cutoff = [], time.time() - KEEP_HOURS * 3600
    for e in entries:
        g = lambda *names: next((c.text for c in e if c.tag in names and c.text), '')
        title = text(g('title', ATOM + 'title'))
        link = g('link')
        if not link:
            for c in e:
                if c.tag == ATOM + 'link' and c.get('rel', 'alternate') == 'alternate': link = c.get('href'); break
        d = when(g('pubDate', DC + 'date', ATOM + 'published', ATOM + 'updated'))
        if not title or not link or (d and d.timestamp() < cutoff): continue
        summary = g('description', 'summary', ATOM + 'summary')
        full = g(MC, ATOM + 'content')
        link = link.strip()
        if 'news.google.com' in link:
            title = re.sub(r'\s+[-–|]\s+[^-–|]{2,60}$', '', title); summary = ''
        it = {'id': hashlib.sha1(link.encode()).hexdigest()[:14], 'source': source, 'url': link, 'title': title,
              'abstract': text(summary)[:320], 'topic': topic, 'side': side, 'date': (d or datetime.now(timezone.utc)).isoformat()}
        img = image_of(e, (summary or '') + (full or ''))
        if img: it['image'] = img
        if source == 'The Guardian':
            gid = guardian_id(link)
            if gid: it['gid'] = gid
        if licensed:
            ps = paragraphs(full or summary)
            if sum(map(len, ps)) > 800: it['paras'] = ps
        hay = f"{title} {it['abstract']}".lower()
        if topic in ('美国政治', '国际'):
            for t, rx in TOPIC_WORDS:
                if re.search(rx, hay): it['topic'] = t; break
        out.append(it)
        if len(out) >= PER_FEED: break
    return out

def fetch(f):
    source, url, topic, side, licensed = f
    last = ''
    for attempt in range(2):
        try:
            return f, parse(http(url), source, topic, side, licensed), None
        except Exception as e:
            last = f'{type(e).__name__}: {e}'
            time.sleep(1)
    return f, [], last

def load_previous(name):
    try:
        return json.loads(http(f'{DATA_URL}{name}?t={int(time.time())}'))
    except Exception as e:
        print(f'No previous {name}: {e}')
        return {}

def gt(s):
    u = 'https://translate.googleapis.com/translate_a/single?' + urllib.parse.urlencode({'client': 'gtx', 'sl': 'en', 'tl': 'zh-CN', 'dt': 't', 'q': s})
    for attempt in range(3):
        try:
            return ''.join(x[0] for x in json.loads(http(u, timeout=15))[0] if x[0])
        except Exception as e:
            if attempt == 2: raise
            time.sleep(1.5 * (attempt + 1))

def gemini(prompt, want_json=True):
    key = os.environ.get('GEMINI_API_KEY')
    if not key: raise RuntimeError('GEMINI_API_KEY is not set')
    last = None
    for model in ('gemini-flash-latest', 'gemini-flash-lite-latest'):
        for attempt in range(3):
            try:
                body = {'contents': [{'parts': [{'text': prompt}]}], 'generationConfig': {'temperature': .2}}
                if want_json: body['generationConfig']['responseMimeType'] = 'application/json'
                raw = http(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', json.dumps(body).encode(),
                           {'Content-Type': 'application/json', 'x-goog-api-key': key}, timeout=150)
                t = ''.join(p.get('text', '') for p in json.loads(raw)['candidates'][0]['content']['parts'])
                return json.loads(re.sub(r'^\s*```(?:json)?|```\s*$', '', t)) if want_json else t
            except urllib.error.HTTPError as e:
                last = f'HTTP {e.code}'
                print(f'Gemini {model}: {last}')
                if e.code in (400, 401, 403, 404): break
                time.sleep(8 * (attempt + 1))
            except Exception as e:
                last = f'{type(e).__name__}'
                print(f'Gemini {model}: {last}')
                time.sleep(3)
    raise RuntimeError(f'Gemini failed: {last}')

def translate_new(items):
    todo = [a for a in items if not a.get('zh_title')][:TRANSLATE_BUDGET]
    errors = [0]
    def one(a):
        if time.time() > DEADLINE: return
        try:
            a['zh_title'] = gt(a['title'])
            if a['abstract']: a['zh_summary'] = gt(a['abstract'])
        except Exception:
            errors[0] += 1
    with cf.ThreadPoolExecutor(6) as ex:
        list(ex.map(one, todo))
    missing = [a for a in items if not a.get('zh_title')][:60]
    if missing and os.environ.get('GEMINI_API_KEY') and time.time() < DEADLINE:
        try:
            res = gemini('把这些英文新闻标题翻译成准确的简体中文。只输出 JSON：{"zh":[...]}，数组长度必须是 %d。\n%s' % (len(missing), json.dumps([a['title'] for a in missing], ensure_ascii=False)))
            for a, z in zip(missing, res.get('zh', [])):
                if z: a['zh_title'] = z
        except Exception as e:
            print('Gemini fallback failed:', e)
    print(f'Translated {len(todo)} new, {errors[0]} errors')
    return errors[0]

def rotation(pool, n):
    """Plain fallback when AI is unavailable: rotate across topics and sources."""
    picked, seen = [], set()
    quota = dict(zip(TOPICS, (5, 6, 3, 2, 2)))
    for a in pool:
        k = (a['source'], a['topic'])
        if k in seen or quota.get(a['topic'], 0) <= 0 or not a.get('zh_title'): continue
        seen.add(k); quota[a['topic']] -= 1; picked.append(dict(a))
        if len(picked) >= n: break
    return picked

def build_brief(items):
    cutoff = time.time() - 30 * 3600
    per, pool = {}, []
    for a in items:
        if datetime.fromisoformat(a['date']).timestamp() < cutoff: continue
        per[a['source']] = per.get(a['source'], 0) + 1
        if per[a['source']] <= 10: pool.append(a)
    if not pool: raise RuntimeError('No recent items')
    listing = [{'i': i, 'source': a['source'], 'title': a['title'], 'abstract': a['abstract'][:140]} for i, a in enumerate(pool)]
    prompt = f"""你是一位给中文读者编早报的资深编辑。读者住在美国，想跟上美国和国际新闻，并融入美国社会，也关心娱乐文化。
从下面的候选新闻中选出最重要的 {BRIEF_SIZE} 条，合起来 5–10 分钟读完。要求：
- 重要的事件优先，不选小众或琐碎内容；同一事件只留一条。
- 来源尽量多样；同一来源不超过 4 条；优先选有摘要的；中美都报道的重大议题可以选。
- topic 只能从这些里选：{'、'.join(TOPICS)}。文化娱乐选 2–3 条，美国政治和国际占大头。
- zh_title：准确、不夸张的中文标题，不超过 24 个字。
- zh_summary：凝练的中文摘要，不超过 60 个字，说清发生了什么和为什么重要；陌生的美国人名、机构顺带说明。只使用候选内容里有的事实，没有摘要的只概括标题，不要补充，不要加入自己的立场。
- 按重要性排序，第一条是今天最重要的新闻。
只输出 JSON：{{"items":[{{"i":候选序号,"topic":"","zh_title":"","zh_summary":""}}]}}

候选：
{json.dumps(listing, ensure_ascii=False)}"""
    ai = True
    try:
        res = gemini(prompt)
        out = []
        for x in res.get('items', []):
            i = x.get('i')
            if not isinstance(i, int) or not 0 <= i < len(pool): continue
            a = dict(pool[i])
            a.update(zh_title=x.get('zh_title') or a.get('zh_title') or a['title'], zh_summary=x.get('zh_summary') or a.get('zh_summary', ''))
            if x.get('topic') in TOPICS: a['topic'] = x['topic']
            out.append(a)
        if len(out) < 8: raise RuntimeError('Too few items')
    except Exception as e:
        print('Brief falls back to rotation:', e)
        ai, out = False, rotation(pool, BRIEF_SIZE)
    return out, ai

def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else 'out'
    os.makedirs(out_dir, exist_ok=True)
    prev, prev_brief = load_previous('feeds.json'), load_previous('brief.json')
    known = {a['url']: a for a in prev.get('items', [])}
    fresh, seen, counts, failures = [], set(), {}, {}
    with cf.ThreadPoolExecutor(10) as ex:
        for f, got, err in ex.map(fetch, FEEDS):
            print(f'{f[0]:26} {len(got):3} {err or ""}')
            counts[f[0]] = counts.get(f[0], 0) + len(got)
            if err: failures[f[0]] = err[:120]
            fresh.extend(got)
    if not fresh and not known: sys.exit('No feed returned anything')
    cutoff = datetime.now(timezone.utc) - timedelta(hours=KEEP_HOURS)
    items = []
    for a in fresh + list(known.values()):
        key = re.sub(r'\W+', '', a['title'].lower())
        if key in seen or a['url'] in seen: continue
        seen.add(key); seen.add(a['url'])
        old = known.get(a['url'])
        if old:
            for k in ('zh_title', 'zh_summary', 'date'):
                if old.get(k): a[k] = old[k]
        if datetime.fromisoformat(a['date']) >= cutoff: items.append(a)
    items.sort(key=lambda x: x['date'], reverse=True)
    items = items[:MAX_ITEMS]
    errs = translate_new(items)

    now = datetime.now(NY)
    today = now.strftime('%Y-%m-%d')
    brief = prev_brief
    stale = prev_brief.get('date') != today
    retry_ai = not stale and not prev_brief.get('ai') and os.environ.get('GEMINI_API_KEY')
    if now.hour >= BRIEF_HOUR and (stale or retry_ai):
        chosen, ai = build_brief(items)
        brief = {'date': today, 'built': datetime.now(timezone.utc).isoformat(), 'ai': ai, 'items': chosen}
        print(f'Brief for {today}: {len(chosen)} items, ai={ai}')
    if not brief.get('items'):
        chosen, ai = build_brief(items)
        brief = {'date': today if now.hour >= BRIEF_HOUR else (now - timedelta(days=1)).strftime('%Y-%m-%d'), 'built': datetime.now(timezone.utc).isoformat(), 'ai': ai, 'items': chosen}

    done = sum(1 for a in items if a.get('zh_title'))
    stat = {'updated': datetime.now(timezone.utc).isoformat(), 'total': len(items), 'translated': done, 'translate_errors': errs,
            'counts': counts, 'failures': failures, 'seconds': int(time.time() - STARTED)}
    print(json.dumps(stat, ensure_ascii=False))
    json.dump({**stat, 'items': items}, open(f'{out_dir}/feeds.json', 'w', encoding='utf8'), ensure_ascii=False, separators=(',', ':'))
    json.dump(brief, open(f'{out_dir}/brief.json', 'w', encoding='utf8'), ensure_ascii=False, separators=(',', ':'))

if __name__ == '__main__':
    main()

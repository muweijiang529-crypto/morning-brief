#!/usr/bin/env python3
"""Collect headlines, short summaries and links from public RSS feeds into feeds.json.
Full text is kept only for outlets that publish under a republishing licence."""
import concurrent.futures as cf, email.utils, html, json, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

def gn(site, extra=''):
    q = urllib.parse.quote(f'site:{site} {extra}when:2d'.strip())
    return f'https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en'

# (source, url, topic, side, keeps full text)
FEEDS = [
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
 ('DW', 'https://rss.dw.com/rdf/rss-en-all', '国际', 'intl', 0),
 ('France 24', 'https://www.france24.com/en/rss', '国际', 'intl', 0),
 ('Variety', 'https://variety.com/feed/', '文化娱乐', 'us', 0),
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
PER_FEED = 12
MC = '{http://purl.org/rss/1.0/modules/content/}encoded'
ATOM = '{http://www.w3.org/2005/Atom}'
DC = '{http://purl.org/dc/elements/1.1/}'

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

def parse(xml, source, topic, side, licensed):
    root = ET.fromstring(xml)
    entries = [e for e in root.iter() if e.tag.split('}')[-1] in ('item', 'entry')]
    out, cutoff = [], time.time() - 60 * 3600
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
        google = 'news.google.com' in link
        if google:
            title = re.sub(r'\s+[-–|]\s+[^-–|]{2,60}$', '', title); summary = ''
        it = {'source': source, 'url': link.strip(), 'title': title, 'abstract': text(summary)[:300], 'topic': topic, 'side': side,
              'date': (d or datetime.now(timezone.utc)).isoformat()}
        if licensed:
            ps = paragraphs(full or summary)
            if sum(map(len, ps)) > 800: it['paras'] = ps
        out.append(it)
        if len(out) >= PER_FEED: break
    return out

def fetch(f):
    source, url, topic, side, licensed = f
    try:
        rq = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (personal news reader)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*'})
        with urllib.request.urlopen(rq, timeout=25) as r:
            return f, parse(r.read(), source, topic, side, licensed), None
    except Exception as e:
        return f, [], f'{type(e).__name__}: {e}'

def main():
    items, seen, report = [], set(), {}
    with cf.ThreadPoolExecutor(10) as ex:
        for f, got, err in ex.map(fetch, FEEDS):
            print(f'{f[0]:26} {len(got):3} {err or ""}')
            report[f[0]] = report.get(f[0], 0) + len(got)
            for it in got:
                key = re.sub(r'\W+', '', it['title'].lower())
                if key in seen: continue
                seen.add(key); items.append(it)
    items.sort(key=lambda x: x['date'], reverse=True)
    if not items: sys.exit('No feed returned anything')
    json.dump({'items': items, 'counts': report}, open('feeds.json', 'w', encoding='utf8'), ensure_ascii=False, separators=(',', ':'))

if __name__ == '__main__':
    main()

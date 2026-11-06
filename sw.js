const V='chendu-v7',SHELL=['./','index.html','app.js','style.css','fonts.css','dict.json','manifest.webmanifest','icons/192.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
/* Same-site files: prefer the newest version if it arrives within 2 seconds, otherwise open from the phone. */
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.origin!==location.origin||e.request.method!=='GET')return;
 e.respondWith(caches.open(V).then(async c=>{const hit=await c.match(e.request,{ignoreSearch:true});
  const net=fetch(e.request).then(r=>{if(r.ok)c.put(e.request,r.clone());return r});
  if(!hit)return net;
  e.waitUntil(net.catch(()=>{}));
  return Promise.race([net.catch(()=>hit),new Promise(res=>setTimeout(()=>res(hit),2000))])}))});

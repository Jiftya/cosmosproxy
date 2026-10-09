/**
 * Cosmos proxy - simple Cloudflare Worker
 *
 * Usage:  https://YOUR-WORKER.workers.dev/https://example.com/page
 * (same "PROXY + url" format the Cosmos page already uses)
 *
 * What it does:
 *  - fetches the target site server-side
 *  - strips headers that block embedding (X-Frame-Options, CSP, etc.)
 *  - adds permissive CORS headers
 *  - rewrites HTML links/resources so they route back through the proxy
 *  - injects a small script that proxies fetch/XHR/dynamic elements and
 *    reports the real page address to the parent window ("cosmos-url")
 *  - falls back to the Referer header for root-relative requests like /app.js
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
};

// Response headers that would break embedding or leak state across sites
const STRIP = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'set-cookie',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'referrer-policy',
  'report-to',
  'nel',
  'strict-transport-security',
  'permissions-policy',
];

// Request headers we pass along to the target
const FORWARD = [
  'accept',
  'accept-language',
  'content-type',
  'range',
  'if-none-match',
  'if-modified-since',
  'user-agent',
];

// Script injected at the top of every proxied HTML page.
// (No backslashes or backticks in here on purpose - it lives in a template string.)
const INJECT = `(function(){
if(window.__cosmos)return;window.__cosmos=1;
var O=location.origin+'/';
function real(){var s=location.href;return s.indexOf(O)===0?s.slice(O.length):s}
function abs(u){
  try{
    if(u&&u.url)u=u.url;
    if(u==null)return u;
    var s=String(u);
    if(s.charAt(0)==='#')return u;
    var r=new URL(s,real());
    if(r.protocol!=='http:'&&r.protocol!=='https:')return u;
    return r.href.indexOf(O)===0?r.href:O+r.href;
  }catch(e){return u}
}
function rep(){try{parent.postMessage({type:'cosmos-url',url:real()},'*')}catch(e){}}

var f=window.fetch;
if(f)window.fetch=function(i,n){
  try{
    if(typeof i==='string'||i instanceof URL)i=abs(i);
    else if(i&&i.url)i=new Request(abs(i.url),i);
  }catch(e){}
  return f.call(this,i,n);
};

var xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  var a=[].slice.call(arguments);a[1]=abs(u);return xo.apply(this,a);
};

var wo=window.open;
window.open=function(u){
  var a=[].slice.call(arguments);if(u)a[0]=abs(u);return wo.apply(this,a);
};

['pushState','replaceState'].forEach(function(k){
  var o=history[k];
  history[k]=function(s,t,u){
    if(u!=null)u=abs(u);
    var r=o.call(this,s,t,u);rep();return r;
  };
});

[[HTMLScriptElement,'src'],[HTMLImageElement,'src'],[HTMLIFrameElement,'src'],
 [HTMLLinkElement,'href'],[HTMLSourceElement,'src'],[HTMLMediaElement,'src'],
 [HTMLAnchorElement,'href'],[HTMLFormElement,'action']].forEach(function(p){
  try{
    var d=Object.getOwnPropertyDescriptor(p[0].prototype,p[1]);
    if(!d||!d.set)return;
    Object.defineProperty(p[0].prototype,p[1],{
      get:d.get,
      set:function(v){d.set.call(this,abs(v))},
      configurable:true,enumerable:d.enumerable
    });
  }catch(e){}
});

var sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
  var l=String(n).toLowerCase();
  if((l==='src'||l==='href'||l==='action')&&this.tagName!=='BASE'&&this.namespaceURI==='http://www.w3.org/1999/xhtml')v=abs(v);
  return sa.call(this,n,v);
};

addEventListener('popstate',rep);
addEventListener('hashchange',rep);
rep();
})();`;

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (e) {
      return text('Proxy error: ' + (e && e.message ? e.message : e), 502);
    }
  },
};

async function handle(request) {
  const self = new URL(request.url);
  const proxy = self.origin + '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Work out the target address
  let raw = request.url.slice(proxy.length);
  if (!/^https?:/i.test(raw) && self.searchParams.has('url')) {
    raw = self.searchParams.get('url');
  }
  if (/^https?%3A/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch (e) {}
  }
  // some servers/clients collapse "https://" to "https:/"
  raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');

  // Root-relative request with no target (e.g. /app.js): use the Referer to find the site
  if (!/^https?:\/\//i.test(raw)) {
    const ref = request.headers.get('referer') || '';
    if (ref.indexOf(proxy) === 0) {
      let base = ref.slice(proxy.length).replace(/^(https?):\/(?!\/)/i, '$1://');
      try {
        const resolved = new URL(self.pathname + self.search, base);
        return new Response(null, {
          status: 307,
          headers: { ...CORS, location: proxy + resolved.href },
        });
      } catch (e) {
        return text('Bad request: could not work out the target site.', 400);
      }
    }
    return text(
      'Cosmos proxy is running.\n\nUsage: ' + proxy + 'https://example.com\n',
      200
    );
  }

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return text('Bad request: invalid URL.', 400);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return text('Bad request: only http(s) is supported.', 400);
  }
  if (blocked(target.hostname, self.hostname)) {
    return text('Blocked: that address is not allowed.', 403);
  }

  // Build the upstream request
  const headers = new Headers();
  for (const k of FORWARD) {
    const v = request.headers.get(k);
    if (v) headers.set(k, v);
  }
  headers.set('referer', target.origin + '/');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (hasBody) headers.set('origin', target.origin);

  const upstream = await fetch(target.href, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });

  // Redirects: send the browser back through the proxy
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const loc = upstream.headers.get('location');
    if (loc) {
      let next = loc;
      try { next = proxy + new URL(loc, target.href).href; } catch (e) {}
      const h = new Headers(CORS);
      h.set('location', next);
      return new Response(null, { status: upstream.status, headers: h });
    }
  }

  const out = new Headers(upstream.headers);
  for (const h of STRIP) out.delete(h);
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);

  const ct = (out.get('content-type') || '').toLowerCase();
  const res = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });

  if (ct.indexOf('text/html') !== -1) {
    out.delete('content-length');
    out.delete('etag');
    return rewriteHtml(res, target, proxy);
  }
  return res;
}

function rewriteHtml(res, target, proxy) {
  let base = target.href;
  let injected = false;

  const rw = (val) => {
    if (val == null) return val;
    const v = String(val).trim();
    if (!v || v.charAt(0) === '#') return val;
    if (/^(data:|blob:|javascript:|mailto:|tel:|about:)/i.test(v)) return val;
    try {
      const u = new URL(v, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return val;
      if (u.href.indexOf(proxy) === 0) return u.href;
      return proxy + u.href;
    } catch (e) {
      return val;
    }
  };

  const attr = (name) => ({
    element(el) {
      const v = el.getAttribute(name);
      if (v != null) el.setAttribute(name, rw(v));
    },
  });

  const srcset = {
    element(el) {
      const v = el.getAttribute('srcset');
      if (!v) return;
      const fixed = v
        .split(',')
        .map((part) => {
          const bits = part.trim().split(/\s+/);
          if (bits[0]) bits[0] = rw(bits[0]);
          return bits.join(' ');
        })
        .join(', ');
      el.setAttribute('srcset', fixed);
    },
  };

  const inject = {
    element(el) {
      if (injected) return;
      injected = true;
      el.prepend('<script>' + INJECT + '</script>', { html: true });
    },
  };

  return new HTMLRewriter()
    .on('base', {
      element(el) {
        const h = el.getAttribute('href');
        if (h) {
          try { base = new URL(h, base).href; } catch (e) {}
        }
        el.remove();
      },
    })
    .on('head', inject)
    .on('body', inject)
    .on('a, area, link', attr('href'))
    .on('script, img, iframe, frame, embed, source, video, audio, track, input', attr('src'))
    .on('form', attr('action'))
    .on('video', attr('poster'))
    .on('object', attr('data'))
    .on('img, source', srcset)
    .on('[integrity]', {
      element(el) { el.removeAttribute('integrity'); },
    })
    .on('meta', {
      element(el) {
        const he = (el.getAttribute('http-equiv') || '').toLowerCase();
        const nm = (el.getAttribute('name') || '').toLowerCase();
        if (he === 'content-security-policy' || nm === 'referrer') {
          el.remove();
          return;
        }
        if (he === 'refresh') {
          const c = el.getAttribute('content') || '';
          const m = c.match(/^(\s*[\d.]*\s*;\s*url\s*=\s*)(.+)$/i);
          if (m) {
            el.setAttribute('content', m[1] + rw(m[2].replace(/^['"]|['"]$/g, '')));
          }
        }
      },
    })
    .transform(res);
}

// Don't let the proxy be pointed at itself or at private/internal addresses
function blocked(host, selfHost) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === selfHost.toLowerCase()) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    const a = p[0], b = p[1];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (h.indexOf(':') !== -1) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe80/.test(h);
  }
  return false;
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
  });
}

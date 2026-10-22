// Page-side scripts. The WAA service lookup follows AIStudio2API (see NOTICE).
export const INSTALL = `(() => {
  if (window.__magpieStudio) return;
  const state = window.__magpieStudio = {headers: {}, requests: new Map(), bootstrap: false};
  const nativeFetch = window.fetch.bind(window);
  state.fetch = nativeFetch;
  const matches = url => {
    try { return new URL(url, location.href).pathname.endsWith('MakerSuiteService/GenerateContent'); }
    catch { return false; }
  };
  const record = (headers, body) => {
    for (const [name, value] of new Headers(headers)) {
      if (/^(authorization|x-goog-|x-aistudio-|x-user-agent|content-type)/i.test(name)) state.headers[name] = value;
    }
    state.body = typeof body === 'string' ? body : null;
  };
  window.fetch = async function(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    if (state.bootstrap && matches(url)) {
      record(init?.headers ?? (input instanceof Request ? input.headers : {}), init?.body ?? (input instanceof Request ? await input.clone().text() : null));
      state.captured = true;
      throw new DOMException('Bootstrap captured locally', 'AbortError');
    }
    return nativeFetch(input, init);
  };
  const open = XMLHttpRequest.prototype.open;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  const send = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    requests.set(this, {url: String(url), headers: {}});
    return open.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const req = requests.get(this);
    if (req) req.headers[name] = value;
    return setHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const req = requests.get(this);
    if (state.bootstrap && req && matches(req.url)) {
      record(req.headers, body);
      state.captured = true;
      this.abort();
      return;
    }
    return send.call(this, body);
  };
  state.hook = () => {
    const suite = window.default_MakerSuite;
    if (!suite) return false;
    if (state.snapshotKey && suite[state.snapshotKey]?.__magpieWrapped) return true;
    for (const key of Object.keys(suite)) {
      const fn = suite[key];
      if (typeof fn !== 'function') continue;
      const source = Function.prototype.toString.call(fn);
      if (!source.includes('.snapshot({') || !source.includes('content') || !source.includes('yield')) continue;
      const wrapped = function(...args) {
        state.service = args[0];
        return fn.apply(this, args);
      };
      wrapped.__magpieWrapped = true;
      suite[key] = wrapped;
      state.snapshotKey = key;
      return true;
    }
    return false;
  };
  const timer = setInterval(() => { if (state.hook()) clearInterval(timer); }, 100);
})()`;

export function launchFetch(
  id: string,
  url: string,
  body: unknown[],
  binding?: string,
  proofIndex = 4,
): string {
  return `(async () => {
    const state = window.__magpieStudio;
    const id = ${JSON.stringify(id)};
    const req = {controller: new AbortController(), status: 0, headers: [], chunks: [], done: false, error: ''};
    state.requests.set(id, req);
    const body = ${JSON.stringify(body)};
    const binding = ${JSON.stringify(binding)};
    (async () => {
      try {
        if (binding !== undefined) {
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding)))].map(v => v.toString(16).padStart(2, '0')).join('');
          if (!state.service || !state.snapshotKey) throw new Error('AI Studio WAA service is not ready');
          const proof = await window.default_MakerSuite[state.snapshotKey](state.service, digest);
          if (typeof proof !== 'string' || !proof.startsWith('!')) throw new Error('AI Studio returned an invalid WAA proof');
          body[${proofIndex}] = proof;
        }
        if (req.controller.signal.aborted) return;
        const headers = {...state.headers, 'content-type': 'application/json+protobuf'};
        // Sign afresh, rather than replaying an expired timestamp from bootstrap.
        const cookies = Object.fromEntries(document.cookie.split(';').map(s => { const p = s.trim().indexOf('='); return [s.trim().slice(0,p), s.trim().slice(p+1)]; }));
        const timestamp = Math.floor(Date.now()/1000);
        const signatures = [];
        for (const [name, label] of [['SAPISID','SAPISIDHASH'],['__Secure-1PAPISID','SAPISID1PHASH'],['__Secure-3PAPISID','SAPISID3PHASH']]) {
          const value = cookies[name];
          if (!value) continue;
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(timestamp+' '+value+' https://aistudio.google.com')))].map(v => v.toString(16).padStart(2,'0')).join('');
          signatures.push(label+' '+timestamp+'_'+digest);
        }
        if (!signatures.length) throw new Error('Google session cookies are unavailable; sign in again');
        headers.authorization = signatures.join(' ');
        const response = await state.fetch(${JSON.stringify(url)}, {method:'POST', headers, credentials:'include', body:JSON.stringify(body), signal:req.controller.signal});
        req.status = response.status;
        req.headers = [...response.headers];
        if (!response.body) return;
        const reader = response.body.getReader();
        try {
          while (true) {
            while (req.chunks.length >= 8 && !req.controller.signal.aborted) await new Promise(r => setTimeout(r, 10));
            req.controller.signal.throwIfAborted();
            const {value, done} = await reader.read();
            if (done) break;
            let binary = '';
            for (let n=0; n<value.length; n+=32768) binary += String.fromCharCode(...value.subarray(n,n+32768));
            req.chunks.push(btoa(binary));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) { req.error = String(error); }
      finally { req.done = true; }
    })();
    return true;
  })()`;
}

export function readFetch(id: string): string {
  return `(() => {
    const requests = window.__magpieStudio.requests;
    const req = requests.get(${JSON.stringify(id)});
    if (!req) throw new Error('Unknown page request');
    return {status:req.status, headers:req.headers, chunks:req.chunks.splice(0), done:req.done, error:req.error};
  })()`;
}

export function cancelFetch(id: string): string {
  return `(() => {
    const requests = window.__magpieStudio?.requests;
    requests?.get(${JSON.stringify(id)})?.controller.abort();
    requests?.delete(${JSON.stringify(id)});
  })()`;
}

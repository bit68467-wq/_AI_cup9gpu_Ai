// Minimal, mobile-first single-file app using the provided Websim persistence layer (window.websim).
// Features: Registration, Login, Dashboard (Home), basic deposit/withdraw transactions, GPU card, OTP generator, bottom nav.
// Session stored in localStorage under 'cup9gpu_session'.
// The app uses only vanilla JS for portability.

(async function(){
  // small helpers
  const qs = s => document.querySelector(s);
  const qsa = s => Array.from(document.querySelectorAll(s));
  const app = qs('#app');

  // Ensure websim exists (environment provides it). If not, create a mock for local demo.
  // Also provide an environment-aware sync layer that pushes/pulls persisted collections between
  // localStorage and a real Websim backend when window.websim is available (e.g. on Render).
  if (!window.websim) {
    // Persistent mock backed by localStorage so sessions, users and transactions survive refresh.
    window.websim = {
      async getCurrentUser(){ return null; },
      async getCreatedBy(){ return { username: 'creator' }; },
      upload: async (f)=>{ throw new Error('upload not available'); },
      __db: JSON.parse(localStorage.getItem('cup9gpu_db_v1') || '{}'),
      __saveDb(){
        try { localStorage.setItem('cup9gpu_db_v1', JSON.stringify(this.__db)); } catch(e){ console.warn('persist failed', e); }
      },
      collection(name){
        this.__db[name] = this.__db[name] || { list:[], subs:[] };
        const col = this.__db[name];
        const persistAndNotify = ()=>{
          // persist top-level store
          this.__saveDb();
          col.subs.forEach(s=>s(col.list));
        };
        return {
          async create(data){
            const rec = Object.assign({
              id: (Date.now()+Math.random()).toString(36),
              type: name,
              username: (data && (data.username || data.email)) || 'local',
              created_at: new Date().toISOString()
            }, data);
            col.list.unshift(rec);
            persistAndNotify();
            return rec;
          },
          getList(){ return (col.list || []).slice(); },
          filter(obj){
            return {
              getList(){ return (col.list || []).filter(r=>Object.keys(obj).every(k=>r[k]===obj[k])); },
              subscribe(fn){ col.subs.push(fn); return ()=>{ col.subs = col.subs.filter(x=>x!==fn); } }
            };
          },
          subscribe(fn){ col.subs.push(fn); return ()=>{ col.subs = col.subs.filter(x=>x!==fn); } },
          async update(id,data){
            const i = (col.list || []).findIndex(x=>x.id===id);
            if (i>=0) col.list[i] = {...col.list[i],...data};
            persistAndNotify();
          },
          async delete(id){
            col.list = (col.list || []).filter(x=>x.id!==id);
            persistAndNotify();
          }
        };
      }
    };
  } else {
    // If running with a real websim provided by the host (e.g. deployed on Render),
    // attempt to synchronize on startup: pull server collections into localStorage
    // and publish local pending items to the server where appropriate.
    (async function syncWithBackend(){
      try {
        // collections we persist locally
        const mirrorKeys = {
          transaction_v1: 'cup9gpu_persistent_transactions_v1',
          device_v1: 'cup9gpu_persistent_devices_v1',
          session_v1: 'cup9gpu_persistent_sessions_v1',
          otp_v1: 'cup9gpu_persistent_otp_v1',
          user_v1: 'cup9gpu_persistent_users_v1'
        };

        // helper to mirror server -> localStorage
        for (const colName of Object.keys(mirrorKeys)) {
          try {
            const col = websim.collection(colName);
            if (col && typeof col.getList === 'function') {
              const serverList = col.getList() || [];
              // persist server snapshot locally (minimal fields)
              const copy = serverList.map(r=>{
                const out = {};
                for (const k in r) {
                  if (typeof r[k] !== 'function') out[k] = r[k];
                }
                return out;
              });
              localStorage.setItem(mirrorKeys[colName], JSON.stringify(copy));
              // subscribe to remote updates to keep local snapshot fresh
              if (typeof col.subscribe === 'function') {
                col.subscribe((list)=> {
                  try {
                    const snapshot = (list || []).map(r=>{
                      const o = {};
                      for (const k in r) if (typeof r[k] !== 'function') o[k] = r[k];
                      return o;
                    });
                    localStorage.setItem(mirrorKeys[colName], JSON.stringify(snapshot));
                    // also publish a simple event so in-page listeners update quickly
                    window.dispatchEvent(new CustomEvent('websim_mirror_updated', { detail: { collection: colName, list: snapshot } }));
                  } catch(e){}
                });
              }
            }
          } catch(e){}
        }

        // push any local-only persisted records to server if they're missing (best-effort dedupe by id)
        function pushLocalToServer(colName, storageKey) {
          try {
            const raw = JSON.parse(localStorage.getItem(storageKey) || '[]');
            if (!Array.isArray(raw) || raw.length === 0) return;
            const col = websim.collection(colName);
            if (!col || typeof col.getList !== 'function') return;
            const server = col.getList();
            const serverIds = new Set((server || []).map(s => s.id));
            raw.forEach(async r => {
              try {
                if (!r || !r.id) return;
                if (!serverIds.has(r.id)) {
                  // create on server (use create so server storage and subscriptions pick it up)
                  await col.create(r);
                }
              } catch(e){}
            });
          } catch(e){}
        }

        for (const [colName, storageKey] of Object.entries(mirrorKeys)) {
          pushLocalToServer(colName, storageKey);
        }

        // Watch localStorage changes (from other tabs) and forward to server if needed
        window.addEventListener('storage', (ev) => {
          try {
            if (!ev.key) return;
            for (const [colName, storageKey] of Object.entries(mirrorKeys)) {
              if (ev.key === storageKey) {
                // push updated local snapshot to server
                pushLocalToServer(colName, storageKey);
              }
            }
          } catch(e){}
        });

        // periodic sync (every 30s) to ensure eventual consistency
        setInterval(() => {
          try {
            for (const [colName, storageKey] of Object.entries(mirrorKeys)) pushLocalToServer(colName, storageKey);
          } catch(e){}
        }, 30000);
      } catch (e) {
        console.warn('websim sync init failed', e);
      }
    })();
  }

  // collections we'll use: robust helper to handle different websim shapes (global object vs. room wrapper)
  // collections we'll use: REST-backed wrapper for server persistence (falls back to websim if available)
  function getCollection(name){
    // If a websim collection is available, prefer it (keeps compatibility)
    if (websim && typeof websim.collection === 'function') return websim.collection(name);
    if (websim && websim.room && typeof websim.room.collection === 'function') return websim.room.collection(name);
    if (websim && websim.client && typeof websim.client.collection === 'function') return websim.client.collection(name);

    // REST API base path for collections
    const base = '/api/collections/' + encodeURIComponent(name);

    // simple in-memory cache used by getList to minimize requests
    let cache = null;
    let subs = [];

    // poll interval for subscribers (ms)
    const POLL_MS = 3000;
    let pollHandle = null;
    async function fetchList(){
      try {
        const res = await fetch(base);
        if (!res.ok) throw new Error('fetch failed');
        const json = await res.json();
        // server returns newest-first; normalize to an array
        cache = Array.isArray(json) ? json.slice() : [];
        // notify subscribers with the raw list
        subs.forEach(safe => { try { safe(cache); } catch(e){} });
        return cache;
      } catch (e) {
        // network failure: keep cache as-is (may be null)
        return cache || [];
      }
    }

    function ensurePolling(){
      if (pollHandle !== null) return;
      pollHandle = setInterval(() => { fetchList().catch(()=>{}); }, POLL_MS);
    }
    function stopPollingIfIdle(){
      if (subs.length === 0 && pollHandle !== null) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    }

    return {
      async create(data){
        try {
          const res = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || {})
          });
          if (!res.ok) throw new Error('create failed');
          const created = await res.json();
          // update cache (server returns newest-first; we maintain same shape)
          cache = cache || [];
          cache.unshift(created);
          subs.forEach(safe => { try { safe(cache); } catch(e){} });
          return created;
        } catch (e) {
          // fallback to local in-memory create to avoid breaking UX when offline
          const rec = Object.assign({
            id: (Date.now()+Math.random()).toString(36),
            type: name,
            username: (data && data.username) || 'local',
            created_at: new Date().toISOString()
          }, data);
          cache = cache || [];
          cache.unshift(rec);
          subs.forEach(safe => { try { safe(cache); } catch(e){} });
          return rec;
        }
      },
      // getList returns cached data if available, otherwise fetches from server
      getList(){
        if (cache) return cache.slice();
        // synchronous callers expect an array; start an async fetch and return empty array for now
        fetchList().catch(()=>{});
        return [];
      },
      // simple equality filter implemented client-side (pulls from cache/server)
      filter(obj){
        return {
          getList: () => {
            const list = (cache && cache.slice()) || [];
            if (!obj || Object.keys(obj).length === 0) return list;
            return list.filter(r => Object.keys(obj).every(k => r[k] === obj[k]));
          },
          subscribe: (fn) => {
            // immediately ensure we have a fresh list
            if (!cache) fetchList().catch(()=>{});
            // subscriber receives filtered snapshots
            const wrapper = (list) => {
              try {
                const filtered = (list || []).filter(r => Object.keys(obj).every(k => r[k] === obj[k]));
                fn(filtered);
              } catch(e){}
            };
            subs.push(wrapper);
            ensurePolling();
            // return unsubscribe
            return () => {
              subs = subs.filter(s => s !== wrapper);
              stopPollingIfIdle();
            };
          }
        };
      },
      subscribe: (fn) => {
        // immediately fetch a list and invoke the subscriber once
        fetchList().then(list => { try { fn(list); } catch(e){} }).catch(()=>{});
        const wrapper = (list) => { try { fn(list); } catch(e){} };
        subs.push(wrapper);
        ensurePolling();
        return () => {
          subs = subs.filter(s => s !== wrapper);
          stopPollingIfIdle();
        };
      },
      async update(id, data){
        try {
          const res = await fetch(base + '/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || {})
          });
          if (!res.ok) throw new Error('update failed');
          const updated = await res.json();
          // update cache entry if present
          if (cache) {
            const idx = cache.findIndex(x => x.id === updated.id);
            if (idx >= 0) cache[idx] = updated;
            else cache.unshift(updated);
            subs.forEach(safe => { try { safe(cache); } catch(e){} });
          }
          return updated;
        } catch (e) {
          // best-effort local update when offline
          if (cache) {
            const idx = cache.findIndex(x => x.id === id);
            if (idx >= 0) cache[idx] = {...cache[idx], ...data, updated_at: new Date().toISOString()};
            subs.forEach(safe => { try { safe(cache); } catch(e){} });
            return cache[idx];
          }
          throw e;
        }
      },
      async delete(id){
        try {
          const res = await fetch(base + '/' + encodeURIComponent(id), { method: 'DELETE' });
          if (!res.ok) throw new Error('delete failed');
          // remove from cache if present
          if (cache) {
            cache = cache.filter(x => x.id !== id);
            subs.forEach(safe => { try { safe(cache); } catch(e){} });
          }
          return { ok: true };
        } catch (e) {
          // best-effort local delete
          if (cache) {
            cache = cache.filter(x => x.id !== id);
            subs.forEach(safe => { try { safe(cache); } catch(e){} });
            return { ok: true };
          }
          throw e;
        }
      }
    };
  }

  const usersCol = getCollection('user_v1'); // versioned in case of schema change
  const txCol = getCollection('transaction_v1');
  const deviceCol = getCollection('device_v1');
  const otpCol = getCollection('otp_v1');
  // server-like persistent sessions stored in a collection so sessions survive across browsers/devices using the same backend
  const sessionsCol = getCollection('session_v1');

  // expose core collections to global scope so hardware.js and other modules can access them reliably
  window.usersCol = usersCol;
  window.txCol = txCol;
  window.deviceCol = deviceCol;
  window.otpCol = otpCol;
  window.sessionsCol = sessionsCol;

  // detect project creator username for admin access (best-effort)
  let creatorUsername = null;
  (async ()=>{
    try {
      if (window.websim && typeof window.websim.getCreatedBy === 'function') {
        const creator = await window.websim.getCreatedBy();
        creatorUsername = (creator && creator.username) || creatorUsername;
      }
    } catch(e){ /* ignore */ }
    // fallback: if meta contains creator key, use that
    try {
      const meta = getCollection('meta_v1');
      const about = meta.getList().find(m=>m.key==='created_by');
      if (about && about.value && !creatorUsername) creatorUsername = about.value;
    } catch(e){}
    // last fallback: use 'creator'
    if (!creatorUsername) creatorUsername = 'creator';
  })();

  // Ensure user records are always persisted to localStorage as a durable backup
  // This mirrors creates/updates/deletes to localStorage 'cup9gpu_persistent_users_v1'
  (function ensureUserPersistence() {
    const STORAGE_KEY = 'cup9gpu_persistent_users_v1';

    // prefer authoritative server-side users list on init; if server list empty, fall back to local persisted copy
    try {
      const serverList = usersCol.getList() || [];
      const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if ((!serverList || serverList.length === 0) && persisted && persisted.length) {
        // bulk-add persisted users if server appears empty (best-effort)
        persisted.slice().reverse().forEach(u => {
          const dup = usersCol.getList().find(x => (x.email && u.email && x.email === u.email) || (x.user_uid && u.user_uid && x.user_uid === u.user_uid));
          if (!dup) {
            try { usersCol.create({...u}); } catch(e){ /* best-effort */ }
          }
        });
      } else if (serverList && serverList.length) {
        // if server has data, overwrite local persisted copy to keep localStorage in sync
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serverList.map(u => ({
          id: u.id, username: u.username, email: u.email, password: u.password, user_uid: u.user_uid, created_at: u.created_at, updated_at: u.updated_at
        })))); } catch(e){}
      }
    } catch(e){ console.warn('load persisted users failed', e); }

    // wrapper helpers to persist current user list after mutations
    function persistNow() {
      try {
        const list = usersCol.getList() || [];
        // store minimal safe copy (avoid storing functions or circular)
        const copy = list.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          password: u.password,
          user_uid: u.user_uid,
          created_at: u.created_at,
          updated_at: u.updated_at
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
      } catch(e){ console.warn('persist users failed', e); }
    }

    // Attempt to hook into collection methods where available to persist after changes
    try {
      const rawCreate = usersCol.create && usersCol.create.bind(usersCol);
      if (rawCreate) {
        usersCol.create = async function(data){
          const res = await rawCreate(data);
          try { persistNow(); } catch(e){}
          return res;
        };
      }
      const rawUpdate = usersCol.update && usersCol.update.bind(usersCol);
      if (rawUpdate) {
        usersCol.update = async function(id, data){
          const res = await rawUpdate(id, data);
          try { persistNow(); } catch(e){}
          return res;
        };
      }
      const rawDelete = usersCol.delete && usersCol.delete.bind(usersCol);
      if (rawDelete) {
        usersCol.delete = async function(id){
          const res = await rawDelete(id);
          try { persistNow(); } catch(e){}
          return res;
        };
      }

      // also persist once at init to capture current state
      persistNow();
    } catch(e){
      console.warn('user persistence wrapper failed', e);
    }

    // subscribe to server-side users collection changes (if supported) so localStorage is always synchronized
    try {
      if (typeof usersCol.subscribe === 'function') {
        const unsub = usersCol.subscribe(() => {
          try { persistNow(); } catch(e){}
        });
        // ensure we remove subscription on full app re-render if necessary
        window.__cup9gpu_unsubs = window.__cup9gpu_unsubs || [];
        window.__cup9gpu_unsubs.push(unsub);
      }
    } catch (e) {
      console.warn('usersCol.subscribe failed', e);
    }

    // finally, expose a helper to force-save users (useful for debugging)
    window.__cup9gpu_forcePersistUsers = persistNow;
  })();

  // Persist transactions, devices, sessions and OTPs to localStorage to ensure full durability across refreshes/browsers.
  (function ensureDataPersistence() {
    const keys = {
      tx: 'cup9gpu_persistent_transactions_v1',
      devices: 'cup9gpu_persistent_devices_v1',
      sessions: 'cup9gpu_persistent_sessions_v1',
      otp: 'cup9gpu_persistent_otp_v1'
    };

    // load persisted data into collections if empty
    try {
      const loadIfEmpty = (col, key) => {
        const persisted = JSON.parse(localStorage.getItem(key) || '[]');
        const existing = col.getList();
        if (persisted && persisted.length && (!existing || existing.length === 0)) {
          // add in reverse so original order approximates stored order
          persisted.slice().reverse().forEach(r => {
            const dup = col.getList().find(x => x.id === r.id);
            if (!dup) {
              try { col.create && col.create(r); } catch(e){ /* best-effort */ }
            }
          });
        }
      };

      loadIfEmpty(txCol, keys.tx);
      loadIfEmpty(deviceCol, keys.devices);
      loadIfEmpty(sessionsCol, keys.sessions);
      loadIfEmpty(otpCol, keys.otp);
    } catch (e) {
      console.warn('load persisted collections failed', e);
    }

    // wrapper generator to persist after mutations
    const wrapCol = (col, storageKey) => {
      if (!col) return;

      // compute and publish OTP counts map (user_id => unusedCount)
      function publishOtpCounts() {
        try {
          if (!otpCol || typeof otpCol.getList !== 'function') return;
          const list = otpCol.getList() || [];
          const map = {};
          list.forEach(o => {
            if (!o || !o.user_id) return;
            if (o.used) return;
            map[o.user_id] = (map[o.user_id] || 0) + 1;
          });
          // store global counts map in localStorage for cross-tab visibility
          try { localStorage.setItem('cup9gpu_otp_counts', JSON.stringify(map)); } catch(e){}
          // dispatch a custom event with counts for in-page listeners
          try { window.dispatchEvent(new CustomEvent('otp_counts_updated', { detail: map })); } catch(e){}
        } catch (e) { console.warn('publishOtpCounts failed', e); }
      }

      const persistNow = () => {
        try {
          const list = col.getList() || [];
          // Save a minimal safe copy
          const copy = list.map(r => {
            const out = {};
            for (const k in r) {
              if (typeof r[k] !== 'function') out[k] = r[k];
            }
            return out;
          });
          localStorage.setItem(storageKey, JSON.stringify(copy));
        } catch (e) { console.warn('persist failed', e); }
        // whenever any wrapped collection persists, refresh OTP counts (safe no-op for non-otp cols)
        try { publishOtpCounts(); } catch(e){}
      };

      try {
        const rawCreate = col.create && col.create.bind(col);
        if (rawCreate) {
          col.create = async function(data){
            const res = await rawCreate(data);
            try { persistNow(); } catch(e){}
            return res;
          };
        }
        const rawUpdate = col.update && col.update.bind(col);
        if (rawUpdate) {
          col.update = async function(id, data){
            const res = await rawUpdate(id, data);
            try { persistNow(); } catch(e){}
            return res;
          };
        }
        const rawDelete = col.delete && col.delete.bind(col);
        if (rawDelete) {
          col.delete = async function(id){
            const res = await rawDelete(id);
            try { persistNow(); } catch(e){}
            return res;
          };
        }
        // initial persist of current state and publish counts
        persistNow();
      } catch(e){
        console.warn('wrapCol failed', e);
      }
    };

    wrapCol(txCol, keys.tx);
    wrapCol(deviceCol, keys.devices);
    wrapCol(sessionsCol, keys.sessions);
    wrapCol(otpCol, keys.otp);

    // expose helper for debugging
    window.__cup9gpu_forcePersist = function(){ 
      try {
        localStorage.setItem(keys.tx, JSON.stringify(txCol.getList()||[]));
        localStorage.setItem(keys.devices, JSON.stringify(deviceCol.getList()||[]));
        localStorage.setItem(keys.sessions, JSON.stringify(sessionsCol.getList()||[]));
        localStorage.setItem(keys.otp, JSON.stringify(otpCol.getList()||[]));
      } catch(e){ console.warn(e); }
    };
  })();

  // Session helpers - purely localStorage-based session handling (no WebSIM credentials/use).
  const SESSION_KEY = 'cup9gpu_session';

  // saveSession stores a normalized session object locally only.
  async function saveSession(user){
    try {
      // Normalize session input and ensure we always have a persistent uid.
      // If caller provided only an id or lacked uid, attempt to resolve the authoritative user record.
      let resolvedUid = user?.uid || user?.user_uid || null;
      let resolvedUsername = user?.username || user?.name || user?.email || 'user';
      let resolvedEmail = user?.email || null;
      let resolvedIsAdmin = !!user?.is_admin;
      let resolvedId = user?.id || null;

      // If we have an id but no uid, try to fetch the user record from usersCol to obtain user_uid.
      try {
        if ((!resolvedUid || resolvedUid === null) && resolvedId && usersCol && typeof usersCol.getList === 'function') {
          const rec = usersCol.getList().find(u => u.id === resolvedId);
          if (rec) {
            resolvedUid = resolvedUid || rec.user_uid || rec.uid || null;
            resolvedUsername = resolvedUsername || rec.username || rec.name || rec.email || resolvedUsername;
            resolvedEmail = resolvedEmail || rec.email || null;
            resolvedIsAdmin = resolvedIsAdmin || !!rec.is_admin;
          }
        }
      } catch (e) {
        // best-effort: ignore lookup failure
      }

      // If still missing a uid, generate one (and attempt to persist it to the user record)
      if (!resolvedUid) {
        try { resolvedUid = crypto.randomUUID(); } catch(e){ resolvedUid = 'uid_' + (Date.now().toString(36) + Math.random().toString(36).slice(2)); }
        try {
          if (resolvedId && usersCol && typeof usersCol.update === 'function') {
            // persist user_uid back to user record for cross-device session recovery
            usersCol.update(resolvedId, { user_uid: resolvedUid }).catch(()=>{});
          }
        } catch(e){}
      }

      const normalized = {
        id: resolvedId,
        uid: resolvedUid,
        username: resolvedUsername,
        email: resolvedEmail,
        is_admin: resolvedIsAdmin,
        updated_at: new Date().toISOString()
      };

      // create or update a server-side session record so the session exists persistently across browsers/devices
      try {
        // try to find an existing session for this user uid; tolerate different field names (uid / user_uid)
        const existing = sessionsCol.getList().find(s => (s.uid && s.uid === normalized.uid) || (s.user_uid && s.user_uid === normalized.uid));
        if (existing && existing.id) {
          await sessionsCol.update && sessionsCol.update(existing.id, {
            user_id: normalized.id,
            uid: normalized.uid,
            username: normalized.username,
            email: normalized.email,
            updated_at: normalized.updated_at
          });
          normalized.session_id = existing.id;
        } else {
          const rec = await sessionsCol.create({
            user_id: normalized.id,
            uid: normalized.uid,
            username: normalized.username,
            email: normalized.email,
            created_at: new Date().toISOString(),
            updated_at: normalized.updated_at
          });
          normalized.session_id = rec.id;
        }
      } catch (e) {
        // if sessionsCol isn't persistent in this environment, continue with local-only save
        console.warn('server-side session save failed', e);
      }

      // persist locally and also expose globally for immediate cross-module access
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(normalized)); } catch(e){/*best-effort*/}
      window.__cup9_session = normalized;
      return normalized;
    } catch(e){
      console.warn('saveSession failed', e);
      return null;
    }
  }

  // clearSession removes only local session cache.
  async function clearSession(){
    try {
      // attempt to remove server-side session record if present
      let local = null;
      try { local = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch(e){}
      if (local && local.session_id) {
        try {
          await sessionsCol.delete && sessionsCol.delete(local.session_id);
        } catch (e) {
          console.warn('server-side session delete failed', e);
        }
      }
      try { localStorage.removeItem(SESSION_KEY); } catch(e){}
      // clear global in-memory session as well
      try { window.__cup9_session = null; } catch(e){}
    } catch(e){ console.warn('clearSession failed', e); }
  }

  // synchronous session accessor: read session from localStorage only.
  function getSession(){
    try {
      // prefer in-memory global session for immediate consistency across modules
      if (window.__cup9_session) return window.__cup9_session;

      const local = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (local) {
        // mirror into global in-memory session for fast access
        window.__cup9_session = local;
        return local;
      }

      // fallback: try to load a server-side session (useful if user visited from another browser but session is stored server-side)
      try {
        const recs = sessionsCol.getList();
        if (recs && recs.length) {
          // pick the most recent session for this environment (best-effort)
          const recent = recs[0];
          const recovered = {
            id: recent.user_id || null,
            uid: recent.uid || null,
            username: recent.username || null,
            email: recent.email || null,
            session_id: recent.id,
            updated_at: recent.updated_at || recent.created_at || new Date().toISOString()
          };
          // persist locally for quicker access
          try { localStorage.setItem(SESSION_KEY, JSON.stringify(recovered)); } catch(e){}
          window.__cup9_session = recovered;
          return recovered;
        }
      } catch (e) {
        // ignore server-side fallback failure
      }

      return null;
    } catch(e){
      return null;
    }
  }

  // Navigation state
  let route = 'home';
  // transaction history page pointer (used by admin/user navigation to the transactions view)
  let txPage = 1;
  function navigate(to){
    // Prevent admin sessions from navigating into the regular platform.
    try {
      const session = getSession();
      if (session && session.is_admin) {
        // allow only admin panel and logout/login
        if (to !== 'admin' && to !== 'login') {
          alert('Accesso admin limitato: puoi usare solo il pannello admin.');
          route = 'admin';
          render();
          return;
        }
      }
    } catch(e){
      // fallback to normal navigation on error
    }
    route = to;
    render();
  }

  // Simple router: render pages
  async function render(){
    const session = getSession();
    // clear any leftover collection subscriptions from previous renders to avoid duplicate updates
    try {
      if (!window.__cup9gpu_unsubs) window.__cup9gpu_unsubs = [];
      while (window.__cup9gpu_unsubs.length) {
        const u = window.__cup9gpu_unsubs.shift();
        try { if (typeof u === 'function') u(); } catch(e){}
      }
    } catch(e){ /* ignore */ }
    app.innerHTML = '';
    // auto-accrue earnings once per day when a session exists (runs on each render)
    if (session) {
      try { await accrueEarnings(session); } catch(e){ console.warn('accrueEarnings failed', e); }
    }
    if (!session && route !== 'login' && route !== 'register') {
      route = 'login';
    }

    // Header with notification bell (shows only valid/unused OTPs for current user)
    if (route !== 'login' && route !== 'register') {
      const header = document.createElement('div');
      header.className = 'header';

      const brand = document.createElement('div');
      brand.className = 'brand';
      const logo = document.createElement('div'); logo.className='logo'; logo.textContent='C9';
      const titWrap = document.createElement('div');
      titWrap.appendChild(el('div.h-title','CUP9GPU'));
      titWrap.appendChild(el('div.h-sub','Hosting · Leas. GPU'));
      brand.appendChild(logo);
      brand.appendChild(titWrap);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '10px';

      // notification bell
      const bellWrap = document.createElement('div'); bellWrap.style.display='flex'; bellWrap.style.alignItems='center';
      const bell = document.createElement('button'); bell.className = 'notif-btn notif-badge';
      bell.title = 'Notifiche';
      bell.innerHTML = '🔔';
      // count unused OTPs and keep it updated via subscription to the otp collection
      const updateBellCount = (fromMap)=>{
        try {
          // prefer event-supplied counts (fromMap), fallback to otpCol direct list, then localStorage
          let count = 0;
          if (fromMap && typeof fromMap === 'object') {
            count = Number(fromMap[session?.id] || 0);
          } else {
            const list = (otpCol && typeof otpCol.getList === 'function') ? otpCol.getList() : [];
            count = (list || []).filter(o => o.user_id === session?.id && !o.used).length;
            if (typeof count !== 'number' || isNaN(count)) {
              try {
                const stored = JSON.parse(localStorage.getItem('cup9gpu_otp_counts') || '{}');
                count = Number((stored && stored[session?.id]) || 0);
              } catch(e){}
            }
          }
          // always show a numeric badge including zero
          bell.setAttribute('data-count', String(count));
          bell.style.color = count>0 ? 'var(--accent)' : 'var(--text-secondary)';
        } catch(e){}
      };
      updateBellCount();

      // subscribe to otp collection changes so the badge reflects the real number of notifications
      try {
        if (otpCol && typeof otpCol.subscribe === 'function') {
          const unsub = otpCol.subscribe(() => {
            // subscription may fire for all OTPs; recalc relevant count for this session
            updateBellCount();
          });
          // track unsubscribe functions globally and clear them at next render
          window.__cup9gpu_unsubs = window.__cup9gpu_unsubs || [];
          window.__cup9gpu_unsubs.push(unsub);
        }
      } catch(e){ console.warn('otp subscribe failed', e); }

      // listen for global published counts (from same tab) and storage events (from other tabs) for real-time updates
      try {
        const handler = (ev) => {
          if (ev && ev.detail) updateBellCount(ev.detail);
          else {
            // storage event: re-read counts map
            try {
              const stored = JSON.parse(localStorage.getItem('cup9gpu_otp_counts') || '{}');
              updateBellCount(stored);
            } catch(e){}
          }
        };
        window.addEventListener('otp_counts_updated', handler);
        window.addEventListener('storage', handler);
        // ensure we unsubscribe on re-render
        window.__cup9gpu_unsubs = window.__cup9gpu_unsubs || [];
        window.__cup9gpu_unsubs.push(()=>{ window.removeEventListener('otp_counts_updated', handler); window.removeEventListener('storage', handler); });
      } catch(e){}

      bell.onclick = ()=> {
        // open modal listing only valid (unused) OTPs for this user
        const overlay = document.createElement('div'); overlay.className='notif-overlay';
        const modal = document.createElement('div'); modal.className='notif-modal';
        const hdr = document.createElement('div'); hdr.className='nm-header';
        hdr.appendChild(el('div.h-title','Notifiche (OTP)'));
        const close = document.createElement('button'); close.className='btn'; close.textContent='Chiudi';
        close.onclick = ()=> { document.body.removeChild(overlay); updateBellCount(); };
        hdr.appendChild(close);
        modal.appendChild(hdr);

        const listWrap = document.createElement('div'); listWrap.className='notif-list';
        // show only unused OTPs that are still relevant: linked to a transaction that is pending or has status 'otp_sent'
        const otps = (otpCol.getList() || [])
          .filter(o => o.user_id === session?.id && !o.used)
          .filter(o => {
            // find related transaction and ensure it's still awaiting OTP confirmation
            try {
              const tx = txCol.getList().find(t => t.id === o.tx_id);
              if (!tx) return false;
              const st = (tx.status || 'confirmed').toLowerCase();
              return st === 'otp_sent' || st === 'pending';
            } catch (e) {
              return false;
            }
          })
          .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        if (!otps.length) {
          listWrap.appendChild(el('div.small','Nessun OTP valido'));
        } else {
          otps.forEach(o=>{
            const item = document.createElement('div'); item.className='notif-item';
            const left = document.createElement('div');
            left.appendChild(el('div.notif-code', o.code || '—'));
            left.appendChild(el('div.notif-meta', new Date(o.created_at).toLocaleString()));
            const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px'; actions.style.alignItems='center';
            const copy = document.createElement('button'); copy.className='btn'; copy.textContent='Copia';
            copy.onclick = ()=> {
              try { navigator.clipboard.writeText(String(o.code)); alert('OTP copiato'); } catch(e){ alert('Copia non supportata'); }
            };
            const info = document.createElement('div'); info.className='small'; info.style.color='var(--muted)'; info.textContent = o.tx_id ? 'Collegato a transazione' : '';
            actions.appendChild(copy);
            item.appendChild(left);
            item.appendChild(actions);
            item.appendChild(info);
            listWrap.appendChild(item);
          });
        }

        modal.appendChild(listWrap);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
      };

      // welcome / avatar
      const welcome = el('div', el('div.small','Benvenuto, ' + (session?.username || 'Guest')));
      right.appendChild(bell);
      right.appendChild(welcome);

      header.appendChild(brand);
      header.appendChild(right);
      app.appendChild(header);
    }

    // Pages (all main pages use the hardware-page layout wrapper for consistent appearance)
    // Render the selected page, wrapping every page in the hardware-page layout for consistent fullscreen appearance
    let pageEl = null;
    if (route === 'login') pageEl = loginPage();
    else if (route === 'register') pageEl = registerPage();
    else if (route === 'admin') pageEl = adminPage();
    else if (route === 'home') pageEl = await homePage();
    else if (route === 'hardware') pageEl = hardwarePage();
    else if (route === 'devices') pageEl = await myDevicesPage();
    else if (route === 'licenses') pageEl = licensesPage();
    else if (route === 'profile') pageEl = profilePage();
    else if (route === 'transactions') pageEl = await transactionsPage();
    else { navigate('home'); return; }

    // wrap with hardware-page container for unified layout across all pages
    const wrapper = document.createElement('div');
    wrapper.className = 'hardware-page';
    wrapper.appendChild(pageEl);
    app.appendChild(wrapper);

    // always include the bottom nav as part of the page wrapper so it is the final lower section of each page
    wrapper.appendChild(bottomNav(route, true));
  }

  // small DOM helper
  function el(tag, content){
    const d = document.createElement('div');
    d.className = tag;
    if (typeof content === 'string') d.textContent = content;
    else if (Array.isArray(content)){
      content.forEach(c=>{
        if (typeof c === 'string') d.appendChild(document.createTextNode(c));
        else d.appendChild(c);
      });
    } else if (content instanceof HTMLElement) d.appendChild(content);
    return d;
  }

  // Forms
  function registerPage(){
    const wrap = document.createElement('div');
    wrap.className = 'card';
    const title = document.createElement('h3'); title.textContent = 'Crea account';
    wrap.appendChild(title);

    const form = document.createElement('div'); form.className='form';
    const lblUsername = labeled('username','Username');
    const inpUsername = input('text','username');
    lblUsername.appendChild(inpUsername);

    const lblEmail = labeled('email','Email');
    const inpEmail = input('email','email');
    lblEmail.appendChild(inpEmail);

    const lblPass = labeled('password','Password');
    const inpPass = input('password','password');
    lblPass.appendChild(inpPass);

    const lblPass2 = labeled('confirm','Conferma password');
    const inpPass2 = input('password','confirm');
    lblPass2.appendChild(inpPass2);

    const chkRow = document.createElement('label'); chkRow.className='checkbox-row';
    const chk = document.createElement('input'); chk.type='checkbox'; chk.id='tos';
    chkRow.appendChild(chk);
    const tos = document.createElement('span'); tos.textContent='Accetto termini di servizio'; tos.style.fontSize='13px'; chkRow.appendChild(tos);

    const btn = document.createElement('button'); btn.className='primary'; btn.textContent='Registrati';
    btn.onclick = async ()=>{
      if (!inpUsername.value.trim()||!inpEmail.value.trim()||!inpPass.value) return alert('Compila tutti i campi');
      if (inpPass.value !== inpPass2.value) return alert('La password non corrisponde');
      if (!chk.checked) return alert('Accetta i termini');

      // ensure unique email
      const existing = usersCol.getList().find(u=>u.email===inpEmail.value.trim().toLowerCase());
      if (existing) return alert('Email già usata');

      // create a unique 6-digit numeric user UID (uses generateOTP helper when available)
      const genUID = () => {
        try {
          if (window.__cup9_utils && typeof window.__cup9_utils.generateOTP === 'function') {
            return window.__cup9_utils.generateOTP();
          }
          return Math.floor(100000 + Math.random()*900000).toString();
        } catch(e) {
          return Math.floor(100000 + Math.random()*900000).toString();
        }
      };
      const user_uid = genUID();

      // create user record including user_uid
      const user = await usersCol.create({
        username: inpUsername.value.trim(),
        email: inpEmail.value.trim().toLowerCase(),
        password: inpPass.value, // plain for demo; in prod hash it
        user_uid
      });

      // inform the user of their generated ID UTENTE and attempt to copy it to clipboard
      try {
        const msg = `Registrazione completata.\nID UTENTE: ${user.user_uid}\n(È stato copiato negli appunti.)`;
        try { await navigator.clipboard.writeText(String(user.user_uid)); } catch(e){ /* clipboard may not be available */ }
        alert(msg);
      } catch (e) {
        // fallback alert if anything goes wrong
        try { alert('Registrazione completata. ID UTENTE: ' + (user.user_uid || 'n/d')); } catch(e){}
      }

      // persist session with the unique user_uid
      saveSession({ id: user.id, uid: user.user_uid, username: user.username, email: user.email });
      navigate('home');
    };

    const goLogin = document.createElement('div'); goLogin.className='help';
    goLogin.textContent = 'Hai già un account? '; const a = document.createElement('a'); a.style.color='var(--accent)'; a.textContent='Accedi'; a.href='#'; a.onclick=()=>navigate('login');
    goLogin.appendChild(a);

    form.appendChild(lblUsername);
    form.appendChild(lblEmail);
    form.appendChild(lblPass);
    form.appendChild(lblPass2);
    form.appendChild(chkRow);
    form.appendChild(btn);
    form.appendChild(goLogin);
    wrap.appendChild(form);
    return wrap;
  }

  function loginPage(){
    const wrap = document.createElement('div');
    wrap.className='card';
    const title = document.createElement('h3'); title.textContent = 'Accedi';
    wrap.appendChild(title);

    const form = document.createElement('div'); form.className='form';
    const lblEmail = labeled('email','Email');
    const inpEmail = input('email','email');
    lblEmail.appendChild(inpEmail);

    const lblPass = labeled('password','Password');
    const inpPass = input('password','password');
    lblPass.appendChild(inpPass);

    const btn = document.createElement('button'); btn.className='primary'; btn.textContent='Accedi';
    btn.onclick = async ()=>{
      const email = inpEmail.value.trim().toLowerCase();
      const pass = inpPass.value;

      // Admin backdoor credentials (local admin access)
      if (email === 'admin.cup.9@yahoo.com' && pass === 'admincup9') {
        // create a minimal admin session (no remote user required) and mark as admin explicitly
        await saveSession({ id: 'admin', uid: 'admin_uid', username: 'admin', email, is_admin: true });
        navigate('admin');
        return;
      }

      const user = usersCol.getList().find(u=>u.email===email && u.password===pass);
      if (!user) return alert('Credenziali non valide');

      // prefer stored user_uid, fallback to generating one if older record lacks it
      const uid = user.user_uid || (function(){
        try {
          if (window.__cup9_utils && typeof window.__cup9_utils.generateOTP === 'function') {
            return window.__cup9_utils.generateOTP();
          }
          return String(Math.floor(100000 + Math.random()*900000));
        } catch(e) {
          return String(Math.floor(100000 + Math.random()*900000));
        }
      })();

      // if user record didn't have user_uid, update it in the collection
      if (!user.user_uid) {
        usersCol.update && usersCol.update(user.id, { user_uid: uid }).catch(()=>{});
      }

      // persist session with unique uid
      await saveSession({ id: user.id, uid, username: user.username, email: user.email });
      navigate('home');
    };

    const goReg = document.createElement('div'); goReg.className='help';
    goReg.textContent = 'Nuovo qui? '; const a = document.createElement('a'); a.style.color='var(--accent)'; a.textContent='Registrati'; a.href='#'; a.onclick=()=>navigate('register');
    goReg.appendChild(a);

    form.appendChild(lblEmail);
    form.appendChild(lblPass);
    form.appendChild(btn);
    form.appendChild(goReg);
    wrap.appendChild(form);
    return wrap;
  }

  // Components for dashboard
  async function homePage(){
    const session = getSession();
    const container = document.createElement('div');

    // Balance card (placed first for clarity)
    const bal = document.createElement('div'); bal.className='card';
    bal.appendChild(el('h3','Saldo'));
    const values = document.createElement('div'); values.className='balance-values';

    // compute balances from transactions
    // All transactions for this user (includes pending entries)
    const allTx = txCol.getList().filter(t => t.user_id === session.id);

    // Only non-pending deposits count as spendable
    const totalDeposits = allTx.filter(t => t.type === 'deposit' && !['pending','otp_sent'].includes(t.status)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    // purchases consume the deposit/spendable balance
    const totalPurchases = allTx.filter(t => t.type === 'purchase').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    // earnings are separate and are the only source that can be withdrawn (only confirmed earnings count)
    const earnings = allTx.filter(t => t.type === 'earning' && !['pending','otp_sent'].includes(t.status)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const totalWithdrawals = allTx.filter(t => t.type === 'withdraw' && t.status === 'confirmed').reduce((s, t) => s + (Number(t.amount) || 0), 0);

    // spendable: confirmed deposits minus purchases (never negative)
    const spendable = Math.max(0, totalDeposits - totalPurchases);
    // withdrawable: confirmed earnings minus confirmed withdrawals (never negative)
    const withdrawable = Math.max(0, earnings - totalWithdrawals);

    // helper to confirm a pending transaction via OTP
    async function confirmTransactionWithOTP(txId){
      const tx = txCol.getList().find(x => x.id === txId && x.user_id === session.id);
      if (!tx) return alert('Transazione non trovata');
      const code = prompt('Inserisci OTP per confermare la transazione:','');
      if (!code) return;
      // find OTP entry
      const otpRec = otpCol.getList().find(o => o.tx_id === txId && String(o.code) === String(code) && !o.used);
      if (!otpRec) return alert('OTP non valido o già usato');
      try {
        // mark OTP as used
        await otpCol.update && otpCol.update(otpRec.id, { used: true, used_at: new Date().toISOString() });
      } catch(e){ /* best-effort */ }

      // build update payload: confirm and if deposit mark credited with timestamp
      const updatePayload = {
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      };
      if (tx.type === 'deposit') {
        updatePayload.credited = true;
        updatePayload.credited_at = new Date().toISOString();
        // update note to reflect admin-confirmed credit if desired
        updatePayload.note = (tx.note || '') + ' (accreditato via OTP)';
      } else if (tx.type === 'withdraw') {
        updatePayload.note = (tx.note || '') + ' (prelievo confermato via OTP)';
      }

      // mark transaction as confirmed/accredited
      await txCol.update && txCol.update(txId, updatePayload);
      alert('Transazione confermata e accreditata se applicabile.');
      render();
    }

    values.appendChild(el('div',[el('div.big', formatMoney(spendable)), el('div.small','Saldo spendibile')]));
    values.appendChild(el('div',[el('div.big', formatMoney(withdrawable)), el('div.small','Saldo prelevabile')]));
    bal.appendChild(values);

    const statsRow = document.createElement('div'); statsRow.className='stats';
    statsRow.appendChild(el('div.stat',[el('div.small','Guadagni giornalieri'), el('div.val', formatMoney( computeDaily(session.id) ))]));
    statsRow.appendChild(el('div.stat',[el('div.small','Depositi totali'), el('div.val', formatMoney(totalDeposits))]));
    statsRow.appendChild(el('div.stat',[el('div.small','Transazioni'), el('div.val', String(allTx.length))]));
    bal.appendChild(statsRow);

    const actions = document.createElement('div'); actions.className='actions';
    const depBtn = document.createElement('button'); depBtn.className='btn'; depBtn.textContent='Deposita';
    depBtn.onclick = ()=>openDeposit();
    const withBtn = document.createElement('button'); withBtn.className='btn'; withBtn.textContent='Preleva';
    withBtn.onclick = ()=>openWithdraw();
    // removed client-side OTP generation: admin must generate and send OTP via admin panel
    actions.appendChild(depBtn); actions.appendChild(withBtn);
    bal.appendChild(actions);

    // GPU card (catalog shortcut)
    const gpuCard = document.createElement('div'); gpuCard.className='card gpu-card';
    gpuCard.appendChild(el('h3','GPU rapida'));
    gpuCard.appendChild(el('div.small','Attiva un dispositivo gratuito di prova o acquista piani in Hardware.'));
    const top = document.createElement('div'); top.className='gpu-top';
    const info = document.createElement('div'); info.className='gpu-info';
    const chip = document.createElement('div'); chip.className='gpu-chip'; chip.textContent='GPU';
    const txt = document.createElement('div'); txt.appendChild(el('div.h-title','CUP9GPU')); txt.appendChild(el('div.small','Dispositivo di prova'));
    info.appendChild(chip); info.appendChild(txt);
    const activate = document.createElement('button'); activate.className='btn'; activate.textContent='Attiva prova';
    activate.onclick = async ()=>{
      // create trial device
      const device = await deviceCol.create({
        owner_id: session.id,
        name: 'Dispositivo di prova',
        active: true,
        activated_at: new Date().toISOString(),
        trial: true,
        daily_yield: 10
      });
      // credit $10 to the deposit/spendable balance (type 'deposit' used for spendable funds)
      await txCol.create({
        user_id: session.id,
        type: 'deposit',
        amount: 10,
        created_at: new Date().toISOString(),
        note: 'Credito prova - spendibile (non prelevabile)'
      });
      alert('Dispositivo di prova attivato. $10 sono stati accreditati al tuo saldo spendibile (non prelevabile).');
      render();
    };
    top.appendChild(info); top.appendChild(activate);
    gpuCard.appendChild(top);

    // Transactions list (clearly separated)
    const txCard = document.createElement('div'); txCard.className='card';
    txCard.appendChild(el('h3','Transazioni recenti'));
    txCard.appendChild(el('div.section-sub','Storico degli ultimi movimenti del conto'));
    const list = document.createElement('div'); list.className='list recent-five';

    // show always the latest 5 transactions
    const recentTx = allTx.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)).slice(0,5);
    recentTx.forEach(t=>{
      const row = buildTxRow(t);
      list.appendChild(row);
    });

    if (recentTx.length === 0) list.appendChild(el('div.small','Nessuna transazione al momento'));
    txCard.appendChild(list);

    // footer: controls to page transaction history in-place (update txPage and refresh list without navigating)
    const footerNav = document.createElement('div');
    footerNav.style.display = 'flex';
    footerNav.style.justifyContent = 'space-between';
    footerNav.style.marginTop = '10px';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn';
    prevBtn.textContent = '◀ Pagina precedente';
    prevBtn.onclick = ()=> {
      if (txPage > 1) {
        txPage = Math.max(1, txPage - 1);
        refreshTxList();
      } else {
        alert('Sei alla prima pagina');
      }
    };

    const pageIndicator = document.createElement('div');
    pageIndicator.style.display = 'flex';
    pageIndicator.style.alignItems = 'center';
    pageIndicator.style.gap = '8px';
    pageIndicator.appendChild(el('div.small', `Pagina ${txPage}`));

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn';
    nextBtn.textContent = 'Pagina successiva ▶';
    nextBtn.onclick = ()=> {
      // check if there's another page available
      const allTxForUser = txCol.getList().filter(t => t.user_id === session.id).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
      const perPage = 10;
      if ((txPage * perPage) < allTxForUser.length) {
        txPage = txPage + 1;
        refreshTxList();
      } else {
        alert('Nessuna altra pagina');
      }
    };

    footerNav.appendChild(prevBtn);
    footerNav.appendChild(pageIndicator);
    footerNav.appendChild(nextBtn);
    txCard.appendChild(footerNav);

    // helper to refresh the transactions list in-place on Home
    function refreshTxList(){
      // update indicator
      pageIndicator.innerHTML = '';
      pageIndicator.appendChild(el('div.small', `Pagina ${txPage}`));

      // rebuild list content
      list.innerHTML = '';

      const perPage = 10;
      const allTxUser = txCol.getList().filter(t => t.user_id === session.id).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
      const start = (Math.max(1, Math.floor(txPage || 1)) - 1) * perPage;
      const pageItems = allTxUser.slice(start, start + perPage);

      if (pageItems.length === 0) {
        list.appendChild(el('div.small','Nessuna transazione in questa pagina'));
        return;
      }

      pageItems.forEach(t=>{
        const row = buildTxRow(t);
        list.appendChild(row);
      });
    }

    // initialize the list with current txPage contents (show first page by default)
    refreshTxList();

    // Append in a clear, consistent order (notifications panel removed; keep only header bell)
    // Place the compact trial GPU card first for higher visibility
    container.appendChild(gpuCard);
    container.appendChild(bal);
    container.appendChild(txCard);

    return container;
  }

  // removed function hardwarePage() {}
  // hardwarePage implementation moved to hardware.js for modularity.
  // app will call window.hardwarePage() when available; if not present, show a placeholder.
  function hardwarePage(){
    if (window && typeof window.hardwarePage === 'function') return window.hardwarePage();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Catalogo GPU'));
    wrap.appendChild(el('div.small','Catalogo non disponibile (modulo hardware non caricato).'));
    return wrap;
  }

  // removed function myDevicesPage() {}
  // myDevicesPage implementation moved to hardware.js to keep hardware concerns together.
  async function myDevicesPage(){
    if (window && typeof window.myDevicesPage === 'function') return window.myDevicesPage();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','I miei dispositivi'));
    wrap.appendChild(el('div.small','Sezione dispositivi non disponibile (modulo hardware non caricato).'));
    return wrap;
  }

  function licensesPage(){
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Licenze'));
    wrap.appendChild(el('div.small','Licenze disponibili e stato delle collaborazioni'));
    const l = document.createElement('div'); l.className='list';
    l.appendChild(el('div.tx',[el('div','Licenza base'), el('div.meta','Abilita features base')]));
    l.appendChild(el('div.tx',[el('div','Licenza Pro'), el('div.meta','Boost task, prelievo ridotto')]));
    wrap.appendChild(l);
    return wrap;
  }

  // transactions page with simple pagination — 10 items per page
  async function transactionsPage(){
    const session = getSession();
    const perPage = 10;
    const page = Math.max(1, Math.floor(txPage) || 1);

    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Cronologia transazioni'));
    wrap.appendChild(el('div.small',`Pagina ${page} — elenco completo delle transazioni`));

    const allTx = txCol.getList().filter(t => t.user_id === session.id).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    const start = (page - 1) * perPage;
    const pageItems = allTx.slice(start, start + perPage);

    const list = document.createElement('div'); list.className='list';
    if (pageItems.length === 0) list.appendChild(el('div.small','Nessuna transazione in questa pagina'));
    pageItems.forEach(t=>{
      const row = document.createElement('div'); row.className='tx';
      const left = document.createElement('div');
      left.appendChild(el('div', `${t.type.toUpperCase()} · ${t.note || ''}`));
      left.appendChild(el('div.meta', new Date(t.created_at).toLocaleString()));
      row.appendChild(left);

      const right = document.createElement('div');
      right.style.display='flex'; right.style.flexDirection='column'; right.style.alignItems='flex-end'; right.style.gap='8px';
      right.appendChild(el('div', formatMoney(t.amount)));
      const st = t.status || 'confirmed';
      const badge = document.createElement('div'); badge.className = 'badge ' + (st === 'pending' ? 'pending' : (st === 'otp_sent' ? 'otp_sent' : 'confirmed'));
      badge.textContent = (st === 'pending' ? 'PENDENTE' : (st === 'otp_sent' ? 'OTP INVIATO' : (t.credited ? 'ACCREDITATO' : 'CONFERMATO')));
      right.appendChild(badge);

      const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
      const details = document.createElement('button'); details.className='small-action'; details.textContent='Dettagli';
      details.onclick = ()=>{ alert(`${t.type.toUpperCase()} — ${t.note || '(nessuna nota)'}\n${new Date(t.created_at).toLocaleString()}`); };
      actions.appendChild(details);

      const stLow = (t.status||'').toLowerCase();
      if (stLow === 'otp_sent' || stLow === 'pending') {
        const enterOtp = document.createElement('button'); enterOtp.className='small-action'; enterOtp.textContent='Inserisci OTP';
        enterOtp.onclick = ()=> { confirmTransactionWithOTP(t.id); };
        actions.appendChild(enterOtp);
      }

      right.appendChild(actions);

      row.appendChild(right);
      list.appendChild(row);
    });

    wrap.appendChild(list);

    // pagination controls
    const nav = document.createElement('div'); nav.style.display='flex'; nav.style.justifyContent='space-between'; nav.style.marginTop='10px';
    const prev = document.createElement('button'); prev.className='btn'; prev.textContent='◀ Pagina precedente';
    prev.onclick = ()=>{ if (page > 1) { txPage = page - 1; navigate('transactions'); } else alert('Sei alla prima pagina'); };
    const next = document.createElement('button'); next.className='btn'; next.textContent='Pagina successiva ▶';
    next.onclick = ()=>{ if ((start + perPage) < allTx.length) { txPage = page + 1; navigate('transactions'); } else alert('Nessuna altra pagina'); };
    nav.appendChild(prev); nav.appendChild(next);
    wrap.appendChild(nav);

    return wrap;
  }

   // Admin panel: accessible only to creator/admin sessions, shows pending transactions and ability to send OTPs and confirm.
  function adminPage(){
    const session = getSession();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Pannello Admin'));
    wrap.appendChild(el('div.small','Revisione richieste utenti — genera OTP e conferma transazioni'));

    if (!session || !session.is_admin) {
      const warn = document.createElement('div'); warn.className='empty-state';
      warn.textContent = 'Accesso admin richiesto. Accedi come creatore tramite la pagina login.';
      wrap.appendChild(warn);
      return wrap;
    }

    // Add admin logout button (clears session and returns to login)
    const adminControls = document.createElement('div');
    adminControls.style.display = 'flex';
    adminControls.style.justifyContent = 'flex-end';
    adminControls.style.gap = '8px';
    adminControls.style.marginBottom = '10px';

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn';
    logoutBtn.textContent = 'Esci';
    logoutBtn.onclick = async () => {
      // clear local session and redirect to login
      await clearSession();
      navigate('login');
    };

    adminControls.appendChild(logoutBtn);
    wrap.appendChild(adminControls);

    // list pending transactions across users
    const pending = txCol.getList().filter(t => t.status === 'pending' || t.status === 'otp_sent');
    const container = document.createElement('div'); container.className='list';
    if (pending.length === 0) container.appendChild(el('div.small','Nessuna transazione in stato PENDENTE'));
    pending.forEach(t=>{
      const row = document.createElement('div'); row.className='tx';
      const left = document.createElement('div');
      left.appendChild(el('div', `${t.type.toUpperCase()} · ${t.user_id || 'utente sconosciuto'}`));
      left.appendChild(el('div.meta', new Date(t.created_at).toLocaleString()));
      row.appendChild(left);

      const right = document.createElement('div');
      right.style.display='flex'; right.style.flexDirection='column'; right.style.alignItems='flex-end'; right.style.gap='8px';
      right.appendChild(el('div', formatMoney(t.amount)));
      right.appendChild(el('div.meta', t.note || ''));

      const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';

      const sendOtp = document.createElement('button'); sendOtp.className='primary'; sendOtp.textContent='Genera OTP';
      sendOtp.onclick = async ()=>{
        const code = generateOTP();
        await otpCol.create({
          tx_id: t.id,
          user_id: t.user_id,
          code,
          created_at: new Date().toISOString(),
          used: false,
          sent_by: session.username
        });
        // mark tx as otp_sent for tracking
        await txCol.update && txCol.update(t.id, { status: 'otp_sent' }).catch(()=>{});
        alert('OTP generato e assegnato: ' + code + '\nL\'utente dovrà inserire questo codice nella sua lista "Transazioni recenti" per confermare.');
        render();
      };

      const confirmNow = document.createElement('button'); confirmNow.className='btn'; confirmNow.textContent='Conferma';
      confirmNow.onclick = async ()=>{
        if (!confirm('Confermare manualmente questa transazione (senza OTP)?')) return;
        // build update payload and mark deposit as credited when applicable
        const payload = { status: 'confirmed', confirmed_at: new Date().toISOString() };
        if (t.type === 'deposit') {
          payload.credited = true;
          payload.credited_at = new Date().toISOString();
          payload.note = (t.note || '') + ' (accreditato manualmente)';
        } else if (t.type === 'withdraw') {
          payload.note = (t.note || '') + ' (prelievo confermato manualmente)';
        }
        await txCol.update && txCol.update(t.id, payload);
        // mark any OTPs related to this transaction as used so they are removed from user notifications
        try {
          const relatedOtps = otpCol.getList().filter(o => o.tx_id === t.id && !o.used);
          for (const o of relatedOtps) {
            await otpCol.update && otpCol.update(o.id, { used: true, used_at: new Date().toISOString(), consumed_by: session.username });
          }
        } catch (e) {
          console.warn('Failed to mark related OTPs as used', e);
        }
        alert('Transazione confermata manualmente.');
        render();
      };

      actions.appendChild(sendOtp); actions.appendChild(confirmNow);
      right.appendChild(actions);
      row.appendChild(right);
      container.appendChild(row);
    });

    wrap.appendChild(container);

    // quick controls: set admin password (stored locally) to avoid hardcoded credential
    const pwdRow = document.createElement('div'); pwdRow.style.marginTop='12px'; pwdRow.style.display='flex'; pwdRow.style.gap='8px';
    const pwdInput = document.createElement('input'); pwdInput.className='input'; pwdInput.placeholder='Nuova password admin (min 4)'; pwdInput.type='password';
    const pwdBtn = document.createElement('button'); pwdBtn.className='btn'; pwdBtn.textContent='Imposta';
    pwdBtn.onclick = ()=> {
      if (!pwdInput.value || pwdInput.value.length < 4) return alert('Password troppo corta');
      localStorage.setItem('cup9gpu_admin_pass', pwdInput.value);
      alert('Password admin aggiornata localmente.');
    };
    pwdRow.appendChild(pwdInput); pwdRow.appendChild(pwdBtn);
    wrap.appendChild(pwdRow);

    return wrap;
  }

  function profilePage(){
    const session = getSession();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Profilo'));
    wrap.appendChild(el('div.small','ID UTENTE: ' + (session.uid || session.user_uid || 'n/d')));
    wrap.appendChild(el('div.small','Username: ' + session.username));
    wrap.appendChild(el('div.small','Email: ' + session.email));
    const btnLogout = document.createElement('button'); btnLogout.className='btn'; btnLogout.textContent='Esci';
    btnLogout.onclick = ()=>{ clearSession(); navigate('login'); };
    wrap.appendChild(btnLogout);
    return wrap;
  }

  // bottom navigation builder — returns an integrated nav that can be embedded into the page wrapper
  // pass inPage=true to make it the in-page (non-fixed) nav; for backwards compatibility, fixed mode still supported.
  function bottomNav(active, inPage){
    const nav = document.createElement('div');
    // default to integrated (non-fixed). If inPage is false but a fixed nav is desired, use 'fixed' class.
    nav.className = 'bottom-nav' + ((inPage === false) ? ' fixed' : '');
    const items = [
      {k:'home',label:'Home',icon:'🏠'},
      {k:'hardware',label:'Hardware',icon:'⚙️'},
      {k:'devices',label:'My Devices',icon:'💽'},
      {k:'licenses',label:'Licenze',icon:'🔑'},
      {k:'profile',label:'Profilo',icon:'👤'}
    ];
    items.forEach(it=>{
      const a = document.createElement('div'); a.className='nav-item' + (it.k===active ? ' active':'' );
      a.onclick = ()=>{ navigate(it.k); };
      a.innerHTML = `<div style="font-size:18px">${it.icon}</div><div style="font-size:12px;margin-top:2px">${it.label}</div>`;
      nav.appendChild(a);
    });
    return nav;
  }

  // Deposit / withdraw modals (simple prompts)
  function openDeposit(){
    const amt = parseFloat(prompt('Importo da depositare (USDT):','50'));
    if (!amt || amt<=0) return;
    const method = prompt('Rete (BNB | BTC | TRON | ERC20):','ERC20');
    const session = getSession();
    // create a pending deposit transaction: admin will generate/send OTP to the user from the admin panel
    (async ()=>{
      await txCol.create({
        user_id: session.id,
        type: 'deposit',
        amount: amt,
        method,
        status: 'pending',
        created_at: new Date().toISOString(),
        note: 'Deposito pendente - in attesa OTP (admin)'
      });
      alert('Deposito registrato come PENDENTE. L\'amministratore genererà un OTP per la conferma e lo invierà al tuo account.');
      render();
    })();
  }

  function openWithdraw(){
    const amt = parseFloat(prompt('Importo da prelevare (USDT):','100'));
    if (!amt || amt<=0) return;
    const session = getSession();
    // simple rules enforcement (as described)
    if (amt < 100) {
      alert('Prelievo minimo 100$ (50$ con licenza).');
      return;
    }
    // ensure withdrawals draw only from confirmed earnings (withdrawable)
    const userTx = txCol.getList().filter(t => t.user_id === session.id);
    const earnings = userTx.filter(t => t.type === 'earning' && t.status !== 'pending').reduce((s,t)=>s+(Number(t.amount)||0),0);
    const withdrawals = userTx.filter(t => t.type === 'withdraw' && t.status === 'confirmed').reduce((s,t)=>s+(Number(t.amount)||0),0);
    const currentWithdrawable = Math.max(0, earnings - withdrawals);
    if (amt > currentWithdrawable) {
      return alert('Fondi insufficienti sul saldo prelevabile (solo i guadagni confermati sono prelevabili).');
    }
    // create a pending withdraw transaction: admin will generate/send OTP to the user from the admin panel
    (async ()=>{
      await txCol.create({
        user_id: session.id,
        type: 'withdraw',
        amount: amt,
        status: 'pending',
        created_at: new Date().toISOString(),
        note: 'Prelievo pendente - in attesa OTP (admin)'
      });
      alert('Richiesta prelievo registrata come PENDENTE. L\'amministratore genererà un OTP per la conferma e lo invierà al tuo account.');
      render();
    })();
  }

  // Utilities
  function labeled(id, text){ const l = document.createElement('label'); l.textContent = text; return l; }
  function input(type,name){ const i = document.createElement('input'); i.type=type; i.name=name; i.className='input'; i.autocomplete='off'; return i; }
  function formatMoney(n){
    const num = typeof n === 'number' ? n : (Number(n) || 0);
    // pretty format with thousands separators and two decimals
    return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // build a transaction row DOM element (reusable) and include an "Inserisci OTP" button when appropriate
  function buildTxRow(t){
    const row = document.createElement('div'); row.className='tx';
    const left = document.createElement('div'); left.className = 'tx-left';
    const typeBadge = document.createElement('div'); typeBadge.className = 'tx-type'; typeBadge.textContent = (t.type||'').toUpperCase();
    const time = document.createElement('div'); time.className = 'tx-time'; time.textContent = new Date(t.created_at).toLocaleString();
    left.appendChild(typeBadge); left.appendChild(time);

    const center = document.createElement('div'); center.className = 'tx-center';
    const note = document.createElement('div'); note.className = 'tx-note'; note.textContent = t.note || '';
    center.appendChild(note);

    const right = document.createElement('div'); right.className = 'tx-right';
    right.appendChild(el('div.tx-amount', formatMoney(t.amount)));
    const badge = document.createElement('div');
    const st = t.status || 'confirmed';
    badge.className = 'badge ' + (st === 'pending' ? 'pending' : (st === 'otp_sent' ? 'otp_sent' : 'confirmed'));
    badge.textContent = (st === 'pending' ? 'PENDENTE' : (st === 'otp_sent' ? 'OTP INVIATO' : (t.credited ? 'ACCREDITATO' : 'CONFERMATO')));
    right.appendChild(badge);

    const actions = document.createElement('div'); actions.className = 'tx-actions';
    const details = document.createElement('button'); details.className='small-action'; details.textContent='Dettagli';
    details.onclick = ()=>{ alert(`${(t.type||'').toUpperCase()} — ${t.note || '(nessuna nota)'}\n${new Date(t.created_at).toLocaleString()}`); };
    actions.appendChild(details);

    const stLow = (t.status||'').toLowerCase();
    if (stLow === 'otp_sent' || stLow === 'pending') {
      const enterOtp = document.createElement('button'); enterOtp.className='small-action'; enterOtp.textContent='Inserisci OTP';
      enterOtp.onclick = ()=> { confirmTransactionWithOTP(t.id); };
      actions.appendChild(enterOtp);
    }

    right.appendChild(actions);

    row.appendChild(left);
    row.appendChild(center);
    row.appendChild(right);
    return row;
  }

  function computeDaily(user_id){
    // Sum daily yield of active devices
    const devs = deviceCol.getList().filter(d=>d.owner_id===user_id && d.active);
    return devs.reduce((s,d)=>s + (d.daily_yield||0), 0);
  }

  // Allow users to input an OTP code for a given transaction id.
  // This global helper is used by multiple page views so the user can always enter an OTP sent by admin.
  async function confirmTransactionWithOTP(txId){
    try {
      const session = getSession();
      if (!session) return alert('Sessione non trovata. Effettua il login.');
      const tx = txCol.getList().find(x => x.id === txId && x.user_id === session.id);
      if (!tx) return alert('Transazione non trovata o non appartiene all\'utente.');
      const code = prompt('Inserisci OTP per confermare la transazione:','');
      if (!code) return;
      // find OTP entry
      const otpRec = otpCol.getList().find(o => o.tx_id === txId && String(o.code) === String(code) && !o.used && o.user_id === session.id);
      if (!otpRec) return alert('OTP non valido o già usato');
      try {
        await otpCol.update && otpCol.update(otpRec.id, { used: true, used_at: new Date().toISOString() });
      } catch(e){ /* best-effort */ }
      const updatePayload = {
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      };
      if (tx.type === 'deposit') {
        updatePayload.credited = true;
        updatePayload.credited_at = new Date().toISOString();
        updatePayload.note = (tx.note || '') + ' (accreditato via OTP)';
      } else if (tx.type === 'withdraw') {
        updatePayload.note = (tx.note || '') + ' (prelievo confermato via OTP)';
      }
      await txCol.update && txCol.update(txId, updatePayload);
      alert('Transazione confermata.');
      render();
    } catch (e) {
      console.warn('confirmTransactionWithOTP failed', e);
      alert('Conferma OTP fallita.');
    }
  }

  function generateOTP(){
    return Math.floor(100000 + Math.random()*900000).toString();
  }

  // accrues daily earnings for devices owned by the session user.
  // This runs on render and credits one accrual per day per active device (based on last_accrual).
  async function accrueEarnings(session){
    if (!session) return;
    const today = new Date();
    const devs = deviceCol.getList().filter(d=>d.owner_id===session.id && d.active);
    for (const d of devs){
      try {
        // parse last_accrual or fallback to created_at
        const last = d.last_accrual ? new Date(d.last_accrual) : (d.created_at ? new Date(d.created_at) : null);
        // if never accrued or last accrual is before today (different day), credit one accrual per missing day up to a cap (30)
        const lastTime = last ? new Date(last.getFullYear(), last.getMonth(), last.getDate()) : null;
        const todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const daysMissing = lastTime ? Math.floor((todayTime - lastTime) / (1000*60*60*24)) : 1;
        if (!daysMissing || daysMissing <= 0) continue;
        const cap = Math.min(daysMissing, 30);
        const perDay = Number(d.daily_yield) || 0;
        if (perDay <= 0) {
          // update last_accrual to today to avoid repeated loops
          await deviceCol.update && deviceCol.update(d.id, { last_accrual: today.toISOString() });
          continue;
        }
        // create a single aggregated earning transaction for the missing days
        const total = +(perDay * cap).toFixed(2);
        await txCol.create({
          user_id: session.id,
          type: 'earning',
          amount: total,
          created_at: new Date().toISOString(),
          note: `Accredito ${cap} giorno(i) - ${d.name}`
        });
        // update device last_accrual to today
        await deviceCol.update && deviceCol.update(d.id, { last_accrual: today.toISOString() });
      } catch(e){
        console.warn('accrue error', e);
      }
    }
  }

  // initial seed: show platform funding note as a small card (no external credential calls)
  async function seedCreator() {
    const metaCol = getCollection('meta_v1');
    const recs = metaCol.getList();
    if (!recs.find(r=>r.key==='about')) {
      await metaCol.create({
        key:'about',
        text: 'CUP LTD ha destinato 1 milione di dollari come capitale iniziale per infrastruttura e crescita.',
        created_at: new Date().toISOString()
      });
    }
  }

  // expose session and navigation helpers globally so sessions created on the backend are usable from other browsers/tabs
  window.getSession = getSession;
  window.saveSession = saveSession;
  window.clearSession = clearSession;
  window.navigate = navigate;
  window.render = render;
  // also expose format/generate helpers for external modules
  window.formatMoney = formatMoney;
  window.generateOTP = generateOTP;

  // Start
  await seedCreator();
  render();

})();
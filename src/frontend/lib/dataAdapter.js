// Repository/data-adapter layer (S2): UI -> this module -> local cache ->
// Supabase. UI code never calls window.TunaSupabase / window.TunaAuth
// directly for data - only this module's narrow operations. Swapping the
// backend later means changing this file, not the UI.
//
// Offline-first: every write applies to the local cache immediately
// (optimistic) and is queued; the queue is flushed opportunistically (on
// call, on 'online', and once after auth). Conflict model: last-write-wins
// via `revision` + `updated_at`, enforced by the DB trigger
// (tuna_touch_updated_at in 0001_init.sql) - a queued mutation whose target
// row no longer exists (deleted by another client) is dropped and logged
// rather than silently discarded or retried forever; this is a deliberate,
// deterministic, minimal conflict rule, not a new conflict-resolution UI.
window.TunaDataAdapter = (function () {
  // User-scoped cache key - see logout-cache-isolation fix (PS-140). A
  // single fixed key here was the bug: USER_B could see USER_A's cached
  // tasks for one render (or longer, since refreshFromServer *merges*
  // rather than replaces) after a device-local sign-out/sign-in. Each
  // user's own cache is kept under their own key (so THEY get it back on
  // next login, per the "restore own cache" requirement) but no other
  // user's key is ever read.
  const CACHE_KEY_PREFIX = 'tuna.standalone.cache.v1.';
  const DEFAULT_LISTS = [
    { name: 'Work', color: 'coral', sort_order: 0 },
    { name: 'Personal', color: 'violet', sort_order: 1 },
    { name: 'Finance', color: 'blue', sort_order: 2 },
    { name: 'General', color: 'gold', sort_order: 3 },
  ];

  let client = null;
  let userId = null;
  let realtimeChannel = null;
  const listeners = new Set(); // called after any cache change, so the UI can re-render

  // Starts empty on module load and after teardown() - never pre-populated
  // from any localStorage key before a real, current userId is known, so
  // there is no moment where a stale/other user's data could be read.
  let cache = { tasks: [], lists: [], queue: [] };

  function cacheKeyFor(uid) {
    return `${CACHE_KEY_PREFIX}${uid}`;
  }
  function loadCacheFor(uid) {
    try {
      const raw = localStorage.getItem(cacheKeyFor(uid));
      return raw ? JSON.parse(raw) : { tasks: [], lists: [], queue: [] };
    } catch {
      return { tasks: [], lists: [], queue: [] };
    }
  }
  function saveCache(c) {
    if (!userId) return; // never write without a known, current owner
    try { localStorage.setItem(cacheKeyFor(userId), JSON.stringify(c)); } catch { /* best-effort */ }
  }

  function notify() {
    saveCache(cache);
    for (const fn of listeners) fn();
  }

  function log(level, msg) {
    if (window.tunaDesktop) window.tunaDesktop[level === 'error' ? 'logError' : 'logInfo'](`[dataAdapter] ${msg}`);
  }

  function newLocalId() {
    return crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function queueMutation(op) {
    cache.queue.push({ ...op, queuedAt: new Date().toISOString() });
    notify();
    flushQueue(); // best-effort, non-blocking
  }

  // Guards against concurrent drains (found live 2026-09-22, PS-148):
  // ensureDefaultLists() queues 4 mutations back-to-back, synchronously,
  // each call to queueMutation() firing its own flushQueue(). Without this
  // guard, all 4 invocations start before the first ever awaits past
  // cache.queue[0], so every one of them reads the SAME op (queue[0] not
  // yet shifted), and each completion (real insert or ignored 23505
  // duplicate) still shifts the queue - net effect: items get shifted off
  // and silently dropped without ever actually being sent, well before
  // their own turn. Confirmed empirically: only 1 of 4 default lists
  // ("Work") survived a real sign-in.
  //
  // A single shared in-flight PROMISE (not just a boolean flag) serializes
  // all drains onto one loop AND lets every caller actually await real
  // completion - a boolean-only guard made a concurrent caller's `await
  // flushQueue()` return immediately as a no-op instead of waiting for the
  // already-running drain, which is exactly what init()'s own explicit
  // `await flushQueue()` needs to not do.
  let flushPromise = null;
  function flushQueue() {
    if (!flushPromise) {
      flushPromise = drainQueue().finally(() => { flushPromise = null; });
    }
    return flushPromise;
  }

  async function drainQueue() {
    if (!client || !navigator.onLine) return;
    while (cache.queue.length) {
      const op = cache.queue[0];
      try {
        await applyMutation(op);
      } catch (err) {
        // network/transient failure - stop here, retry later, leave queue intact
        log('warn', `flush stopped: ${err.message || err}`);
        return;
      }
      cache.queue.shift();
      saveCache(cache);
    }
  }

  async function applyMutation(op) {
    if (op.table === 'tasks') {
      if (op.type === 'create') {
        const { error } = await client.from('tasks').insert({ ...op.fields, id: op.id, user_id: userId });
        if (error && error.code !== '23505') throw error; // ignore duplicate-id replay
      } else if (op.type === 'update') {
        const { error } = await client.from('tasks').update(op.fields).eq('id', op.id).eq('user_id', userId);
        if (error) {
          if (error.code === 'PGRST116') { log('warn', `conflict: task ${op.id} missing on server, dropping queued update`); return; }
          throw error;
        }
      } else if (op.type === 'delete') {
        const { error } = await client.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', op.id).eq('user_id', userId);
        if (error && error.code !== 'PGRST116') throw error;
      }
    } else if (op.table === 'lists' && op.type === 'create') {
      const { error } = await client.from('lists').insert({ ...op.fields, id: op.id, user_id: userId });
      if (error && error.code !== '23505') throw error;
    }
  }

  async function ensureDefaultLists() {
    const { data, error } = await client.from('lists').select('*').eq('user_id', userId).is('deleted_at', null);
    if (error) { log('error', `list fetch failed: ${error.message}`); return; }
    if (data.length > 0) { cache.lists = data; notify(); return; }
    const seeded = DEFAULT_LISTS.map((l) => ({ ...l, id: newLocalId() }));
    cache.lists = seeded;
    notify();
    for (const l of seeded) queueMutation({ table: 'lists', type: 'create', id: l.id, fields: { name: l.name, color: l.color, sort_order: l.sort_order } });
  }

  async function refreshFromServer() {
    if (!client || !navigator.onLine) return;
    const [tasksRes, listsRes] = await Promise.all([
      client.from('tasks').select('*').eq('user_id', userId).is('deleted_at', null).order('created_at'),
      client.from('lists').select('*').eq('user_id', userId).is('deleted_at', null).order('sort_order'),
    ]);
    if (!tasksRes.error) cache.tasks = mergeByRevision(cache.tasks, tasksRes.data);
    if (!listsRes.error) cache.lists = listsRes.data;
    notify();
  }

  // Last-write-wins by revision: an incoming row only overwrites the cached
  // one if it's strictly newer, so a stale realtime echo of our own
  // optimistic write never regresses the local state.
  function mergeByRevision(local, incoming) {
    const byId = new Map(local.map((t) => [t.id, t]));
    for (const row of incoming) {
      const existing = byId.get(row.id);
      if (!existing || (row.revision || 0) >= (existing.revision || 0)) byId.set(row.id, row);
    }
    return Array.from(byId.values());
  }

  function setupRealtime() {
    if (!client || realtimeChannel) return;
    realtimeChannel = client
      .channel(`tuna-tasks-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` }, (payload) => {
        if (payload.eventType === 'DELETE') {
          cache.tasks = cache.tasks.filter((t) => t.id !== payload.old.id);
        } else {
          cache.tasks = mergeByRevision(cache.tasks, [payload.new]);
        }
        notify();
      })
      .subscribe();
  }

  function teardownRealtime() {
    if (realtimeChannel) { client.removeChannel(realtimeChannel); realtimeChannel = null; }
  }

  window.addEventListener('online', flushQueue);

  return {
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },

    async init(supabaseClient, uid) {
      client = supabaseClient; userId = uid;
      // Load ONLY this user's own scoped cache - never whatever was in
      // memory a moment ago (a previous, different user's session).
      cache = loadCacheFor(uid);
      notify(); // let the UI reflect this user's own cache immediately,
                // before the network round-trip below completes
      await ensureDefaultLists();
      // Flush BEFORE refreshing from the server, not after: ensureDefaultLists
      // may have just queued local-only list creates, and refreshFromServer's
      // `cache.lists = listsRes.data` is a straight replace (unlike tasks,
      // which go through mergeByRevision) - refreshing first would overwrite
      // those locally-seeded-but-not-yet-confirmed lists with the server's
      // still-empty result. Flushing first means refreshFromServer then
      // correctly reflects reality either way (found live 2026-09-22, PS-148).
      await flushQueue();
      await refreshFromServer();
      setupRealtime();
    },
    teardown() {
      teardownRealtime();
      client = null; userId = null;
      // Reset in-memory state immediately (not just on the next init) -
      // this is what actually closes the isolation gap: even a caller that
      // reads listTasks()/listLists() between teardown() and the next
      // init() sees nothing, never the previous user's data. Their own
      // cache row in localStorage is left untouched so they get it back on
      // their own next sign-in (see logoutCacheIsolation notes above).
      cache = { tasks: [], lists: [], queue: [] };
      for (const fn of listeners) fn();
    },

    listTasks: async () => cache.tasks.filter((t) => !t.deleted_at),
    listLists: async () => cache.lists,

    createTask: async (fields) => {
      const id = newLocalId();
      const now = new Date().toISOString();
      const task = { id, user_id: userId, title: fields.title, list_id: fields.list_id || null, priority: !!fields.priority, done: false, due_date: fields.due_date || null, revision: 1, created_at: now, updated_at: now, deleted_at: null };
      cache.tasks.push(task);
      notify();
      queueMutation({ table: 'tasks', type: 'create', id, fields: { title: task.title, list_id: task.list_id, priority: task.priority, done: task.done, due_date: task.due_date } });
      return task;
    },
    updateTask: async (id, fields) => {
      const idx = cache.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return null;
      cache.tasks[idx] = { ...cache.tasks[idx], ...fields, updated_at: new Date().toISOString(), revision: (cache.tasks[idx].revision || 0) + 1 };
      notify();
      queueMutation({ table: 'tasks', type: 'update', id, fields });
      return cache.tasks[idx];
    },
    completeTask: async (id, done = true) => window.TunaDataAdapter.updateTask(id, { done }),
    deleteTask: async (id) => {
      const idx = cache.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return false;
      cache.tasks[idx].deleted_at = new Date().toISOString();
      notify();
      queueMutation({ table: 'tasks', type: 'delete', id, fields: {} });
      return true;
    },
  };
})();

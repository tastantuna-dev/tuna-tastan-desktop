// Data abstraction interface (S1 scaffold) - defines the shape every future
// backend (S2: real sync backend) must implement. Today it is backed by
// localStorage only, single-device, no sync, no auth - a placeholder so the
// rest of the frontend can be written against a stable interface instead of
// directly against localStorage. Do not treat this as the real data model;
// it exists to be replaced, not extended in place.
//
// Task shape (mirrors the real app's observed fields - title/list/priority/
// done - captured from the real app's own DOM/CSS on 2026-09-22):
//   { id, ownerId, createdAt, updatedAt, revision, deleted,
//     title, list, priority, done }
// - id: string, client-generated (crypto.randomUUID())
// - ownerId: string, "local" until real auth exists (S2)
// - createdAt/updatedAt: ISO 8601 strings
// - revision: integer, incremented on every local write (S2 sync will use
//   this for last-write-wins / conflict detection - see migration report)
// - deleted: boolean tombstone (soft delete, never physically removed
//   locally, so a future sync pass can propagate the deletion)

(function () {
  const STORAGE_KEY = 'tuna.standalone.v1';
  const DEFAULT_LISTS = [
    { id: 'work', label: 'Work', color: 'coral' },
    { id: 'personal', label: 'Personal', color: 'violet' },
    { id: 'finance', label: 'Finance', color: 'blue' },
    { id: 'general', label: 'General', color: 'gold' },
  ];

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { tasks: [], notes: [], settings: {} };
      return JSON.parse(raw);
    } catch {
      return { tasks: [], notes: [], settings: {} };
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // best-effort only; a full quota/availability story belongs to S2
    }
  }

  function newId() {
    return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  function stampNew(fields) {
    const now = new Date().toISOString();
    return { id: newId(), ownerId: 'local', createdAt: now, updatedAt: now, revision: 1, deleted: false, ...fields };
  }

  function stampUpdate(entity, fields) {
    return { ...entity, ...fields, updatedAt: new Date().toISOString(), revision: (entity.revision || 0) + 1 };
  }

  const state = loadState();

  function collection(name) {
    return {
      list: async () => state[name].filter((e) => !e.deleted),
      get: async (id) => state[name].find((e) => e.id === id) || null,
      create: async (fields) => {
        const entity = stampNew(fields);
        state[name].push(entity);
        saveState(state);
        return entity;
      },
      update: async (id, fields) => {
        const idx = state[name].findIndex((e) => e.id === id);
        if (idx === -1) return null;
        state[name][idx] = stampUpdate(state[name][idx], fields);
        saveState(state);
        return state[name][idx];
      },
      remove: async (id) => {
        const idx = state[name].findIndex((e) => e.id === id);
        if (idx === -1) return false;
        state[name][idx] = stampUpdate(state[name][idx], { deleted: true });
        saveState(state);
        return true;
      },
    };
  }

  window.TunaDataStore = {
    tasks: collection('tasks'),
    notes: collection('notes'),
    lists: { list: async () => DEFAULT_LISTS },
    settings: {
      get: async (key) => state.settings[key],
      set: async (key, value) => { state.settings[key] = value; saveState(state); return value; },
    },
  };
})();

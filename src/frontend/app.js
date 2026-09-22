// S1 standalone shell - visual/behavioral reconstruction of the real app,
// captured live via CDP against the user's own authenticated session on
// 2026-09-22 (see STANDALONE_MIGRATION_S1 report). Markup/classes/copy are
// kept verbatim from the real DOM where observed. Anything NOT directly
// observed (the exact "Start a 25 min focus" timer behavior, the real
// create/edit form's full field set) is left as an inert visual match only
// - see UI_PARITY_BLOCKER notes in the report; do not invent behavior here.
//
// S2: backend-agnostic. `dataSource` is either the real Supabase-backed
// adapter (once signed in and configured) or the S1 local-only store (not
// configured yet, or signed out) - same {tasks:{list,create,update,remove},
// lists:{list}} shape either way, so none of the render functions below
// need to know or care which one is active.
(function () {
  const desktop = !!(window.tunaDesktop && window.tunaDesktop.desktop);

  const VIEWS = [
    { id: 'today', label: 'My day', icon: '◫' },
    { id: 'upcoming', label: 'Upcoming', icon: '⌁' },
    { id: 'completed', label: 'Completed', icon: '✓' },
    { id: 'all', label: 'All tasks', icon: '≡' },
  ];

  let lists = [];
  let currentView = 'today';
  let currentList = null;
  let dataSource = window.TunaDataStore; // default until/unless Supabase takes over

  const el = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function todayLabel() {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  }

  async function renderNav() {
    const tasks = await dataSource.tasks.list();
    const countFor = (predicate) => tasks.filter(predicate).length;
    el('view-nav').innerHTML = VIEWS.map((v) => {
      const count = v.id === 'completed' ? countFor((t) => t.done) : v.id === 'all' ? countFor(() => true) : countFor((t) => !t.done);
      return `<button class="nav-item ${currentView === v.id && !currentList ? 'active' : ''}" data-view="${v.id}"><span>${v.icon}</span>${v.label}<b>${count}</b></button>`;
    }).join('');
    el('list-nav').innerHTML = lists.map((l) => {
      const count = countFor((t) => (t.list === l.id || t.list_id === l.id) && !t.done);
      return `<button class="nav-item ${currentList === l.id ? 'active' : ''}" data-list="${l.id}"><i class="dot ${l.color}"></i>${l.label || l.name}<b>${count}</b></button>`;
    }).join('');
    for (const btn of el('view-nav').querySelectorAll('[data-view]')) {
      btn.addEventListener('click', () => { currentView = btn.dataset.view; currentList = null; render(); });
    }
    for (const btn of el('list-nav').querySelectorAll('[data-list]')) {
      btn.addEventListener('click', () => { currentList = btn.dataset.list; render(); });
    }
  }

  function renderTaskRow(task) {
    const listId = task.list || task.list_id;
    const list = lists.find((l) => l.id === listId);
    return `<div class="task-row ${task.done ? 'done' : ''}" data-id="${task.id}">
      <button class="check" aria-label="Toggle done"></button>
      <div>
        <h3>${escapeHtml(task.title)}</h3>
        <p>${list ? `<i class="dot ${list.color}"></i>${list.label || list.name}` : ''}</p>
      </div>
      ${task.priority ? '<span class="priority">Priority</span>' : ''}
      <button class="edit-btn" aria-label="Edit">&#9998;</button>
      <button class="delete-btn" aria-label="Delete">&#128465;</button>
    </div>`;
  }

  async function renderTasks() {
    const all = await dataSource.tasks.list();
    let filtered = all;
    if (currentList) filtered = filtered.filter((t) => (t.list || t.list_id) === currentList);
    else if (currentView === 'completed') filtered = filtered.filter((t) => t.done);
    else if (currentView !== 'all') filtered = filtered.filter((t) => !t.done);

    const heading = currentList ? (lists.find((l) => l.id === currentList) || {}).label || (lists.find((l) => l.id === currentList) || {}).name
      : VIEWS.find((v) => v.id === currentView)?.label;
    el('section-title').textContent = currentView === 'today' && !currentList ? 'Today' : heading;
    el('section-count').textContent = `${filtered.length} task${filtered.length === 1 ? '' : 's'}`;

    el('task-list').innerHTML = filtered.length
      ? filtered.map(renderTaskRow).join('')
      : '<div class="empty-state"><b>All clear.</b><span>Add a task above and make a little progress.</span></div>';

    for (const row of el('task-list').querySelectorAll('.task-row')) {
      const id = row.dataset.id;
      row.querySelector('.check').addEventListener('click', async () => {
        const task = all.find((t) => t.id === id);
        await dataSource.tasks.update(id, { done: !task.done });
        render();
      });
      row.querySelector('.delete-btn').addEventListener('click', async () => {
        await dataSource.tasks.remove(id);
        render();
      });
    }

    const total = all.length;
    const done = all.filter((t) => t.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    el('progress-text').textContent = `${done} of ${total} tasks`;
    el('progress-bar').style.width = `${pct}%`;
    el('progress-pct').textContent = `${pct}%`;
    el('completed-note').textContent = `You’ve completed ${done} task${done === 1 ? '' : 's'} so far.`;
  }

  function renderCalendar(ref) {
    const year = ref.getFullYear(), month = ref.getMonth();
    el('calendar-month').textContent = ref.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    let html = '';
    for (let i = startOffset; i > 0; i--) html += `<button class="outside"><span>${daysInPrevMonth - i + 1}</span></button>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
      html += `<button class="${isToday ? 'today' : ''}"><span>${d}</span></button>`;
    }
    const remaining = (7 - ((startOffset + daysInMonth) % 7)) % 7;
    for (let d = 1; d <= remaining; d++) html += `<button class="outside"><span>${d}</span></button>`;
    el('calendar-grid').innerHTML = html;
  }

  function renderClocks() {
    const fmt = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
    el('clock-berlin').textContent = fmt('Europe/Berlin');
    el('clock-ankara').textContent = fmt('Europe/Istanbul');
  }

  async function render() {
    el('today-label').textContent = todayLabel();
    await renderNav();
    await renderTasks();
  }

  function setupMobileMenu() {
    const open = () => { el('sidebar').classList.add('open'); el('scrim').classList.add('open'); };
    const close = () => { el('sidebar').classList.remove('open'); el('scrim').classList.remove('open'); };
    el('mobile-menu').addEventListener('click', open);
    el('close-menu').addEventListener('click', close);
    el('scrim').addEventListener('click', close);
  }

  function setupInstallModal() {
    function open() {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `<section class="install-modal">
        <button class="modal-close" aria-label="Close">&times;</button>
        <span class="install-logo">TT</span>
        <p class="eyebrow">Install the app</p>
        <h2>Tuna Taştan on your computer</h2>
        <ol><li>Open this page in <strong>Chrome or Microsoft Edge</strong>.</li>
        <li>Click the install icon on the right side of the address bar.</li>
        <li>Or open the browser menu and choose <strong>Install Tuna Taştan</strong>.</li></ol>
        <p class="install-note">The installed app opens in its own window and keeps your online task list synced.</p>
        <button class="got-it">Got it</button>
      </section>`;
      document.body.appendChild(wrap);
      const closeModal = () => wrap.remove();
      wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
      wrap.querySelector('.modal-close').addEventListener('click', closeModal);
      wrap.querySelector('.got-it').addEventListener('click', closeModal);
    }
    el('install-app').addEventListener('click', open);
    el('top-install').addEventListener('click', open);
  }

  // Not part of the observed real UI (its auth was entirely ChatGPT's) -
  // the minimal necessary addition for a standalone sign-out affordance,
  // reusing the avatar button that already exists in the real layout.
  function setupSignOut() {
    el('avatar-btn').addEventListener('click', () => {
      const wrap = document.createElement('div');
      wrap.className = 'sign-out-menu';
      wrap.innerHTML = `<div class="sign-out-card">
        <p>Sign out of Tuna Taştan on this device?</p>
        <div class="sign-out-actions">
          <button class="cancel">Cancel</button>
          <button class="confirm">Sign out</button>
        </div>
      </div>`;
      document.body.appendChild(wrap);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
      wrap.querySelector('.cancel').addEventListener('click', () => wrap.remove());
      wrap.querySelector('.confirm').addEventListener('click', async () => {
        wrap.remove();
        if (window.TunaDataAdapter) window.TunaDataAdapter.teardown();
        if (window.TunaAuth) await window.TunaAuth.signOut();
        // onAuthStateChange (registered in init()) drives the switch back
        // to the auth screen - no direct DOM manipulation here.
      });
    });
  }

  function setupQuickAdd() {
    el('quick-add-list').innerHTML = lists.map((l) => `<option value="${l.id}">${l.label || l.name}</option>`).join('');
    el('quick-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = el('quick-add-input');
      const title = input.value.trim();
      if (!title) return;
      const listId = el('quick-add-list').value;
      await dataSource.tasks.create({ title, list: listId, list_id: listId, priority: false, done: false });
      input.value = '';
      render();
    });
  }

  function setupCalendarNav() {
    let ref = new Date();
    renderCalendar(ref);
    el('cal-prev').addEventListener('click', () => { ref = new Date(ref.getFullYear(), ref.getMonth() - 1, 1); renderCalendar(ref); });
    el('cal-next').addEventListener('click', () => { ref = new Date(ref.getFullYear(), ref.getMonth() + 1, 1); renderCalendar(ref); });
  }

  let appInitialized = false;
  async function showApp() {
    el('auth-screen').hidden = true;
    el('app-shell').hidden = false;
    lists = await dataSource.lists.list();
    if (!appInitialized) {
      appInitialized = true;
      setupMobileMenu();
      setupInstallModal();
      setupSignOut();
      setupQuickAdd();
      setupCalendarNav();
      renderClocks();
      setInterval(renderClocks, 1000);
      if (window.TunaDataAdapter) window.TunaDataAdapter.onChange(() => render());
    } else {
      // lists may have changed (e.g. re-signed-in as a different flow) -
      // quick-add's <select> needs the fresh list.
      el('quick-add-list').innerHTML = lists.map((l) => `<option value="${l.id}">${l.label || l.name}</option>`).join('');
    }
    await render();
  }

  function showAuth(statusText, statusClass) {
    el('app-shell').hidden = true;
    el('auth-screen').hidden = false;
    if (statusText) {
      const status = el('auth-status');
      status.textContent = statusText;
      status.className = `auth-status ${statusClass || ''}`;
    }
  }

  // Two-step OTP-code flow (not magic-link-redirect) - see authService.js
  // for why. Step 1: request a code. Step 2: type it back in, no email
  // link click, no custom URL scheme handling required.
  function setupAuthForm() {
    let pendingEmail = '';

    el('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = el('auth-email').value.trim();
      if (!email) return;
      const button = e.target.querySelector('button');
      button.disabled = true;
      try {
        await window.TunaAuth.signInWithEmail(email);
        pendingEmail = email;
        el('auth-form').hidden = true;
        el('auth-code-form').hidden = false;
        el('auth-code').focus();
        showAuth('We sent a sign-in email. Enter the 6-digit code if it has one, or paste the sign-in link itself below.', 'ok');
      } catch (err) {
        showAuth(err.message || 'Could not send the sign-in code.', 'error');
      } finally {
        button.disabled = false;
      }
    });

    el('auth-code-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = el('auth-code').value.trim();
      if (!input || !pendingEmail) return;
      const button = e.target.querySelector('button');
      button.disabled = true;
      try {
        // A bare 6-digit code goes through the OTP-code path; anything
        // longer (a pasted sign-in link, or its raw token) goes through
        // the magic-link-token path instead - see authService.js
        // verifyMagicLinkToken for why both exist (PS-145).
        if (/^\d{6}$/.test(input)) {
          await window.TunaAuth.verifyEmailCode(pendingEmail, input);
        } else {
          await window.TunaAuth.verifyMagicLinkToken(input);
        }
        // onAuthStateChange (registered in init()) takes it from here -
        // no direct DOM switch needed on success.
      } catch (err) {
        showAuth(err.message || 'That code or link did not work - check it and try again.', 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  (async function init() {
    if (desktop) window.tunaDesktop.logInfo('standalone shell loaded');

    const client = window.TunaSupabase ? await window.TunaSupabase.getClient() : null;
    if (!client) {
      // Not configured yet (see config/local.example.json) - S1 behavior:
      // local-only, no auth gate, exactly as before.
      dataSource = window.TunaDataStore;
      await showApp();
      return;
    }

    el('auth-intro').textContent = 'Sign in with your email to sync your tasks across devices.';
    setupAuthForm();

    window.TunaAuth.onAuthStateChange(async (session) => {
      if (session) {
        await window.TunaDataAdapter.init(client, session.user.id);
        dataSource = {
          tasks: {
            list: window.TunaDataAdapter.listTasks,
            create: window.TunaDataAdapter.createTask,
            update: window.TunaDataAdapter.updateTask,
            remove: window.TunaDataAdapter.deleteTask,
          },
          lists: { list: window.TunaDataAdapter.listLists },
        };
        await showApp();
      } else {
        // Covers both the explicit sign-out button (which already calls
        // teardown() itself - this is then a harmless no-op) AND any other
        // reason the session becomes null (revoked/expired token) that
        // does not go through that button - either way, dataSource must
        // never keep pointing at a torn-down adapter instance.
        if (window.TunaDataAdapter) window.TunaDataAdapter.teardown();
        dataSource = window.TunaDataStore;
        // Fresh entry to the auth screen (not a mid-flow status update) -
        // always reset to step 1, never leave a stale "enter code" step
        // showing for whoever signs in next on this device.
        el('auth-form').hidden = false;
        el('auth-code-form').hidden = true;
        el('auth-email').value = '';
        el('auth-code').value = '';
        showAuth();
      }
    });
  })();
})();

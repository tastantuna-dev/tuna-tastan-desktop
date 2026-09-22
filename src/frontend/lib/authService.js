// Thin wrapper over Supabase Auth - the only auth path for the standalone
// shell (S4 retired the ChatGPT/OpenAI auth-window path entirely - see
// assertAppSender()/isAppOrigin() in main.cjs for the current IPC/nav
// trust boundary).
window.TunaAuth = (function () {
  let client = null;
  let listeners = [];

  async function ensureClient() {
    if (!client) client = await window.TunaSupabase.getClient();
    return client;
  }

  // OTP-code enrollment (not magic-link-redirect) - deliberate choice, not
  // an oversight. A magic link's redirect_to would have to land back on
  // app://tuna, which means either (a) registering that custom scheme as an
  // OS-wide URL handler (a real Windows registry change, its own security
  // surface, and still fragile - the link opens in the system's *default*
  // browser, not necessarily back into this Electron app), or (b) a
  // redirect_to Supabase may not even accept for a non-http(s) scheme
  // (project-configurable, unverified without a live project). The 6-digit
  // code Supabase's signInWithOtp also sends in the same email sidesteps
  // all of that: the user types it back into this app, no redirect, no URL
  // scheme, no new OS registration. verifyOtp() below completes it.
  // AUTH_REDIRECT_BLOCKER note (resolved live, 2026-09-22 - see PS-145):
  // this used to assume the project's Auth email template includes the
  // {{ .Token }} placeholder by default. Verified against a real project
  // and that assumption was WRONG: the out-of-the-box "Magic Link"
  // template sends only a ConfirmationURL (redirect_to defaults to
  // http://localhost:3000, which is nothing for a desktop app - hence a
  // blank page if clicked). The template must be edited in the Supabase
  // dashboard (Authentication > Email Templates > Magic Link) to add
  // {{ .Token }} before verifyEmailCode() below has anything to check
  // against - a one-time per-project dashboard config step, not a code
  // fix, and out of scope for this app to automate (no CLI/management-API
  // login available to this agent).
  async function signInWithEmail(email) {
    const c = await ensureClient();
    if (!c) throw new Error('Supabase is not configured yet - see config/local.example.json');
    const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
  }

  async function verifyEmailCode(email, token) {
    const c = await ensureClient();
    if (!c) throw new Error('Supabase is not configured yet - see config/local.example.json');
    const { error } = await c.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
  }

  // Fallback path for a project whose Magic Link email template has not
  // been edited to include {{ .Token }} (the out-of-the-box template
  // sends only a link - see the AUTH_REDIRECT_BLOCKER note above,
  // confirmed live 2026-09-22 against a real project, PS-144). Rather than
  // requiring a dashboard template edit (or worse, custom SMTP, which
  // Supabase gates raw template-source editing behind), this verifies
  // directly against the token already embedded in that link
  // (.../auth/v1/verify?token=...&type=magiclink&...) via verifyOtp's
  // token_hash form (PS-145) - no redirect is ever followed, so the dead
  // http://localhost:3000 redirect_to never matters. Accepts either the
  // full pasted link or just the bare token value.
  async function verifyMagicLinkToken(linkOrToken) {
    const c = await ensureClient();
    if (!c) throw new Error('Supabase is not configured yet - see config/local.example.json');
    let tokenHash = linkOrToken.trim();
    if (tokenHash.includes('token=')) {
      try {
        const u = new URL(tokenHash);
        tokenHash = u.searchParams.get('token') || tokenHash;
      } catch {
        const match = tokenHash.match(/[?&]token=([^&]+)/);
        if (match) tokenHash = decodeURIComponent(match[1]);
      }
    }
    const { error } = await c.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    if (error) throw error;
  }

  async function getSession() {
    const c = await ensureClient();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    return data.session;
  }

  async function signOut() {
    const c = await ensureClient();
    if (!c) return;
    await c.auth.signOut();
  }

  // Fires immediately with the current state, then on every change
  // (sign-in, token refresh, sign-out) - callers use this instead of
  // polling getSession().
  async function onAuthStateChange(callback) {
    const c = await ensureClient();
    if (!c) { callback(null); return () => {}; }
    const { data: { subscription } } = c.auth.onAuthStateChange((_event, session) => callback(session));
    const current = await getSession();
    callback(current);
    return () => subscription.unsubscribe();
  }

  return { signInWithEmail, verifyEmailCode, verifyMagicLinkToken, getSession, signOut, onAuthStateChange, ensureClient };
})();

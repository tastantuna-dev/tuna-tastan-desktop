// Persists window bounds/maximized state across launches. No dependency,
// backed by a small JSON file in userData. Clamps to a currently visible
// display so the window can never restore off-screen (e.g. after an
// external monitor is unplugged).
const fs = require('fs');
const path = require('path');

function load(filePath, defaults) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const state = JSON.parse(raw);
    if (
      typeof state.width === 'number' &&
      typeof state.height === 'number' &&
      typeof state.x === 'number' &&
      typeof state.y === 'number'
    ) {
      return { ...defaults, ...state };
    }
  } catch {
    // no saved state yet, or it's corrupt; fall back to defaults
  }
  return { ...defaults };
}

function clampToVisibleDisplay(state, screen) {
  const displays = screen.getAllDisplays();
  const fitsAnyDisplay = displays.some((d) => {
    const a = d.workArea;
    return (
      state.x >= a.x &&
      state.y >= a.y &&
      state.x + state.width <= a.x + a.width &&
      state.y + state.height <= a.y + a.height
    );
  });
  if (fitsAnyDisplay) return state;
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return { ...state, x: x + 40, y: y + 40, width: state.width, height: state.height };
}

function createWindowStateKeeper({ userDataDir, screen, defaults }) {
  const filePath = path.join(userDataDir, 'window-state.json');
  const state = clampToVisibleDisplay(load(filePath, defaults), screen);

  let saveTimer = null;
  function scheduleSave(win) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const isMaximized = win.isMaximized();
      const bounds = isMaximized ? state : win.getBounds();
      const next = { ...bounds, isMaximized };
      try {
        fs.writeFileSync(filePath, JSON.stringify(next), 'utf8');
      } catch {
        // best-effort persistence only
      }
    }, 400);
  }

  function track(win) {
    win.on('resize', () => scheduleSave(win));
    win.on('move', () => scheduleSave(win));
    win.on('close', () => scheduleSave(win));
  }

  return { state, track };
}

module.exports = { createWindowStateKeeper };

// Main-process-controlled, encrypted storage for the Supabase auth session.
// The renderer never gets raw filesystem or encryption API access - only
// narrow get/set/remove-by-key IPC calls (wired in main.cjs), matching the
// exact {getItem,setItem,removeItem} shape Supabase's JS client expects
// from a custom storage adapter. Keys are restricted to Supabase's own
// session-key pattern as defense in depth against this becoming a general
// key-value store for arbitrary renderer data.
//
// Verified live on this machine (Electron 32.3.3, Windows):
// safeStorage.isEncryptionAvailable() === true, encryptString() returns a
// Buffer, decryptString() round-trips correctly. getSelectedStorageBackend()
// does NOT exist in this Electron version - not used.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

// Supabase's own session storage keys look like "sb-<project-ref>-auth-token".
// Anything else is refused, so this adapter can never be repurposed into a
// general-purpose renderer-writable file.
const KEY_PATTERN = /^sb-[a-z0-9-]+-auth-token$/;

function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function createAuthStorage(userDataDir) {
  const filePath = path.join(userDataDir, 'auth-storage.enc.json');

  function readAll() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeAll(map) {
    fs.writeFileSync(filePath, JSON.stringify(map), 'utf8');
  }

  return {
    getItem(key) {
      if (!isValidKey(key)) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      const all = readAll();
      const stored = all[key];
      if (!stored) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'));
      } catch {
        return null; // corrupt/undecryptable - treat as no session, never throw
      }
    },
    setItem(key, value) {
      if (!isValidKey(key)) return false;
      if (!safeStorage.isEncryptionAvailable()) return false;
      const all = readAll();
      all[key] = safeStorage.encryptString(String(value)).toString('base64');
      writeAll(all);
      return true;
    },
    removeItem(key) {
      if (!isValidKey(key)) return false;
      const all = readAll();
      delete all[key];
      writeAll(all);
      return true;
    },
    clearAll() {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // nothing to clear
      }
    },
  };
}

module.exports = { createAuthStorage, isValidKey };

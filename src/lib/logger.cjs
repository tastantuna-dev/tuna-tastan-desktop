// Minimal file logger, no dependencies. One line per event, daily file, size-capped.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024; // 5MB cap per file

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

class Logger {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.date = todayStamp();
    this.filePath = path.join(this.dir, `tuna-tastan-${this.date}.log`);
  }

  _rotateIfNeeded() {
    const currentDate = todayStamp();
    if (currentDate !== this.date) {
      this.date = currentDate;
      this.filePath = path.join(this.dir, `tuna-tastan-${this.date}.log`);
      return;
    }
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > MAX_BYTES) {
        const rotated = this.filePath.replace(/\.log$/, `.${Date.now()}.log`);
        fs.renameSync(this.filePath, rotated);
      }
    } catch {
      // file doesn't exist yet; nothing to rotate
    }
  }

  _write(level, message) {
    this._rotateIfNeeded();
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    try {
      fs.appendFileSync(this.filePath, line, 'utf8');
    } catch {
      // logging must never crash the app
    }
  }

  info(message) { this._write('INFO', message); }
  warn(message) { this._write('WARN', message); }
  error(message) { this._write('ERROR', message); }
}

module.exports = { Logger };

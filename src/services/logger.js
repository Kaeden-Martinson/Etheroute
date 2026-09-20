const fs = require('fs');
const path = require('path');
const util = require('util');

class LoggerService {
  constructor() {
    this.logDir = path.join(process.cwd(), 'logs');
    this.levelOrder = { debug: 10, info: 20, warn: 30, error: 40 };
    this.level = (process.env.LOG_LEVEL || 'info').toLowerCase();
    this.colors = {
      debug: '\x1b[90m',
      info: '\x1b[36m',
      warn: '\x1b[33m',
      error: '\x1b[31m',
      reset: '\x1b[0m',
    };

    fs.mkdirSync(this.logDir, { recursive: true });
    this._patchConsole();
  }

  _shouldLog(level) {
    const current = this.levelOrder[this.level] ?? this.levelOrder.info;
    const candidate = this.levelOrder[level] ?? this.levelOrder.info;
    return candidate >= current;
  }

  _chicagoTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type !== 'literal') {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});

    return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod}`;
  }

  _dateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type !== 'literal') {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});

    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  _formatValue(value) {
    if (value instanceof Error) {
      return value.stack || value.message;
    }

    if (typeof value === 'string') {
      return value;
    }

    return util.inspect(value, { depth: 6, colors: false, breakLength: 120 });
  }

  _formatMessage(args) {
    return args.map(arg => this._formatValue(arg)).join(' ');
  }

  _writeFile(level, line) {
    const dayKey = this._dateKey();
    const logPath = path.join(this.logDir, `logs-${dayKey}.log`);
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');

    if (level === 'error') {
      const errorPath = path.join(this.logDir, `errors-${dayKey}.log`);
      fs.appendFileSync(errorPath, `${line}\n`, 'utf8');
    }
  }

  _emit(level, args, stream = process.stdout) {
    if (!this._shouldLog(level)) {
      return;
    }

    const timestamp = this._chicagoTimestamp();
    const message = this._formatMessage(args);
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    const color = this.colors[level] || this.colors.info;

    stream.write(`${color}${line}${this.colors.reset}\n`);
    this._writeFile(level, line);
  }

  debug(...args) {
    this._emit('debug', args);
  }

  info(...args) {
    this._emit('info', args);
  }

  warn(...args) {
    this._emit('warn', args);
  }

  error(...args) {
    this._emit('error', args, process.stderr);
  }

  request(...args) {
    this.info(...args);
  }

  action(...args) {
    this.info(...args);
  }

  _patchConsole() {
    // Route console.log through the logger as debug so the verbose operational
    // logging scattered through the services is timestamped, written to the log
    // files, and — crucially — suppressed at the default 'info' level in
    // production. Set LOG_LEVEL=debug to see it again.
    console.log = (...args) => this.debug(...args);
    console.info = (...args) => this.info(...args);
    console.warn = (...args) => this.warn(...args);
    console.error = (...args) => this.error(...args);
  }
}

module.exports = new LoggerService();
// Plain line output and the few questions. No colour, no spinners: every line is safe in a log.
// Every line passes through redaction: a registered secret (token, first-owner secret, encryption key)
// is never printed. The setup link carries a signature derived from the secret, not the secret.
import { createInterface } from 'node:readline';

export function createUi({ stdout, stderr, stdin, interactive, json }) {
  const secrets = new Set();
  const redact = (text) => {
    let t = String(text);
    for (const s of secrets) if (s) t = t.split(s).join('[redacted]');
    return t;
  };
  // With --json the human lines go to stderr, so stdout carries only the final JSON line.
  const human = json ? stderr : stdout;
  const write = (text) => human.write(redact(text) + '\n');

  // One reader for the whole run, so lines typed ahead (or piped in tests) are not lost between questions.
  let rl = null;
  const buffered = [];
  const waiting = [];
  let closed = false;
  function reader() {
    if (rl) return;
    rl = createInterface({ input: stdin, terminal: false });
    rl.on('line', (line) => { const w = waiting.shift(); if (w) w.resolve(line.trim()); else buffered.push(line.trim()); });
    rl.on('close', () => { closed = true; for (const w of waiting.splice(0)) w.reject(new Error('No answer (input closed)')); });
  }

  async function ask(question) {
    if (!interactive) throw new Error('internal: ask() without a terminal');
    reader();
    human.write(question);
    if (buffered.length) return buffered.shift();
    if (closed) throw new Error('No answer (input closed)');
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  }

  return {
    interactive,
    close: () => { if (rl) rl.close(); },
    addSecret: (s) => { if (s) secrets.add(s); },
    redact,
    line: (text = '') => write(text),
    step: (n, total, text) => write(`[${n}/${total}] ${text}`),
    ok: (text) => write(`      ok: ${text}`),
    info: (text) => write(`      ${text}`),
    warn: (text) => write(`      warning: ${text}`),
    json: (obj) => stdout.write(JSON.stringify(obj) + '\n'),
    ask,
    async confirm(question) {
      const a = (await ask(`${question} [y/N] `)).toLowerCase();
      return a === 'y' || a === 'yes';
    },
    async choose(question, items, label) {
      items.forEach((it, i) => write(`  ${i + 1}) ${label(it)}`));
      for (let tries = 0; tries < 3; tries++) {
        const a = await ask(`${question} [1-${items.length}] `);
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
        write(`  Please type a number from 1 to ${items.length}.`);
      }
      throw new Error('No account chosen');
    },
  };
}

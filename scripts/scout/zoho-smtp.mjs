import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import readline from 'node:readline';

const PASSWORD_FILE = '/home/karl/.config/rtt-scout/credentials/zoho-smtp-password';
const DEFAULTS = Object.freeze({
  host: 'smtp.zoho.eu', port: 587, username: 'info@roadtrailandtide.com',
  from: 'scouta17@roadtrailandtide.com', fromName: 'RT&T Scout A17',
  timeoutMs: 12_000,
});

function safeError(stage, error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,24}$/.test(error.code) ? ` (${error.code})` : '';
  const status = Number.isInteger(error?.smtpStatus) ? ` (SMTP ${error.smtpStatus})` : '';
  return new Error(`Zoho SMTP ${stage} failed${status || code}`);
}

function loadPassword() {
  let fd;
  try {
    fd = fs.openSync(PASSWORD_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 1024) {
      throw new Error();
    }
    const secret = fs.readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (!secret || /[\r\n\0]/.test(secret)) throw new Error();
    return secret;
  } catch { throw safeError('credential access', {}); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function connectPlain(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })), timeoutMs);
    const done = (fn, value) => { clearTimeout(timer); socket.removeListener('error', onError); fn(value); };
    const onError = (e) => done(reject, e);
    socket.once('error', onError);
    socket.once('connect', () => done(resolve, socket));
  });
}

function secureSocket(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, host, servername: host, minVersion: 'TLSv1.2', rejectUnauthorized: true });
    const timer = setTimeout(() => secure.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })), timeoutMs);
    const done = (fn, value) => { clearTimeout(timer); secure.removeListener('error', onError); fn(value); };
    const onError = (e) => done(reject, e);
    secure.once('error', onError);
    secure.once('secureConnect', () => done(resolve, secure));
  });
}

function responseReader(socket) {
  const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    close: () => lines.close(),
    async reply() {
      let status = null;
      for (let count = 0; count < 50; count++) {
        const result = await iterator.next();
        if (result.done) throw Object.assign(new Error(), { code: 'ECONNRESET' });
        const match = /^(\d{3})([ -])/.exec(result.value);
        if (!match) throw Object.assign(new Error(), { code: 'EPROTO' });
        const current = Number(match[1]);
        if (status !== null && current !== status) throw Object.assign(new Error(), { code: 'EPROTO' });
        status = current;
        if (match[2] === ' ') return status;
      }
      throw Object.assign(new Error(), { code: 'EPROTO' });
    },
  };
}

async function command(socket, reader, text, expected, stage) {
  socket.write(`${text}\r\n`);
  const status = await reader.reply();
  if (!expected.includes(status)) throw Object.assign(new Error(), { smtpStatus: status, stage });
  return status;
}

async function smtpSession({ host, port, timeoutMs, username, password, from, fromName, recipient, subject, body, deliver }) {
  let socket;
  let reader;
  let stage = 'connection';
  try {
    socket = await connectPlain(host, port, timeoutMs);
    socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
    reader = responseReader(socket);
    const greeting = await reader.reply();
    if (greeting !== 220) throw Object.assign(new Error(), { smtpStatus: greeting });
    stage = 'EHLO';
    await command(socket, reader, `EHLO scout-a17.local`, [250], stage);
    stage = 'STARTTLS';
    await command(socket, reader, 'STARTTLS', [220], stage);
    reader.close();
    socket = await secureSocket(socket, host, timeoutMs);
    socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
    reader = responseReader(socket);
    stage = 'TLS EHLO';
    await command(socket, reader, 'EHLO scout-a17.local', [250], stage);
    stage = 'authentication';
    const auth = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
    await command(socket, reader, `AUTH PLAIN ${auth}`, [235], stage);
    if (deliver) {
      stage = 'MAIL FROM';
      await command(socket, reader, `MAIL FROM:<${from}>`, [250], stage);
      stage = 'recipient';
      await command(socket, reader, `RCPT TO:<${recipient}>`, [250, 251], stage);
      stage = 'message';
      await command(socket, reader, 'DATA', [354], stage);
      const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
      const headers = [`From: "${fromName}" <${from}>`, `To: <${recipient}>`, `Subject: ${encodedSubject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit'];
      const message = `${headers.join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.\r\n`;
      socket.write(message);
      const status = await reader.reply();
      if (status !== 250) throw Object.assign(new Error(), { smtpStatus: status });
    }
    stage = 'QUIT';
    await command(socket, reader, 'QUIT', [221], stage);
  } catch (error) {
    throw safeError(error?.stage ?? stage, error);
  } finally {
    reader?.close();
    socket?.destroy();
  }
}

/** Creates an EMAIL provider with a credential source pinned to the A17 Zoho file. */
export function createZohoSmtpProvider({ recipient, subject, host = DEFAULTS.host, port = DEFAULTS.port,
  username = DEFAULTS.username, from = DEFAULTS.from, fromName = DEFAULTS.fromName, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  if (!recipient || /[\r\n<>]/.test(recipient) || !subject || /[\r\n]/.test(subject)) throw new Error('Zoho SMTP recipient and subject are required');
  const password = loadPassword();
  const config = { host, port, username, from, fromName, recipient, subject, timeoutMs, password };
  return Object.freeze({
    async verifyConnection() { await smtpSession({ ...config, deliver: false }); return { verified: true }; },
    async send(event) {
      await smtpSession({ ...config, subject: event.subject ?? subject, body: event.message, deliver: true });
    },
  });
}

export const zohoSmtpDefaults = Object.freeze({ ...DEFAULTS, credentialFile: PASSWORD_FILE });

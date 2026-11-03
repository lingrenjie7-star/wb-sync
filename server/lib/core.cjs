const __imp0 = require('node:crypto');
const __imp1 = require('node:zlib');
const __imp2 = require('node:child_process');
const __imp3 = require('node:fs');
const __imp4 = require('node:os');
const __imp5 = require('node:path');
const { createHash } = __imp0;
const { constants: zlibConstants, zstdCompressSync, zstdDecompressSync } = __imp1;
const { spawn } = __imp2;
const fs = __imp3;
const os = __imp4;
const path = __imp5;
/**
 * 核心工具：哈希、原子写、路径映射、zstd 会话编解码、git 调用。
 *
 * 这一层不认识任何具体软件——DSH、WorkBuddy、Codex 都在 sources/ 里，
 * 各自决定自己怎么列条目、怎么采集、怎么落地。
 */








const ENGINE_VERSION = '3.0.0';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFileAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buffer);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

const writeJsonAtomic = (file, value) =>
  writeFileAtomic(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));

function walkFiles(root, skip = () => false) {
  const out = [];
  if (!isDir(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (skip(rel, entry)) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push({ abs: full, rel, size: safeSize(full) });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const expandHome = (value) => {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
};

function globMatch(value, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i').test(value);
}

function orderedUnion(first, second) {
  const out = [...first];
  const seen = new Set(first);
  for (const item of second) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function isSamePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const norm = normalizeForCompare;
  return norm(left) === norm(right);
}

function isUnder(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false;
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c.length <= p.length) return false;
  return c.startsWith(p + '/');
}

function normalizeForCompare(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function joinPath(base, rest) {
  const segments = String(rest)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  return segments.length === 0 ? base : path.join(base, ...segments);
}

/**
 * 一段字符串看起来像不像随机生成的密钥（而不是 URL、路径、模型名）。
 */
function looksRandomSecret(value) {
  if (value.length < 20) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /\d/.test(value);
  const hasSpecial = /[_\-./+=]/.test(value);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  return classes >= 3 && hasDigit;
}

/**
 * 粗筛：像不像含密钥。宁可多拦几个，也不让凭据进仓库。
 * 只认「真 key 名 + 真随机串」，避免误伤 baseUrl、模型名这类配置。
 */
function looksSecret(text) {
  if (typeof text !== 'string') return false;
  const patterns = [
    /"(?:refresh[_-]?token|access[_-]?token|api[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|password)"\s*:\s*"([^"]{20,})"/gi,
    /(?:refresh[_-]?token|access[_-]?token|api[_-]?key|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+]{20,})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (looksRandomSecret(match[1] ?? '')) return true;
    }
  }
  return false;
}

// ───────────────────────────────────────────── 路径映射

/**
 * 本机绝对路径 ⇄ "@逻辑根/子路径"。
 *
 * 这是整个工具能跨机器的根本原因：DSH 和 WorkBuddy 都把工作目录路径
 * 编进了存储布局，路径不同就成了「文件在、列表空」。
 */
class PathMapper {
  constructor(config) {
    this.config = config;
    this.machine = config.machine;
    this.roots = (config.roots ?? [])
      .map((root) => {
        const value = expandHome(root?.paths?.[this.machine]);
        return typeof value === 'string' && value.length > 0 ? { id: root.id, prefix: path.resolve(value) } : undefined;
      })
      .filter(Boolean)
      .sort((a, b) => b.prefix.length - a.prefix.length);
    this.unmapped = new Set();
  }

  toLogical(absPath) {
    if (typeof absPath !== 'string' || absPath.length === 0) return absPath;
    for (const rule of this.config.extraRewrites ?? []) {
      if (!rule || typeof rule.from !== 'string') continue;
      if (isSamePath(absPath, rule.from) || isUnder(absPath, rule.from)) {
        const rest = absPath
          .replace(/\\/g, '/')
          .slice(rule.from.replace(/\\/g, '/').replace(/\/+$/, '').length)
          .replace(/^\/+/, '');
        return rest ? `@${rule.id}/${rest}` : `@${rule.id}`;
      }
    }
    for (const root of this.roots) {
      if (isSamePath(absPath, root.prefix) || isUnder(absPath, root.prefix)) {
        const rest = absPath
          .replace(/\\/g, '/')
          .replace(/\/+$/, '')
          .slice(root.prefix.replace(/\\/g, '/').replace(/\/+$/, '').length)
          .replace(/^\/+/, '');
        return rest ? `@${root.id}/${rest}` : `@${root.id}`;
      }
    }
    this.unmapped.add(absPath);
    return absPath;
  }

  toLocal(logicalPath) {
    if (typeof logicalPath !== 'string' || !logicalPath.startsWith('@')) return logicalPath;
    const slash = logicalPath.indexOf('/');
    const id = slash === -1 ? logicalPath.slice(1) : logicalPath.slice(1, slash);
    const rest = slash === -1 ? '' : logicalPath.slice(slash + 1);
    const extra = (this.config.extraRewrites ?? []).find((rule) => rule && rule.id === id);
    if (extra && typeof extra.to === 'string') return joinPath(extra.to, rest);
    const root = (this.config.roots ?? []).find((item) => item && item.id === id);
    const target = expandHome(root?.paths?.[this.machine]);
    if (typeof target !== 'string' || target.length === 0) return logicalPath;
    return joinPath(target, rest);
  }

  localRoot(id) {
    const root = (this.config.roots ?? []).find((item) => item && item.id === id);
    const value = expandHome(root?.paths?.[this.machine]);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** 没有对应本机路径的逻辑根前缀（例如别的机器的专有目录）。 */
  rootIdOf(logicalPath) {
    if (typeof logicalPath !== 'string' || !logicalPath.startsWith('@')) return undefined;
    const slash = logicalPath.indexOf('/');
    return slash === -1 ? logicalPath.slice(1) : logicalPath.slice(1, slash);
  }
}

// ───────────────────────────────────────────── DSH 会话格式

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_CHECKSUM = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } };

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cwd 不能是空字符串');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('空的路径段');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 按 zstd 帧头结构精确切帧（不靠搜索魔数，避免载荷里恰好出现同样字节）。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`第 ${offset} 字节处不是 zstd 帧头`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remaining) return { frames, tornStart: start };
    offset += remaining;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const header = buffer.readUIntLE(offset, 3);
      offset += 3;
      const last = (header & 1) !== 0;
      const type = (header >>> 1) & 3;
      const size = header >>> 3;
      if (type === 3) throw new Error(`第 ${offset - 3} 字节处块类型非法`);
      const payload = type === 1 ? 1 : size;
      if (buffer.length - offset < payload) return { frames, tornStart: start };
      offset += payload;
      if (last) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function decodeSession(buffer, compression) {
  let text;
  if (compression === 'zstd') {
    const { frames, tornStart } = scanZstdFrames(buffer);
    if (frames.length === 0) throw new Error('空会话日志');
    const parts = frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    if (tornStart !== undefined) {
      try {
        parts.push(zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: zlibConstants.ZSTD_e_flush }));
      } catch {}
    }
    text = Buffer.concat(parts).toString('utf8');
  } else {
    text = buffer.toString('utf8');
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('空会话日志');
  const header = JSON.parse(lines[0]);
  const events = [];
  for (const line of lines.slice(1)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') events.push(value);
    } catch {}
  }
  return { header, events };
}

function encodeSession(header, events, compression) {
  const headerLine = JSON.stringify(header) + '\n';
  if (compression !== 'zstd') {
    const body = events.map((event) => JSON.stringify(event)).join('\n');
    return Buffer.from(headerLine + (events.length > 0 ? body + '\n' : ''), 'utf8');
  }
  const frames = [zstdCompressSync(Buffer.from(headerLine, 'utf8'), ZSTD_CHECKSUM)];
  for (let i = 0; i < events.length; i += 200) {
    const chunk =
      events
        .slice(i, i + 200)
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n';
    frames.push(zstdCompressSync(Buffer.from(chunk, 'utf8'), ZSTD_CHECKSUM));
  }
  return Buffer.concat(frames);
}

/** 按 seq 取并集：append-only 日志的正确合并方式。 */
function mergeBySeq(localEvents, remoteEvents) {
  const bySeq = new Map();
  for (const event of localEvents) {
    if (typeof event?.seq !== 'number') continue;
    bySeq.set(event.seq, JSON.stringify(event));
  }
  const forked = [];
  let added = 0;
  for (const event of remoteEvents) {
    if (typeof event?.seq !== 'number') continue;
    const text = JSON.stringify(event);
    const existing = bySeq.get(event.seq);
    if (existing === undefined) {
      bySeq.set(event.seq, text);
      added++;
      continue;
    }
    if (existing !== text) forked.push(event);
  }
  const events = [...bySeq.keys()].sort((a, b) => a - b).map((seq) => JSON.parse(bySeq.get(seq)));
  return { events, added, forked };
}

function pickSessionGeneration(sessionDir) {
  let files;
  try {
    files = fs.readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  return files
    .map((name) => {
      const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name);
      if (!match) return undefined;
      return { name, version: Number(match[1]), compression: match[2] ? 'zstd' : 'none' };
    })
    .filter(Boolean)
    .sort((a, b) => b.version - a.version)[0];
}

/** 列出 DSH 目录下的所有对话（每个对话取最高版本的日志文件）。 */
function listDshSessions(dshHome) {
  const root = path.join(dshHome, 'sessions');
  const out = [];
  if (!isDir(root)) return out;
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const projectEntry of projects) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(root, projectEntry.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(projectDir, sessionEntry.name);
      const chosen = pickSessionGeneration(sessionDir);
      if (!chosen) continue;
      out.push({ abs: path.join(sessionDir, chosen.name), ...chosen, projectDirName: projectEntry.name });
    }
  }
  return out;
}

/** 会话标题：优先取标题事件，其次用户第一句话。 */
function sessionTitle(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title;
  }
  for (const event of events) {
    if (event?.type === 'user/message') {
      const text = extractMessageText(event.data);
      if (text) return text.replace(/\s+/g, ' ').trim().slice(0, 40);
    }
  }
  return undefined;
}

/** 给列表一个像样的标题：没有标题就退回创建时间，总比一串裸 id 强。 */
function displayTitle(events, header, fallback) {
  const title = sessionTitle(events);
  if (title) return title;
  const created = header?.createdAt;
  if (typeof created === 'number' && created > 0) {
    const date = new Date(created);
    const stamp = `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `（无标题对话 · ${stamp}）`;
  }
  return fallback ? `（无标题对话 · ${String(fallback).slice(0, 8)}）` : '（无标题对话）';
}

function extractMessageText(data) {
  if (!data) return undefined;
  if (typeof data.text === 'string') return data.text;
  const content = data.content ?? data.message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === 'string') return part.text;
    }
  }
  return undefined;
}

/** WorkBuddy 的 projects 目录名：分隔符折叠成 '-'，首字母小写（已实机校验）。 */
function workbuddySlug(value) {
  const text = String(value).replace(/^@/, '');
  let out = '';
  let separatorRun = false;
  for (const ch of text) {
    if (ch === '\\' || ch === '/' || ch === ':') {
      if (!separatorRun) out += '-';
      separatorRun = true;
    } else {
      out += ch;
      separatorRun = false;
    }
  }
  out = out.replace(/^-+/, '');
  return out.length > 0 ? out[0].toLowerCase() + out.slice(1) : 'root';
}

// ───────────────────────────────────────────── 文本与格式

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function cleanGitError(stderr) {
  return String(stderr ?? '')
    .replace(/x-access-token:[^@]*@/g, '***@')
    .replace(/https:\/\/[^@\s]*@github\.com/g, 'https://github.com')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('warning:'))
    .slice(0, 8)
    .join('\n')
    .trim();
}

/** 逐行改写 jsonl 里的 cwd 字段，其余字节尽量不动。 */
function rewriteJsonCwd(text, transform) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('"cwd"')) return line;
      try {
        const value = JSON.parse(line);
        if (value && typeof value.cwd === 'string') {
          value.cwd = transform(value.cwd);
          return JSON.stringify(value);
        }
      } catch {}
      return line;
    })
    .join('\n');
}

/**
 * 通用文本的路径令牌化：把本机绝对路径换成一个稳定占位符。
 * 给「不认识的软件」用——不需要懂它的格式，只要它把路径写在文本里。
 */
function tokenizePaths(text, mapper, tokens) {
  let out = text;
  for (const [token, absPath] of tokens) {
    if (!absPath || absPath.length < 5) continue;
    const variants = new Set([
      absPath.replace(/\\/g, '/'),
      absPath.replace(/\//g, '\\'),
      absPath,
      JSON.stringify(absPath).slice(1, -1),
    ]);
    for (const variant of variants) {
      if (variant.length < 5) continue;
      out = out.split(variant).join(token);
    }
  }
  return out;
}

function detokenizePaths(text, tokens) {
  let out = text;
  for (const [token, absPath] of tokens) {
    if (!absPath) continue;
    const form = absPath.replace(/\//g, '\\');
    const jsonForm = JSON.stringify(form).slice(1, -1);
    out = out.split(token).join(jsonForm);
  }
  return out;
}

// ───────────────────────────────────────────── git

function gitArgs(proxy) {
  const args = [];
  if (proxy) args.push('-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`);
  else args.push('-c', 'http.proxy=', '-c', 'https.proxy=');
  args.push('-c', 'credential.helper=');
  return args;
}

function runGit(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', [...gitArgs(options.proxy), ...args], {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', ALL_PROXY: '', all_proxy: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, code: -1, stdout: '', buffer: Buffer.alloc(0), stderr: stderr + '\n(超时)' });
    }, options.timeoutMs ?? 180000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      resolve({
        ok: code === 0,
        code,
        // stdout 给文本用，buffer 给二进制用（`git show` 读文件内容必须走这个，
        // 否则中文、反斜杠会被 UTF-8 解码破坏）
        stdout: buffer.toString('utf8'),
        buffer,
        stderr,
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: '', buffer: Buffer.alloc(0), stderr: stderr + '\n' + error.message });
    });
  });
}

function remoteUrl(repo, token) {
  if (!repo?.owner || !repo?.name) return '';
  if (token) return `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`;
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

const homeDir = os.homedir();

for (const __name of ["readJson","writeFileAtomic","walkFiles","globMatch","orderedUnion","isSamePath","isUnder","normalizeForCompare","joinPath","looksSecret","projectKey","encodeSegment","decodeSegment","scanZstdFrames","decodeSession","encodeSession","mergeBySeq","pickSessionGeneration","listDshSessions","sessionTitle","displayTitle","workbuddySlug","formatBytes","cleanGitError","rewriteJsonCwd","tokenizePaths","detokenizePaths","runGit","remoteUrl","ENGINE_VERSION","sha256","nowStamp","exists","isDir","writeJsonAtomic","expandHome","PathMapper","homeDir"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}

const __imp0 = require('node:fs');
const __imp1 = require('node:os');
const __imp2 = require('node:path');
const __imp3 = require('./core.cjs');
const __imp4 = require('./engine.cjs');
const fs = __imp0;
const os = __imp1;
const path = __imp2;
const { decodeSession } = __imp3;
const { defaultConfig, normalizeConfig, normalizeRepo } = __imp4;
/**
 * 配置、令牌与工作区根目录的自动探测。
 */







const HOME = path.join(os.homedir(), '.dshwb-sync');
const LIMITS_VERSION = 4;

const paths = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  credentials: path.join(HOME, 'credentials.json'),
  state: path.join(HOME, 'state'),
  backups: path.join(HOME, 'backups'),
  repos: path.join(HOME, 'repos'),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readConfigRaw() {
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    return undefined;
  }
}

function loadConfig() {
  const raw = readConfigRaw();
  if (!raw) return undefined;
  const config = normalizeConfig(raw);
  if ((raw.limitsVersion ?? 1) < LIMITS_VERSION) {
    config.limits = { ...defaultConfig().limits };
  }
  config.repos = migrateRepos(raw, config);
  return config;
}

/** 老版本 repo.sources[] 迁移成一对一的 repo.source。 */
function migrateRepos(raw, config) {
  const repos = (config.repos ?? []).map((repo) =>
    normalizeRepo({ ...repo, cacheDir: repo.cacheDir || path.join(paths.repos, repo.id) }),
  );

  if (repos.length > 0) return repos;

  // 只有当配置里还没有新结构、且明确带着旧字段时才迁移一次。
  // 迁移过的配置会被标记，否则用户把仓库全删掉之后，
  // 这段逻辑会又把那个早已不存在的默认仓库重建出来。
  if (raw.reposMigrated) return [];

  if (raw.repo?.owner && raw.repo?.name) {
    return [
      normalizeRepo({
        id: 'default',
        name: '默认仓库',
        owner: raw.repo.owner,
        repoName: raw.repo.name,
        branch: raw.repo.branch ?? 'main',
        private: true,
        source: 'dsh',
        cacheDir: raw.repo.cacheDir || path.join(paths.repos, 'default'),
      }),
    ];
  }
  return [];
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  normalized.repos = normalized.repos.map((repo) => ({
    ...repo,
    cacheDir: repo.cacheDir || path.join(paths.repos, repo.id),
  }));
  normalized.limitsVersion = LIMITS_VERSION;
  normalized.reposMigrated = true;
  ensureDir(HOME);
  const tmp = paths.config + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, paths.config);
  return normalized;
}

// ───────────────────────────────────────────── 令牌

function saveToken(token, crypto) {
  ensureDir(HOME);
  const payload = { updatedAt: new Date().toISOString() };
  if (crypto?.encrypt) {
    payload.encrypted = crypto.encrypt(token);
    payload.mode = 'safeStorage';
  } else {
    payload.plain = token;
    payload.mode = 'plain';
  }
  fs.writeFileSync(paths.credentials, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function loadToken(crypto) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(paths.credentials, 'utf8'));
  } catch {
    return undefined;
  }
  if (raw.encrypted) {
    if (!crypto?.decrypt) return undefined;
    try {
      return crypto.decrypt(raw.encrypted);
    } catch {
      throw new Error('保存的令牌无法解密（可能换了 Windows 用户或系统密钥变了），请重新连接 GitHub');
    }
  }
  return raw.plain;
}

function clearToken() {
  try {
    fs.rmSync(paths.credentials, { force: true });
  } catch {}
}

function tokenMode() {
  try {
    return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')).mode;
  } catch {
    return undefined;
  }
}

// ───────────────────────────────────────────── 首次配置

/**
 * 首次启动：探测本机软件目录，并推算「工作区根目录」。
 *
 * 用户只需要确认一个总目录，而不是逐个工作区去配。
 * 这里用所有项目的共同父目录作为默认值，用户可在界面上改。
 */
function bootstrapConfig(machineName) {
  const config = normalizeConfig(defaultConfig());
  config.machine = (machineName ?? config.machine).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');

  const dshPaths = discoverDshProjects(config.softwareHome.dsh);
  const wbPaths = discoverWorkbuddyProjects(config.softwareHome.workbuddy);

  config.workspaceRoot.dsh = commonParent(dshPaths);
  config.workspaceRoot.workbuddy = commonParent(wbPaths);

  return config;
}

/** 一组路径的公共父目录；只有一个时取它的父目录。 */
function commonParent(list) {
  const paths = list.filter((p) => typeof p === 'string' && p.length > 0);
  if (paths.length === 0) return '';
  if (paths.length === 1) return path.dirname(paths[0]);

  const split = paths.map((p) => p.replace(/\\/g, '/').split('/'));
  const first = split[0];
  let shared = 0;
  for (let i = 0; i < first.length; i++) {
    const part = first[i];
    if (split.every((segments) => segments[i] === part)) shared = i + 1;
    else break;
  }
  // 至少保留盘符或根
  if (shared <= 1) return '';
  const joined = first.slice(0, shared).join('/');
  return process.platform === 'win32' ? joined.replace(/\//g, '\\') : joined;
}

function discoverDshProjects(dshHome) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  const seen = new Set();
  try {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(sessionsRoot, entry.name);
      const first = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.isDirectory());
      if (!first) continue;
      const files = fs.readdirSync(path.join(dir, first.name));
      const log = files.find((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name));
      if (!log) continue;
      const header = readHeader(fs.readFileSync(path.join(dir, first.name, log)));
      if (header?.cwd) seen.add(header.cwd);
    }
  } catch {
    return [];
  }
  return [...seen];
}

function discoverWorkbuddyProjects(workbuddyHome) {
  const projectsRoot = path.join(workbuddyHome, 'projects');
  const seen = new Set();
  try {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectsRoot, entry.name);
      let files;
      try {
        files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of files) {
        let lines;
        try {
          lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n').slice(0, 4);
        } catch {
          continue;
        }
        let found;
        for (const line of lines) {
          if (!line.includes('"cwd"')) continue;
          try {
            const value = JSON.parse(line);
            if (typeof value.cwd === 'string' && value.cwd.length > 0) {
              found = value.cwd;
              break;
            }
          } catch {}
        }
        if (found) {
          seen.add(found);
          break;
        }
      }
    }
  } catch {
    return [];
  }
  // 临时目录属于一次性现场，不参与公共父目录计算
  const tempRoot = os.tmpdir().replace(/\\/g, '/').toLowerCase();
  return [...seen].filter((p) => !p.replace(/\\/g, '/').toLowerCase().startsWith(tempRoot));
}

function readHeader(buffer) {
  try {
    if (buffer.length > 4 && buffer.readUInt32LE(0) === 0xfd2fb528) {
      return decodeSession(buffer, 'zstd').header;
    }
    return JSON.parse(buffer.toString('utf8').split('\n')[0]);
  } catch {
    return undefined;
  }
}

for (const __name of ["readConfigRaw","loadConfig","saveConfig","saveToken","loadToken","clearToken","tokenMode","bootstrapConfig","paths"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}

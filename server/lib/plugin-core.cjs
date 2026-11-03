const __imp0 = require('node:fs');
const __imp1 = require('node:os');
const __imp2 = require('node:path');
const __imp3 = require('./engine.cjs');
const __imp4 = require('./discover.cjs');
const __imp5 = require('./identity.cjs');
const __imp6 = require('./sources/index.cjs');
const __imp7 = require('./browser.cjs');
const __imp8 = require('./github.cjs');
const fs = __imp0;
const os = __imp1;
const path = __imp2;
const { Engine, ENGINE_VERSION, defaultConfig, normalizeConfig, normalizeRepo } = __imp3;
const { claimRepo, discoverRemoteRepos, backfillMarkers } = __imp4;
const { MARKER_FILE } = __imp5;
const { describeSources, SOURCE_PRESETS } = __imp6;
const { browseRemote, compareFile, deleteRemoteFiles, pushLocal, takeRemote, writeRemoteFile } = __imp7;
const { createRepoWithMarker, deleteRepo, GITIGNORE_TEMPLATES, getRepo, LICENSE_KEYS, listRepos, probeTransport, updateRepo, verifyToken } = __imp8;
/**
 * 插件的宿主側核心：把「跨电脑同步」引擎包装成一组可被插件调用的方法。
 *
 * 为什么要有这一层：
 *   原客户端的 app/lib/* 是给 Electron 主进程写的，里面直接用了 safeStorage。
 *   DSH 插件、WorkBuddy 扩展都没有这个能力，但同步逻辑本身完全一样。
 *   所以这里把「能力差异」抽成注入点（crypto / paths / progress），
 *   业务代码一份，两个平台共用。
 *
 * 设计约束：
 *   · 不 import electron —— 这个目录会被打进两个平台的包里，任何一个平台
 *     在模块加载期碰到 electron 都会直接崩；
 *   · 不在这里做 UI —— 插件前端只调这里暴露的方法；
 *   · 所有方法都返回 { ok, ... }，不 throw 给调用方（跨进程边界 throw 很难看）。
 */












const PLUGIN_API_VERSION = '1.0.0';

/** 默认状态目录：和桌面客户端共用同一份配置，换到插件里不用重新登录。 */
function defaultHome() {
  return path.join(os.homedir(), '.dshwb-sync');
}

/** 目录占用（跳过 .git，和桌面端 dirSize 口径一致）。 */
function dirSize(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  }
  return total;
}

/** 把 `~/x` 展开成绝对路径；其余原样返回。 */
function expandHome(value) {  const text = String(value ?? '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

/**
 * 极简 JSON 文件读写（不依赖 storage.mjs，因为那边绑死了 safeStorage）。
 */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 创建插件侧的同步核心。
 *
 * @param {object} options
 * @param {string} [options.home]      配置目录（默认 ~/.dshwb-sync，与桌面客户端共享）
 * @param {object} [options.crypto]    可选加解密后端 { encrypt(s), decrypt(s), mode }
 *                                     有 safeStorage 就传，没有就不传（退回明文 + 警告）
 * @param {Function} [options.onProgress] 进度回调
 * @param {string} [options.platform]  平台名，写进诊断信息
 */
function createSyncCore(options = {}) {
  const home = options.home ?? defaultHome();
  const crypto = options.crypto;
  const onProgress = options.onProgress ?? (() => {});
  const platform = options.platform ?? 'plugin';

  const paths = {
    home,
    config: path.join(home, 'config.json'),
    credentials: path.join(home, 'credentials.json'),
    repos: path.join(home, 'repos'),
  };

  let cachedConfig;
  /** 上次读到/写入配置文件的时间戳，用来判断文件有没有被别的进程改过。 */
  let cachedMtime = 0;

  // ── 配置

  function configMtime() {
    try {
      return fs.statSync(paths.config).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 读配置。
   *
   * 关键：**不能无条件用内存缓存**。
   * 桌面客户端和插件共用同一个 config.json；用户在桌面端删了/加了仓库，
   * 插件如果一直用自己那份缓存，就会永远显示旧数据（实测：桌面端删掉仓库后，
   * 插件仍显示 0 个，因为插件启动时就缓存了当时的空配置）。
   *
   * 所以每次都用 mtime 比一下：文件变了就重读。
   */
  function loadConfig() {
    const mtime = configMtime();
    if (cachedConfig && mtime === cachedMtime) return cachedConfig;

    const raw = readJson(paths.config, undefined);
    if (!raw) {
      cachedConfig = undefined;
      cachedMtime = mtime;
      return undefined;
    }
    cachedConfig = normalizeConfig(raw);
    cachedConfig.repos = (cachedConfig.repos ?? []).map((repo) =>
      normalizeRepo({ ...repo, cacheDir: repo.cacheDir || path.join(paths.repos, repo.id) }),
    );
    cachedMtime = mtime;
    return cachedConfig;
  }

  function saveConfig(config) {
    const normalized = normalizeConfig(config);
    normalized.repos = (normalized.repos ?? []).map((repo) => ({
      ...repo,
      cacheDir: repo.cacheDir || path.join(paths.repos, repo.id),
    }));
    writeJson(paths.config, normalized);
    cachedConfig = normalized;
    // 写完之后记住新的 mtime，避免下一次读又重读一遍
    cachedMtime = configMtime();
    return normalized;
  }

  /** 首次启动：建一份默认配置（探测本机软件目录）。 */
  function ensureConfig() {
    const existing = loadConfig();
    if (existing) return existing;
    const config = normalizeConfig(defaultConfig());
    return saveConfig(config);
  }

  // ── 令牌

  /**
   * 读令牌。
   *
   * 关键：桌面客户端用 Electron 的 safeStorage 加密保存整块密文，
   * 插件进程（普通 Node）没有那个密钥，**解不开**。
   * 早先这里返回 undefined，但调用方照样发出「没带头」的请求，
   * GitHub 于是回 403 —— 用户看到的是「创建失败（GitHub 返回 403）」，
   * 完全猜不到其实根本没登录。现在把「为什么读不到」显式记下来，
   * 由上层给出能看懂的提示。
   */
  let lastTokenProblem = '';

  function readToken() {
    const raw = readJson(paths.credentials, undefined);
    if (!raw) {
      lastTokenProblem = '';
      return undefined;
    }
    if (raw.encrypted) {
      if (!crypto?.decrypt) {
        lastTokenProblem =
          '令牌是用桌面客户端的系统加密保存的，插件进程解不开。' +
          '请在插件的「账号」页重新连接一次（会以插件能读的方式另存）。';
        return undefined;
      }
      try {
        lastTokenProblem = '';
        return crypto.decrypt(raw.encrypted);
      } catch (error) {
        lastTokenProblem = `保存的令牌无法解密：${error.message}。请重新连接 GitHub。`;
        return undefined;
      }
    }
    lastTokenProblem = '';
    return raw.plain;
  }

  function writeToken(token) {
    const payload = { updatedAt: new Date().toISOString() };
    if (crypto?.encrypt) {
      payload.encrypted = crypto.encrypt(token);
      payload.mode = crypto.mode ?? 'encrypted';
    } else {
      payload.plain = token;
      // 没有系统加密时明确标记，界面要据此警告用户
      payload.mode = 'plain';
    }
    writeJson(paths.credentials, payload);
  }

  /**
   * 令牌存储状态。
   *
   * `readable` 是这次新加的关键字段：文件存在 ≠ 插件读得到。
   * 界面必须据此区分「没登录」和「登录了但格式读不了」。
   */
  function tokenStatus() {
    const raw = readJson(paths.credentials, undefined);
    if (!raw) return { present: false, mode: '', readable: false, problem: '' };
    const mode = raw.mode ?? (raw.encrypted ? 'safeStorage' : 'plain');
    const token = readToken();
    return {
      present: true,
      mode,
      readable: typeof token === 'string' && token.length > 0,
      problem: lastTokenProblem,
    };
  }

  function tokenMode() {
    return readJson(paths.credentials, {})?.mode;
  }

  function clearToken() {
    try {
      fs.rmSync(paths.credentials, { force: true });
    } catch {}
  }

  // ── 引擎

  function buildEngine(config) {
    return new Engine({
      config,
      token: readToken(),
      stateDir: paths.home,
      onProgress: (event) => {
        try {
          onProgress(event);
        } catch {}
      },
    });
  }

  /**
   * 引擎在遇到网络问题时会把可用的代理写回 config.proxy；
   * 这里把它落盘，下次就不用再探一遍。
   */
  function persistProxyFrom(engine) {
    const config = loadConfig();
    if (config && engine?.config && engine.config.proxy !== config.proxy) {
      config.proxy = engine.config.proxy;
      saveConfig(config);
    }
  }

  function newRepoId() {
    return `repo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ───────────────────────────────── 对外 API

  /**
   * 统一的前置检查：需要令牌的操作先过这一关。
   *
   * 早先每个方法各写一句「还没有登录 GitHub」，但真正的问题是
   * 「令牌存在却读不了」时也走到发请求那一步，最后拿到一个 403 ——
   * 用户完全看不出是登录的问题。这里把原因一次说清。
   */
  function requireToken() {
    const token = readToken();
    if (typeof token === 'string' && token.length > 0) return { ok: true, token };
    return {
      ok: false,
      error: lastTokenProblem || '还没有登录 GitHub（到「账号」页连接）',
      needLogin: true,
      tokenProblem: lastTokenProblem,
    };
  }

  return {
    paths,
    platform,
    engineVersion: ENGINE_VERSION,

    /** 插件启动时的一次性快照。 */
    bootstrap() {
      const config = ensureConfig();
      const status = tokenStatus();
      return {
        ok: true,
        hasConfig: Boolean(config),
        config,
        hasToken: status.readable,
        /** 令牌文件在不在（不代表读得到） */
        tokenPresent: status.present,
        /** 令牌真实存储方式：safeStorage（桌面客户端写的）/ plain（插件写的） */
        tokenMode: status.mode,
        /** 令牌读不出来时的具体原因，界面要原样显示 */
        tokenProblem: status.problem,
        /** 没有系统加密后端时，界面必须提示「令牌是明文保存的」 */
        encryptionAvailable: Boolean(crypto?.encrypt),
        paths,
        platform,
        hostname: os.hostname(),
        engineVersion: ENGINE_VERSION,
        markerFile: MARKER_FILE,
        presets: SOURCE_PRESETS,
        gitignoreTemplates: GITIGNORE_TEMPLATES,
        licenseKeys: LICENSE_KEYS,
      };
    },

    /** 软件清单 + 本机容器（工作区/项目 → 对话）。 */
    async inspectSources() {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      try {
        const sources = await buildEngine(config).inspect();
        return { ok: true, sources, config };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 本机已登记的仓库。 */
    async listRepos() {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const token = readToken();
      const out = [];
      for (const repo of config.repos ?? []) {
        let remote;
        if (token && repo.owner && repo.repoName) {
          try {
            remote = await getRepo(token, repo.owner, repo.repoName);
          } catch (error) {
            remote = { exists: false, error: error.message };
          }
        }
        out.push({
          ...repo,
          remote,
          cloned: fs.existsSync(path.join(repo.cacheDir, '.git')),
          // 本地占用：桌面端卡片上有「本地 12.0 MB」，插件也要有
          sizeOnDisk: dirSize(repo.cacheDir),
        });
      }
      return { ok: true, repos: out, sources: describeSources(config) };
    },

    /** 扫描账号下的仓库，按证据归类（不猜名字），并自动接入已有标识的。 */
    async discover() {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const auth = requireToken();
      if (!auth.ok) return auth;
      const token = auth.token;
      try {
        const found = await discoverRemoteRepos({
          token,
          sources: describeSources(config),
          registered: config.repos ?? [],
        });
        if (!found.ok) return found;

        /**
         * 自动登记：GitHub 上已经标识好的仓库，切到仓库页就该直接看到，
         * 不用再点「加入本机」。与桌面端同一套规则：
         * 只收有硬证据的（marker / topic / description / legacy），
         * 不收未识别、也不收指向本机没装软件的。
         */
        const EVIDENCE = new Set(['marker', 'topic', 'description', 'legacy']);
        const sources = describeSources(config);
        const adopted = [];

        for (const [sourceId, list] of Object.entries(found.bySource ?? {})) {
          const source = sources.find((s) => s.id === sourceId);
          if (!source) continue;

          for (const repo of list) {
            if (repo.registered) continue;
            if (!EVIDENCE.has(repo.confidence)) continue;
            if (config.repos.some(
              (r) => r.owner === repo.owner && r.repoName.toLowerCase() === String(repo.name).toLowerCase(),
            )) continue;

            const id = newRepoId();
            config.repos.push(normalizeRepo({
              id,
              name: repo.manifestName || repo.name,
              owner: repo.owner,
              repoName: repo.name,
              branch: repo.defaultBranch || 'main',
              private: repo.private !== false,
              description: repo.description ?? '',
              source: source.id,
              topics: Array.isArray(repo.topics) ? repo.topics : [],
              cacheDir: path.join(paths.repos, id),
              htmlUrl: `https://github.com/${repo.owner}/${repo.name}`,
              createdAt: new Date().toISOString(),
            }));
            repo.registered = true;
            adopted.push({ owner: repo.owner, name: repo.name, source: source.id, label: source.label });
          }
        }

        if (adopted.length > 0) {
          saveConfig(config);
          const refreshed = await discoverRemoteRepos({
            token,
            sources,
            registered: config.repos ?? [],
          });
          if (refreshed.ok) Object.assign(found, refreshed);
        }

        return {
          ...found,
          adopted,
          login: config.github?.login ?? '',
          markerFile: MARKER_FILE,
        };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 验证并保存令牌。 */
    async connect(token) {
      const result = await verifyToken(token);
      if (!result.ok) return result;
      writeToken(token);
      const config = loadConfig();
      if (config) {
        config.github = { login: result.login, avatar: result.avatar };
        saveConfig(config);
      }
      return result;
    },

    async disconnect() {
      clearToken();
      const config = loadConfig();
      if (config) {
        config.github = { login: '', avatar: '' };
        saveConfig(config);
      }
      return { ok: true };
    },

    /** 建仓（带标识）并登记到本机。 */
    async createRepo(input) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const auth = requireToken();
      if (!auth.ok) return auth;
      const token = auth.token;

      const result = await createRepoWithMarker(token, {
        ...input,
        machine: config.machine,
        version: ENGINE_VERSION,
      });
      if (!result.ok) return result;

      const id = newRepoId();
      const repo = normalizeRepo({
        id,
        name: input.localName || result.name,
        owner: result.owner,
        repoName: result.name,
        branch: result.defaultBranch ?? 'main',
        private: result.private,
        description: result.description ?? input.description ?? '',
        topics: result.topics ?? [],
        source: input.source,
        cacheDir: path.join(paths.repos, id),
        htmlUrl: result.htmlUrl,
        createdAt: new Date().toISOString(),
      });
      config.repos.push(repo);
      saveConfig(config);
      return { ...result, repo };
    },

    /** 把远端仓库登记到本机（归属已知）。 */
    async adopt(input) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const auth = requireToken();
      if (!auth.ok) return auth;
      const token = auth.token;
      if (!input?.owner || !input?.repoName) return { ok: false, error: '缺少仓库地址' };

      const dup = config.repos.find(
        (repo) => repo.owner === input.owner && repo.repoName.toLowerCase() === String(input.repoName).toLowerCase(),
      );
      if (dup) return { ok: false, error: `本机已经登记过这个仓库：${dup.name}` };

      const sources = describeSources(config);
      const known = sources.find((s) => s.id === input.source);
      if (!known) return { ok: false, error: `本机没有「${input.source}」这个软件` };

      const id = newRepoId();
      const repo = normalizeRepo({
        id,
        name: input.name || input.repoName,
        owner: input.owner,
        repoName: input.repoName,
        branch: input.branch || 'main',
        private: input.private !== false,
        description: input.description ?? '',
        source: known.id,
        cacheDir: path.join(paths.repos, id),
        htmlUrl: `https://github.com/${input.owner}/${input.repoName}`,
        createdAt: new Date().toISOString(),
      });
      config.repos.push(repo);
      saveConfig(config);

      // 补标识：失败不算登记失败，但要如实回报
      const claimed = await claimRepo(token, {
        owner: input.owner,
        repoName: input.repoName,
        sourceId: known.id,
        sourceLabel: known.label,
        machine: config.machine,
        version: ENGINE_VERSION,
      });

      return {
        ok: true,
        repo,
        sourceLabel: known.label,
        stamp: { ok: Boolean(claimed.ok), error: claimed.ok ? undefined : claimed.error },
      };
    },

    /** 给本机已登记仓库补写标识。 */
    async stampAll() {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const auth = requireToken();
      if (!auth.ok) return auth;
      const token = auth.token;
      return backfillMarkers(token, {
        sources: describeSources(config),
        registered: config.repos ?? [],
        machine: config.machine,
        version: ENGINE_VERSION,
      });
    },

    /** 移除本机登记（可选删缓存）。 */
    async removeRepo({ id, deleteCache = true }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = config.repos.find((item) => item.id === id);
      config.repos = config.repos.filter((item) => item.id !== id);
      saveConfig(config);
      if (deleteCache && repo?.cacheDir && fs.existsSync(repo.cacheDir)) {
        try {
          fs.rmSync(repo.cacheDir, { recursive: true, force: true });
        } catch {}
      }
      return { ok: true };
    },

    async deleteRemote({ owner, repoName }) {
      const auth = requireToken();
      if (!auth.ok) return auth;
      const token = auth.token;
      return deleteRepo(token, owner, repoName);
    },

    /** 上传 / 下载。 */
    async sync({ repoId, mode, keys }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = config.repos.find((item) => item.id === repoId);
      if (!repo) return { ok: false, error: '找不到这个仓库' };
      const auth = requireToken();
      if (!auth.ok) return auth;

      const engine = buildEngine(config);
      try {
        const result = await engine.runRepo({ repo, mode, selection: { keys } });
        const index = config.repos.findIndex((item) => item.id === repoId);
        if (index >= 0) {
          config.repos[index] = {
            ...config.repos[index],
            lastSyncAt: new Date().toISOString(),
            lastSyncResult: result.ok ? 'ok' : 'error',
          };
          saveConfig(config);
        }
        return { ...result, canRestore: engine.hasBackup() };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 网络通道探测。 */
    async probe() {
      const result = await probeTransport();
      const config = loadConfig();
      if (config && result.ok) {
        config.proxy = result.proxy;
        saveConfig(config);
      }
      return result;
    },

    // ───────────────────────── 远端内容（浏览 / 对比 / 删除）

    /**
     * 读远端仓库内容，按软件原生层级（工作区 → 对话）返回。
     *
     * 和桌面端「远端内容」页用的是同一个 browseRemote，
     * 所以层级、状态判定（一致/差异/仅远端/路径未映射）完全一致。
     */
    async browseList({ repoId, query }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = (config.repos ?? []).find((item) => item.id === repoId);
      if (!repo) return { ok: false, error: '找不到这个仓库' };
      const auth = requireToken();
      if (!auth.ok) return auth;

      try {
        const engine = buildEngine(config);
        const result = await browseRemote({ engine, repo, query: query ?? '' });
        persistProxyFrom(engine);
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 对比单个文件（本地 vs 远端）。 */
    async browseCompare({ repoId, relPath }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = (config.repos ?? []).find((item) => item.id === repoId);
      if (!repo) return { ok: false, error: '找不到这个仓库' };
      const auth = requireToken();
      if (!auth.ok) return auth;

      try {
        const engine = buildEngine(config);
        const result = await compareFile({ engine, repo, relPath });
        persistProxyFrom(engine);
        // 差异行太多会卡死前端，和桌面端一样截断
        if (result.ok && Array.isArray(result.hunks) && result.hunks.length > 4000) {
          result.hunks = result.hunks.slice(0, 4000);
          result.truncated = true;
        }
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 用远端覆盖本地。 */
    async browseTakeRemote({ repoId, relPath }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = (config.repos ?? []).find((item) => item.id === repoId);
      if (!repo) return { ok: false, error: '找不到这个仓库' };
      const auth = requireToken();
      if (!auth.ok) return auth;

      try {
        const engine = buildEngine(config);
        const result = await takeRemote({ engine, repo, relPath });
        persistProxyFrom(engine);
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 把本地文件推到远端。 */
    async browsePushLocal({ repoId, relPath }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = (config.repos ?? []).find((item) => item.id === repoId);
      if (!repo) return { ok: false, error: '找不到这个仓库' };
      const auth = requireToken();
      if (!auth.ok) return auth;

      try {
        const engine = buildEngine(config);
        const result = await pushLocal({ engine, repo, relPath });
        persistProxyFrom(engine);
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 直接改写远端文件内容。 */
    async browseWriteRemote({ repoId, relPath, content }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = (config.repos ?? []).find((item) => item.id === repoId);
      if (!repo) return { ok: false, error: '找不到这个仓库' };
      const auth = requireToken();
      if (!auth.ok) return auth;

      try {
        const engine = buildEngine(config);
        const result = await writeRemoteFile({ engine, repo, relPath, content });
        persistProxyFrom(engine);
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 删除远端文件（支持一次删多个，只提交一次）。 */
    async browseDeleteRemote({ repoId, relPath, relPaths }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const repo = (config.repos ?? []).find((item) => item.id === repoId);
      if (!repo) return { ok: false, error: '找不到这个仓库' };
      const auth = requireToken();
      if (!auth.ok) return auth;

      try {
        const engine = buildEngine(config);
        const paths = Array.isArray(relPaths) ? relPaths : [relPath];
        const result = await deleteRemoteFiles({ engine, repo, relPaths: paths });
        persistProxyFrom(engine);
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    /** 改本机登记的仓库（显示名 / 描述 / 可见性）。 */
    async updateLocalRepo({ id, patch }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      const index = (config.repos ?? []).findIndex((item) => item.id === id);
      if (index < 0) return { ok: false, error: '仓库不存在' };
      config.repos[index] = normalizeRepo({ ...config.repos[index], ...(patch ?? {}), id });
      saveConfig(config);
      return { ok: true, repo: config.repos[index] };
    },

    async updateRemote({ owner, repoName, patch }) {
      const auth = requireToken();
      if (!auth.ok) return auth;
      const token = auth.token;
      return updateRepo(token, owner, repoName, patch);
    },

    async availableRepos() {
      const auth = requireToken();
      if (!auth.ok) return auth;
      const token = auth.token;
      return listRepos(token);
    },

    // ───────────────────────── 选项页：目录设置

    /**
     * 设工作区根目录 / 软件数据目录。
     *
     * 桌面端用系统的「选择文件夹」对话框；插件没有那个能力
     * （DSH 的 directory-picker 服务不对外暴露给第三方插件），
     * 所以这里接受手填路径，同时用 browseDir 让用户能逐层点进去选。
     */
    async setPath({ sourceId, kind, value }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      if (!sourceId) return { ok: false, error: '缺少软件 id' };
      if (kind === 'workspaceRoot') {
        config.workspaceRoot[sourceId] = String(value ?? '');
      } else if (kind === 'softwareHome') {
        config.softwareHome[sourceId] = String(value ?? '');
      } else {
        return { ok: false, error: `未知的目录类型：${kind}` };
      }
      return { ok: true, config: saveConfig(config) };
    },

    /**
     * 列目录（给插件自己做「选择文件夹」用）。
     *
     * 只列目录不列文件，并且限制在用户主目录与各盘符根下，
     * 避免变成一个任意文件系统浏览器。
     */
    async browseDir({ path: target }) {
      const start = typeof target === 'string' && target.length > 0 ? target : os.homedir();
      const resolved = path.resolve(expandHome(start));

      let entries;
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
      } catch (error) {
        return { ok: false, error: `读不了这个目录：${error.message}` };
      }

      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = path.dirname(resolved);
      return {
        ok: true,
        path: resolved,
        parent: parent === resolved ? '' : parent,
        dirs,
      };
    },

    /** 可选的数据源预设（追加软件用）。 */
    sourcePresets() {
      return { ok: true, presets: SOURCE_PRESETS };
    },

    /** 追加一个自定义数据源。 */
    async addCustomSource({ id, label, description, icon, home }) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      if (!id || !home) return { ok: false, error: '缺少 id 或目录' };

      const homeKey = id;
      config.softwareHome[homeKey] = home;
      const list = (config.customSources ?? []).filter((item) => item.id !== id);
      list.push({
        id,
        label: label ?? id,
        description: description ?? '',
        icon: icon ?? '▣',
        homeKey,
        enabled: true,
      });
      config.customSources = list;
      saveConfig(config);
      return { ok: true, homeKey };
    },

    /** 移除一个自定义数据源（连带它的仓库登记）。 */
    async removeCustomSource(id) {
      const config = loadConfig();
      if (!config) return { ok: false, error: '还没有配置' };
      config.customSources = (config.customSources ?? []).filter((item) => item.id !== id);
      config.repos = (config.repos ?? []).filter((repo) => repo.source !== id);
      saveConfig(config);
      return { ok: true };
    },

    /** 诊断信息。 */
    diagnostics() {
      const config = loadConfig();
      return {
        ok: true,
        platform,
        pluginApi: PLUGIN_API_VERSION,
        engineVersion: ENGINE_VERSION,
        hostname: os.hostname(),
        node: process.versions?.node ?? '',
        paths,
        tokenMode: tokenMode(),
        encryptionAvailable: Boolean(crypto?.encrypt),
        proxy: config?.proxy ?? '',
        repos: (config?.repos ?? []).map((repo) => ({
          name: repo.name,
          target: `${repo.owner}/${repo.repoName}`,
          source: repo.source,
        })),
      };
    },
  };
}

for (const __name of ["defaultHome","createSyncCore","PLUGIN_API_VERSION"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}

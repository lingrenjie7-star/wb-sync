// WorkBuddy 扩展后台服务：入口 activate(wb)

/**
 * WorkBuddy 扩展 —— 后台服务半边（在 WorkBuddy 的扩展进程里跑）。
 *
 * 契约（从内置扩展 edge-sync 的 server/index.cjs 实测得到）：
 *   · 入口导出 `activate(wb)`，返回 `{ dispose }`；
 *   · `wb` 提供 `paths.userData()`、`invoke(channel, ...)`、`on(event, cb)` 等宿主能力；
 *   · extension.json 里用 `"service": { "entry": "./server/index.cjs", "process": "fork" }` 声明。
 *
 * 这里只做一件事：把同步引擎挂到一个本地 HTTP 端点，
 * 让 UI 半边（同一个进程树里的渲染层）能调它。
 *
 * 为什么走 HTTP 而不是 wb.invoke：
 *   自定义 channel 需要先在 WorkBuddy 主进程注册 handler，
 *   而第三方扩展没有那个注册入口（内置扩展用的是 wb:internal: 私有通道）。
 *   HTTP 只依赖 Node 自带的 http 模块，完全在我们自己手里，
 *   而且端口写进 userData 目录，UI 读一下就知道了。
 *
 * 安全：
 *   · 只监听 127.0.0.1，外部网络打不到；
 *   · 每个请求都要带一个随机口令（写在端口文件旁边），
 *     同机其它网页拿不到它，挡掉 CSRF；
 *   · 口令文件权限收紧（能设就设）。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { createSyncCore } = require('./lib/plugin-core.cjs');

/** 启动后把端口和口令写到这个文件，UI 半边读它。 */
const ENDPOINT_FILE = 'dshwb-sync-endpoint.json';

const MAX_BODY = 1024 * 1024;

function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createApi(core) {
  const wrap = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };

  return {
    bootstrap: wrap(async () => core.bootstrap()),
    inspectSources: wrap(async () => core.inspectSources()),
    listRepos: wrap(async () => core.listRepos()),
    discover: wrap(async () => core.discover()),
    connect: wrap(async (input) => {
      const token = typeof input === 'string' ? input : String(input?.token ?? '');
      return core.connect(token);
    }),
    disconnect: wrap(async () => core.disconnect()),
    createRepo: wrap(async (input) => core.createRepo(input ?? {})),
    adopt: wrap(async (input) => core.adopt(input ?? {})),
    stampAll: wrap(async () => core.stampAll()),
    removeRepo: wrap(async (input) => core.removeRepo(input ?? {})),
    deleteRemote: wrap(async (input) => core.deleteRemote(input ?? {})),
    sync: wrap(async (input) => core.sync(input ?? {})),
    probe: wrap(async () => core.probe()),
    updateRemote: wrap(async (input) => core.updateRemote(input ?? {})),
    updateRepo: wrap(async (input) => core.updateLocalRepo(input ?? {})),

    // 远端内容
    browseList: wrap(async (input) => core.browseList(input ?? {})),
    browseCompare: wrap(async (input) => core.browseCompare(input ?? {})),
    browseTakeRemote: wrap(async (input) => core.browseTakeRemote(input ?? {})),
    browsePushLocal: wrap(async (input) => core.browsePushLocal(input ?? {})),
    browseWriteRemote: wrap(async (input) => core.browseWriteRemote(input ?? {})),
    browseDeleteRemote: wrap(async (input) => core.browseDeleteRemote(input ?? {})),
    availableRepos: wrap(async () => core.availableRepos()),
    diagnostics: wrap(async () => core.diagnostics()),

    // 选项页
    setPath: wrap(async (input) => core.setPath(input ?? {})),
    browseDir: wrap(async (input) => core.browseDir(input ?? {})),
    sourcePresets: wrap(async () => core.sourcePresets()),
    addCustomSource: wrap(async (input) => core.addCustomSource(input ?? {})),
    removeCustomSource: wrap(async (input) => core.removeCustomSource(input?.id)),
  };
}

/**
 * WorkBuddy 扩展服务入口。
 *
 * @param {object} wb 宿主能力对象
 * @returns {Promise<{dispose: Function}>}
 */
async function activate(wb) {
  // userData 可能返回 Promise，也可能直接返回字符串
  const rawUserData = await wb?.paths?.userData?.();
  const userData = typeof rawUserData === 'string' && rawUserData.length > 0 ? rawUserData : process.cwd();

  const core = createSyncCore({
    platform: 'workbuddy-extension',
    // 刻意不传 crypto：扩展进程没有 safeStorage，tokenMode 会如实变成 'plain'
  });

  const api = createApi(core);
  const secret = randomBytes(24).toString('hex');

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        return sendJson(res, 415, { ok: false, error: '需要 application/json' });
      }

      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error.message}` });
      }

      const method = String(payload.method ?? '');

      // bootstrap 负责下发口令，自己不能要求口令（否则永远拿不到）
      if (method === 'bootstrap') {
        const result = await api.bootstrap();
        return sendJson(res, 200, { ...result, token: secret });
      }

      if (req.headers['x-dshwb-token'] !== secret) {
        return sendJson(res, 403, { ok: false, error: '口令不对' });
      }

      const fn = api[method];
      if (typeof fn !== 'function') {
        return sendJson(res, 404, { ok: false, error: `没有这个方法：${method}` });
      }

      return sendJson(res, 200, await fn(payload.args ?? {}));
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 只监听 loopback：外部网络根本连不上
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const port = server.address().port;
  const endpointPath = path.join(userData, ENDPOINT_FILE);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(endpointPath, JSON.stringify({ port, secret, pid: process.pid, at: new Date().toISOString() }, null, 2), 'utf8');
  try {
    // 尽力收紧权限（Windows 上 chmod 基本无效，但 POSIX 上有效）
    fs.chmodSync(endpointPath, 0o600);
  } catch {}

  return {
    async dispose() {
      try {
        fs.rmSync(endpointPath, { force: true });
      } catch {}
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { activate: typeof activate === 'function' ? activate : undefined };

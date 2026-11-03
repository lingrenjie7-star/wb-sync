/**
 * WorkBuddy 扩展 —— UI 半边（浏览器里跑）。
 *
 * 契约（从 WorkBuddy 的 extension-mount 实测）：
 *   宿主做的是 `loadRemote(`${remoteName}/Main`)`，也就是模块联邦的 remote 容器，
 *   必须 **expose `./Main`**，且默认导出是 React 组件。
 *
 * 界面本体在 plugins/shared/panel.js（构建时内联到文末的占位符位置），
 * 与 DSH 插件**共用同一份**，避免两边风格越改越远。
 *
 * 数据来源：
 *   后台服务（service.mjs）把端口和口令写到用户数据目录的
 *   dshwb-sync-endpoint.json。UI 拿不到文件系统，通过宿主桥
 *   `window.__wbInvoke` 读一次；读不到就退回「手填端口」的降级表单。
 */

/** 后台服务写下的 endpoint 文件名（与 service.mjs 保持一致）。 */
const DSHWB_ENDPOINT_NAME = 'dshwb-sync-endpoint.json';

/**
 * 读后台服务写下的 endpoint（端口 + 口令）。
 *
 * WorkBuddy 暴露的 `window.__wbInvoke` 是扩展访问宿主的公开桥；
 * 不同版本可用通道不一样，所以逐个尝试，全失败返回 undefined。
 */
async function dshwbReadEndpoint() {
  const invoke = window.__wbInvoke;
  if (typeof invoke !== 'function') return undefined;

  const channels = [
    'wb:internal:extension-host-capability',
    'wb:fs:readTextFile',
    'wb:fs:readFile',
    'wb:extensions:readFile',
  ];

  for (const channel of channels) {
    for (const arg of [
      { op: 'readFile', path: DSHWB_ENDPOINT_NAME },
      { path: DSHWB_ENDPOINT_NAME },
      DSHWB_ENDPOINT_NAME,
    ]) {
      try {
        const result = await invoke(channel, arg);
        const text = typeof result === 'string'
          ? result
          : (result?.content ?? result?.text ?? result?.data);
        if (typeof text !== 'string' || !text.includes('secret')) continue;
        const parsed = JSON.parse(text);
        if (Number.isInteger(parsed.port) && typeof parsed.secret === 'string') return parsed;
      } catch {
        // 通道不存在或参数不对，继续试下一个
      }
    }
  }
  return undefined;
}

/**
 * 构造 remoteEntry 需要的 { get, init }。
 *
 * 宿主先调 init(shareScope)，再 get('./Main')。
 * React 优先从宿主共享作用域取 —— 必须是同一个实例，
 * 否则 hooks 会因为「两套 React」直接崩。
 */
function dshwbCreateContainer(ReactFallback) {
  let React = ReactFallback;
  let session = null;

  async function call(method, args) {
    if (!session) return { ok: false, error: '还没有连上后台服务' };
    const headers = { 'Content-Type': 'application/json' };
    if (session.secret) headers['x-dshwb-token'] = session.secret;

    try {
      const response = await fetch(`http://127.0.0.1:${session.port}/api`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, args }),
      });
      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.json())?.error ?? '';
        } catch {}
        return { ok: false, error: detail || `后台返回 ${response.status}` };
      }
      const json = await response.json();
      if (method === 'bootstrap' && json?.token) session.secret = json.token;
      return json;
    } catch (error) {
      return { ok: false, error: `连不上后台服务（${session.port}）：${error.message}` };
    }
  }

  /** 建会话：把端口/口令放进 session，并用 bootstrap 验一次。 */
  async function connect(port, secret) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) return { ok: false, error: '端口不对' };
    session = { port: p, secret: String(secret ?? '') };
    const info = await call('bootstrap');
    if (!info.ok) {
      session = null;
      return { ok: false, error: info.error ?? '连不上后台服务' };
    }
    return { ok: true, info };
  }

  /** 包一层：没连上时先自动读 endpoint，连不上才让面板显示连接表单。 */
  function createBoundPanel() {
    const Inner = dshwbCreatePanel({
      React,
      call: async (method, args) => {
        if (!session) return { ok: false, error: '还没有连上后台服务' };
        return call(method, args);
      },
    });

    return function WorkBuddySyncPanel() {
      const { useState, useEffect } = React;
      const h = React.createElement;
      const [state, setState] = useState(() => (session ? 'ready' : 'probing'));
      const [error, setError] = useState('');

      useEffect(() => {
        if (session) return;
        let alive = true;
        (async () => {
          const endpoint = await dshwbReadEndpoint();
          if (!alive) return;
          if (!endpoint) {
            setState('manual');
            return;
          }
          const r = await connect(endpoint.port, endpoint.secret);
          if (!alive) return;
          if (r.ok) setState('ready');
          else { setError(r.error ?? ''); setState('manual'); }
        })();
        return () => { alive = false; };
      }, []);

      if (state === 'ready') return h(Inner, { key: 'ready' });
      if (state === 'probing') {
        return h('div', { className: 'dshwb-root' },
          h('div', { className: 'dshwb-view' },
            h('div', { className: 'dshwb-loading' }, '正在连接后台服务…')));
      }

      // 手动连接表单
      return h('div', { className: 'dshwb-root' },
        h('div', { className: 'dshwb-view' },
          h('div', { className: 'dshwb-head' },
            h('h1', null, '跨电脑同步'),
            h('p', null, '扩展的后台服务负责真正的同步。')),
          h('div', { className: 'dshwb-notice' },
            h('div', null, '没能自动连上后台服务。'),
            h('div', null, `到用户数据目录找 ${DSHWB_ENDPOINT_NAME}，把 port 和 secret 填进来。`)),
          error ? h('div', { className: 'dshwb-hint bad' }, error) : null,
          h('div', { className: 'dshwb-card' },
            h('div', { className: 'dshwb-card-head' }, h('div', null, h('h2', null, '连接后台服务'))),
            h('div', { className: 'dshwb-card-body' },
              h('div', { className: 'dshwb-field' },
                h('label', null, '端口'),
                h('input', { className: 'dshwb-input', placeholder: '例如 51234' })),
              h('div', { className: 'dshwb-field' },
                h('label', null, '口令（secret）'),
                h('input', { className: 'dshwb-input', placeholder: 'endpoint 文件里的 secret' })),
              h('button', {
                className: 'dshwb-btn primary',
                onClick: async (e) => {
                  const box = e.currentTarget.parentElement;
                  const port = box.querySelectorAll('input')[0].value;
                  const secret = box.querySelectorAll('input')[1].value;
                  const r = await connect(port, secret);
                  if (!r.ok) return setError(r.error ?? '连接失败');
                  setError('');
                  setState('ready');
                },
              }, '连接'),
              h('div', { className: 'dshwb-hint' }, `这两个值都在 ${DSHWB_ENDPOINT_NAME} 里，扩展启动时生成。`),
            ),
          ),
        ));
    };
  }

  let cached;

  return {
    async init(scope) {
      // 优先用宿主共享的 React，保证 hooks 状态不串
      try {
        const shared = scope?.default?.react ?? scope?.react;
        const candidate = shared?.get?.() ?? shared?.lib?.();
        if (candidate && typeof candidate.createElement === 'function') React = candidate;
      } catch {}
    },
    async get(request) {
      const name = String(request).replace(/^\.\//, '');
      if (name !== 'Main') {
        throw new Error(`[dshwb-sync] 只暴露 ./Main，请求的是 ${request}`);
      }
      dshwbEnsureStyles(document);
      if (!cached) cached = createBoundPanel();
      return cached;
    },
  };
}

/**
 * 注册到宿主的模块系统。
 *
 * WorkBuddy 用模块联邦的 `register(data)` 全局注册 remote 容器，
 * 写法与 webpack 产物一致。
 */
(function registerRemote() {
  const container = dshwbCreateContainer(window.React);

  if (typeof window.__webpack_init_sharing__ !== 'function') {
    window.__webpack_init_sharing__ = async () => window.__webpack_share_scopes__;
  }
  if (!window.__webpack_share_scopes__) {
    window.__webpack_share_scopes__ = { default: {} };
  }

  const registerFn =
    window.register ??
    window.__federation_register__ ??
    window.__mf_register__;

  if (typeof registerFn === 'function') {
    try {
      // 新版运行时要求传一个可调用对象（可调用 + 带 get/init）
      const callable = (moduleName, scope) => container.init(scope);
      Object.assign(callable, { get: container.get, init: container.init });
      registerFn(callable, 'default');
      registerFn(callable);
    } catch (error) {
      console.error('[dshwb-sync] 联邦注册失败：', error);
    }
  }

  // 退路：直接暴露容器，宿主或调试者可以从这里拿
  window.__dshwbSyncContainer = container;
})();

// ───────────────────── 共享面板（构建时把 plugins/shared/panel.js 内联到这里）
/* __DSHWB_SHARED_PANEL__ */

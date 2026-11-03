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
// ── 以下内联自 plugins/shared/panel.js（两个插件共用）
/**
 * 两个插件共用的面板实现（DSH 插件 与 WorkBuddy 扩展）。
 *
 * 为什么抽出来：
 *   之前两边的界面各写一份，改一边忘一边，风格越差越远。
 *   现在 UI 只有这一份，两个构建脚本把它内联进各自的入口文件。
 *
 * 为什么不用 CSS 变量继承宿主主题：
 *   早先的版本写的是 var(--dsh-text, #e6e9ee) —— DSH 一旦换成浅色主题，
 *   这些变量就变成深色文字，压在深色面板上直接看不清（用户反馈的
 *   「选中的那个根本看不清」就是这个）。桌面客户端本来就是固定深色，
 *   这里也用固定色板，不跟宿主主题走。
 *
 * 对齐桌面端 app/ui/ 的结构：
 *   view(可滚动) → head → tabs → toolbar → 卡片列表 → 底部粘住的操作条
 *
 * 使用方式（构建时内联，不是模块）：
 *   const Panel = dshwbCreatePanel({ React, call, layout });
 */

/* eslint-disable no-unused-vars */

/** 与桌面端 app/ui/style.css 一致的色板（固定深色，不跟随宿主主题）。 */
const DSHWB_CSS = `
.dshwb-root {
  --dwb-bg: #0f1115;
  --dwb-bg-elev: #161a21;
  --dwb-bg-elev-2: #1d222b;
  --dwb-line: #262c36;
  --dwb-line-soft: #1f242c;
  --dwb-text: #e6e9ef;
  --dwb-dim: #9aa4b2;
  --dwb-faint: #6b7482;
  --dwb-accent: #4d7cfe;
  --dwb-accent-soft: #4d7cfe1f;
  --dwb-ok: #3fb950;
  --dwb-warn: #d29922;
  --dwb-danger: #f85149;
  --dwb-radius: 10px;

  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  background: var(--dwb-bg);
  color: var(--dwb-text);
  font: 14px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.dshwb-root * { box-sizing: border-box; }
.dshwb-root button,
.dshwb-root input,
.dshwb-root select { font: inherit; color: inherit; }
.dshwb-root code {
  background: #ffffff0d; padding: 1px 5px; border-radius: 4px; font-size: 0.92em;
}

/* 内容区：桌面端 .view 是 max-width 880 + 底部留白给吸底操作条 */
.dshwb-view {
  max-width: 880px;
  padding: 26px 32px 24px;
  padding-bottom: 92px;
}

.dshwb-head h1 { font-size: 20px; margin: 0 0 6px; font-weight: 600; }
.dshwb-head p { margin: 0 0 20px; color: var(--dwb-dim); font-size: 12.5px; }
.dshwb-muted { color: var(--dwb-dim); }
.dshwb-sm { font-size: 12.5px; }

/* ── 标签页（桌面端 .tabs / .tab） ── */
.dshwb-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.dshwb-tab {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 14px;
  background: var(--dwb-bg-elev);
  border: 1px solid var(--dwb-line);
  border-radius: 9px;
  color: var(--dwb-dim);
  cursor: pointer;
  font-size: 13px;
  transition: background .12s, border-color .12s, color .12s;
}
.dshwb-tab:hover { background: var(--dwb-bg-elev-2); color: var(--dwb-text); }
/* 选中态：实色边框 + accent 底 + 高亮文字，三种信号一起上，
   保证在任何背景下都能一眼看出选中了哪个 */
.dshwb-tab.active {
  background: var(--dwb-accent-soft);
  border-color: var(--dwb-accent);
  color: #ffffff;
  font-weight: 600;
  box-shadow: inset 0 0 0 1px #4d7cfe40;
}
.dshwb-tab-icon { opacity: .85; }
.dshwb-tab-count {
  font-size: 11px; color: var(--dwb-faint);
  font-variant-numeric: tabular-nums;
  padding: 0 5px; border-radius: 8px; background: #ffffff10;
}
.dshwb-tab.active .dshwb-tab-count { color: #c8d6ff; background: #4d7cfe33; }

/* ── 工具栏（全选 / 全不选 / 重新扫描） ── */
.dshwb-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; margin-bottom: 12px; flex-wrap: wrap;
}
.dshwb-toolbar-left { display: flex; align-items: center; gap: 6px; }
.dshwb-hint-text {
  font-size: 12px; color: var(--dwb-faint); margin-left: 6px;
}

/* ── 按钮 ── */
.dshwb-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--dwb-line);
  background: var(--dwb-bg-elev-2);
  color: var(--dwb-text);
  cursor: pointer; white-space: nowrap; font-size: 13px;
  transition: background .12s, border-color .12s, opacity .12s;
}
.dshwb-btn:hover:not(:disabled) { background: #232936; border-color: #333c4a; }
.dshwb-btn:disabled { opacity: .45; cursor: not-allowed; }
.dshwb-btn.primary {
  background: var(--dwb-accent); border-color: var(--dwb-accent);
  color: #fff; font-weight: 500;
}
.dshwb-btn.primary:hover:not(:disabled) { background: #5c88ff; border-color: #5c88ff; }
.dshwb-btn.danger { color: var(--dwb-danger); border-color: #f8514933; }
.dshwb-btn.danger:hover:not(:disabled) { background: #f8514914; border-color: #f8514966; }
.dshwb-btn.ghost { background: transparent; border-color: transparent; color: var(--dwb-dim); }
.dshwb-btn.ghost:hover:not(:disabled) { background: #ffffff0a; color: var(--dwb-text); }
.dshwb-btn.sm { padding: 6px 11px; font-size: 12.5px; }
.dshwb-btn.xs { padding: 3px 8px; font-size: 11.5px; }
.dshwb-btn-icon { font-size: 13px; opacity: .9; }

/* ── 容器卡片（工作区 / 项目） ── */
.dshwb-container {
  background: var(--dwb-bg-elev);
  border: 1px solid var(--dwb-line);
  border-radius: var(--dwb-radius);
  margin-bottom: 10px;
  overflow: hidden;
}
.dshwb-container.global { border-style: dashed; opacity: .88; }
.dshwb-container-head {
  display: flex; align-items: center; gap: 11px;
  padding: 12px 14px; cursor: pointer; user-select: none;
}
.dshwb-container-head:hover { background: #ffffff05; }
.dshwb-container-icon {
  width: 28px; height: 28px; border-radius: 8px;
  background: var(--dwb-accent-soft); color: #8aa5ff;
  display: grid; place-items: center; font-size: 14px; flex: none;
}
.dshwb-container-info { flex: 1; min-width: 0; }
.dshwb-container-title-row { display: flex; align-items: center; gap: 8px; }
.dshwb-container-title { font-weight: 600; font-size: 13.5px; }
.dshwb-container-kind {
  font-size: 10.5px; padding: 1px 6px; border-radius: 20px;
  background: #ffffff10; color: var(--dwb-faint);
}
.dshwb-container-detail {
  font-size: 11.5px; color: var(--dwb-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  direction: rtl; text-align: left;
}
.dshwb-container-stats {
  font-size: 11.5px; color: var(--dwb-faint); text-align: right;
  flex: none; font-variant-numeric: tabular-nums; line-height: 1.5;
}
.dshwb-container-toggle {
  color: var(--dwb-faint); font-size: 11px; flex: none;
  transition: transform .15s;
}
.dshwb-container.open .dshwb-container-toggle { transform: rotate(180deg); }
.dshwb-container-body {
  display: none; border-top: 1px solid var(--dwb-line-soft);
}
.dshwb-container.open .dshwb-container-body { display: block; }

/* ── 条目行 ── */
.dshwb-item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 15px 7px 34px;
  border-bottom: 1px solid #ffffff05;
  cursor: pointer;
}
.dshwb-item:hover { background: #ffffff05; }
.dshwb-item.blocked { opacity: .45; cursor: not-allowed; }
.dshwb-item-main { min-width: 0; flex: 1; }
.dshwb-item-label {
  font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dshwb-item-detail {
  font-size: 11.5px; color: var(--dwb-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  direction: rtl; text-align: left;
}
.dshwb-item-meta {
  font-size: 11.5px; color: var(--dwb-faint); flex: none;
  font-variant-numeric: tabular-nums;
}

/* ── 复选框（桌面端 .check，自绘） ── */
.dshwb-check {
  appearance: none; -webkit-appearance: none;
  width: 16px; height: 16px; border: 1.5px solid #3a4250;
  border-radius: 4px; flex: none; cursor: pointer; position: relative;
  background: transparent; margin: 0;
  transition: background .12s, border-color .12s;
}
.dshwb-check:checked { background: var(--dwb-accent); border-color: var(--dwb-accent); }
.dshwb-check:checked::after {
  content: ""; position: absolute; left: 4.5px; top: 1.5px;
  width: 4px; height: 8px; border: solid #fff;
  border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.dshwb-check:indeterminate { background: var(--dwb-accent); border-color: var(--dwb-accent); }
.dshwb-check:indeterminate::after {
  content: ""; position: absolute; left: 3px; top: 6px;
  width: 8px; height: 2px; background: #fff; border-radius: 1px;
  border: 0; transform: none;
}

/* ── 底部吸住的操作条（桌面端 .actions） ── */
.dshwb-actions {
  position: sticky;
  bottom: 0;
  z-index: 5;
  margin-top: 18px;
  padding: 16px 0 18px;
  display: flex; justify-content: space-between; align-items: center;
  gap: 14px; flex-wrap: wrap;
  background: linear-gradient(to top, var(--dwb-bg) 62%, transparent);
}
.dshwb-actions-left { display: flex; gap: 8px; flex-wrap: wrap; }
.dshwb-actions-right { display: flex; align-items: center; gap: 8px; }

/* ── 表单控件 ── */
.dshwb-select, .dshwb-input {
  padding: 7px 10px;
  background: var(--dwb-bg-elev-2);
  border: 1px solid var(--dwb-line);
  border-radius: 8px;
  outline: none; min-width: 160px;
}
.dshwb-input { min-width: 0; }
.dshwb-select:focus, .dshwb-input:focus { border-color: var(--dwb-accent); }
.dshwb-select option { background: var(--dwb-bg-elev-2); color: var(--dwb-text); }

/* ── 卡片 / 空态 / 结果 ── */
.dshwb-card {
  background: var(--dwb-bg-elev);
  border: 1px solid var(--dwb-line);
  border-radius: var(--dwb-radius);
  margin: 14px 0;
  overflow: hidden;
}
.dshwb-card-head {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid var(--dwb-line-soft);
}
.dshwb-card-head h2 { font-size: 14px; margin: 0 0 2px; font-weight: 600; }
.dshwb-card-head p { margin: 0; }
.dshwb-card-body { padding: 14px 16px; }
.dshwb-card-status {
  margin-left: auto; font-size: 11.5px; color: var(--dwb-faint);
  padding: 2px 8px; border: 1px solid var(--dwb-line);
  border-radius: 20px; white-space: nowrap;
}
.dshwb-card-status.ok { color: var(--dwb-ok); border-color: #3fb95044; background: #3fb95012; }
.dshwb-card-status.bad { color: var(--dwb-danger); border-color: #f8514944; background: #f8514912; }

.dshwb-empty {
  padding: 40px 20px; text-align: center;
  color: var(--dwb-faint);
  border: 1px dashed var(--dwb-line);
  border-radius: var(--dwb-radius);
  font-size: 13px; line-height: 1.7;
}
.dshwb-empty h3 { margin: 0 0 6px; font-size: 14px; color: var(--dwb-dim); }

.dshwb-loading {
  padding: 40px 20px; text-align: center; color: var(--dwb-faint);
}

.dshwb-result { margin-top: 20px; background: var(--dwb-bg-elev);
  border: 1px solid var(--dwb-line); border-radius: var(--dwb-radius); overflow: hidden; }
.dshwb-result-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px; border-bottom: 1px solid var(--dwb-line-soft);
}
.dshwb-result-title { font-weight: 600; font-size: 13px; }
.dshwb-result-list {
  margin: 0; padding: 8px 14px 10px 30px;
  font-size: 12.5px; color: var(--dwb-dim);
  max-height: 280px; overflow-y: auto;
}
.dshwb-result-list li { margin: 3px 0; }
.dshwb-result-list li.warn { color: var(--dwb-warn); }
.dshwb-result-list li.err { color: var(--dwb-danger); }
.dshwb-result-list li.ok { color: var(--dwb-ok); }

/* ── 仓库卡片 ── */
.dshwb-repo-list { display: flex; flex-direction: column; gap: 10px; }
.dshwb-repo-card {
  background: var(--dwb-bg-elev);
  border: 1px solid var(--dwb-line);
  border-radius: var(--dwb-radius);
  padding: 14px 16px;
  display: flex; align-items: flex-start; gap: 14px;
}
.dshwb-repo-card:hover { border-color: #333c4a; }
.dshwb-repo-card.remote { border-style: dashed; background: #ffffff03; }
.dshwb-repo-card.unknown { border-color: #d2992233; border-style: dashed; }
.dshwb-repo-main { flex: 1; min-width: 0; }
.dshwb-repo-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshwb-repo-name { font-weight: 600; font-size: 14px; }
.dshwb-repo-target {
  font-size: 12px; color: var(--dwb-faint);
  font-family: "Cascadia Code", Consolas, monospace;
}
.dshwb-repo-meta {
  margin-top: 8px; font-size: 11.5px; color: var(--dwb-faint);
  display: flex; gap: 14px; flex-wrap: wrap;
}
.dshwb-repo-actions {
  display: flex; flex-direction: column; gap: 6px; flex: none;
}
.dshwb-repo-actions.row { flex-direction: row; align-items: center; flex-wrap: wrap; }

.dshwb-pill {
  font-size: 11px; padding: 1px 7px; border-radius: 20px;
  border: 1px solid var(--dwb-line); color: var(--dwb-faint);
  white-space: nowrap;
}
.dshwb-pill.ok { color: var(--dwb-ok); border-color: #3fb95044; background: #3fb95012; }
.dshwb-pill.warn { color: var(--dwb-warn); border-color: #d2992244; background: #d2992212; }
.dshwb-pill.bad { color: var(--dwb-danger); border-color: #f8514944; background: #f8514912; }
.dshwb-pill.public { color: #d29922; border-color: #d2992244; background: #d2992212; }

/* 更多属性折叠区（和桌面端 .advanced 一致） */
.dshwb-advanced {
  margin-top: 14px; border: 1px solid var(--dwb-line-soft);
  border-radius: 8px; padding: 10px 12px;
}
.dshwb-advanced summary {
  cursor: pointer; font-size: 12.5px; color: var(--dwb-dim);
  user-select: none;
}
.dshwb-advanced summary:hover { color: var(--dwb-text); }

/* 「未识别」标签页：和普通软件标签区分开 */
.dshwb-tab.unknown .dshwb-tab-icon { color: var(--dwb-warn); }
.dshwb-tab.unknown.active {
  border-color: #d2992277; background: #d2992214;
}

/* ── 弹窗（新建仓库 / 加入已有仓库 / 目录选择） ── */
.dshwb-modal-mask {
  position: fixed; inset: 0; background: #05070acc;
  backdrop-filter: blur(3px);
  display: grid; place-items: center; z-index: 100; padding: 24px;
}
.dshwb-modal {
  background: var(--dwb-bg-elev); border: 1px solid var(--dwb-line);
  border-radius: 14px; width: 640px; max-width: 94vw;
  max-height: 88vh; display: flex; flex-direction: column;
  box-shadow: 0 24px 70px #000b;
}
.dshwb-modal-head {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 16px 18px; border-bottom: 1px solid var(--dwb-line-soft);
}
.dshwb-modal-head h2 { font-size: 15px; margin: 0 0 3px; font-weight: 600; }
.dshwb-modal-head p { margin: 0; }
.dshwb-modal-body { padding: 16px 18px; overflow-y: auto; flex: 1; }
.dshwb-modal-foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 12px 18px;
  border-top: 1px solid var(--dwb-line-soft); background: #ffffff04;
}
.dshwb-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.dshwb-seg { display: flex; gap: 8px; }
.dshwb-seg-item {
  flex: 1; padding: 9px 12px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--dwb-line); background: transparent;
  text-align: left; color: var(--dwb-dim);
}
.dshwb-seg-item.active {
  border-color: var(--dwb-accent); background: var(--dwb-accent-soft);
  color: #fff;
}
.dshwb-seg-title { display: block; font-size: 13px; font-weight: 600; }
.dshwb-seg-sub { display: block; font-size: 11px; color: var(--dwb-faint); margin-top: 1px; }

/* 目录选择器 */
.dshwb-browser {
  border: 1px solid var(--dwb-line-soft); border-radius: 8px;
  max-height: 300px; overflow-y: auto;
}
.dshwb-browser-path {
  padding: 7px 10px; font-size: 11.5px; color: var(--dwb-dim);
  font-family: "Cascadia Code", Consolas, monospace;
  background: #ffffff06; position: sticky; top: 0;
  border-bottom: 1px solid var(--dwb-line-soft);
  word-break: break-all;
}
.dshwb-browser-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; cursor: pointer; font-size: 12.5px;
  border-bottom: 1px solid #ffffff05;
}
.dshwb-browser-row:hover { background: #ffffff06; }
.dshwb-browser-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 目录设置行（选项页） */
.dshwb-path-row {
  padding: 11px 13px; background: #ffffff05;
  border-radius: 9px; margin-bottom: 10px;
}
.dshwb-path-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
}
.dshwb-path-label { font-weight: 600; font-size: 13.5px; }
.dshwb-path-entry {
  display: flex; align-items: center; gap: 10px;
  padding: 5px 0; font-size: 12px;
}
.dshwb-path-kind { color: var(--dwb-faint); width: 96px; flex: none; }
.dshwb-path-value {
  flex: 1; min-width: 0; font-size: 12px; color: var(--dwb-dim);
  font-family: "Cascadia Code", Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  direction: rtl; text-align: left;
}
.dshwb-notice-title { font-weight: 600; color: var(--dwb-warn); margin-bottom: 2px; }

.dshwb-section {
  margin-top: 18px;
  display: flex; flex-direction: column; gap: 8px;
}
.dshwb-section-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 0 2px;
}
.dshwb-section-title {
  font-size: 12px; color: var(--dwb-faint); letter-spacing: .02em;
}
.dshwb-notice {
  border: 1px solid #d2992244; background: #d299220f;
  border-radius: var(--dwb-radius); padding: 12px 14px;
  font-size: 12px; color: var(--dwb-dim); line-height: 1.6;
  display: flex; flex-direction: column; gap: 4px;
}

/* ── 字段 ── */
.dshwb-field { margin-top: 14px; }
.dshwb-field:first-child { margin-top: 0; }
.dshwb-field label {
  display: block; font-size: 12.5px; color: var(--dwb-dim); margin-bottom: 6px;
}
.dshwb-field .dshwb-input { width: 100%; }
.dshwb-hint { font-size: 11.5px; color: var(--dwb-faint); margin-top: 5px; line-height: 1.5; }
.dshwb-hint.ok { color: var(--dwb-ok); }
.dshwb-hint.bad { color: var(--dwb-danger); }
.dshwb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ── 提示条 ── */
.dshwb-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  background: #1c2431; border: 1px solid var(--dwb-line); color: var(--dwb-text);
  padding: 9px 16px; border-radius: 9px; font-size: 12.5px;
  z-index: 9999; box-shadow: 0 10px 30px #000a; max-width: 70vw;
}
.dshwb-toast.ok { border-color: #3fb95066; }
.dshwb-toast.bad { border-color: #f8514966; }
`;

/** 注入样式（幂等）。 */
function dshwbEnsureStyles(doc) {
  if (doc.getElementById('dshwb-panel-styles')) return;
  const node = doc.createElement('style');
  node.id = 'dshwb-panel-styles';
  node.textContent = DSHWB_CSS;
  doc.head.appendChild(node);
}

/**
 * 造面板组件。
 *
 * @param {object} options
 * @param {object} options.React  React（宿主提供，必须是同一个实例，否则 hooks 会崩）
 * @param {Function} options.call  (method, args) => Promise<{ok, ...}>，由各宿主实现
 * @returns {Function} React 组件
 */
function dshwbCreatePanel({ React, call }) {
  const { useState, useEffect, useCallback, useMemo, useRef } = React;
  const h = React.createElement;

  const fmtBytes = (n) => {
    if (!n || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  };
  const fmtDate = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return function SyncPanel() {
    const [view, setView] = useState('sync');
    const [boot, setBoot] = useState(null);
    const [sources, setSources] = useState([]);
    const [repos, setRepos] = useState([]);
    const [remote, setRemote] = useState(null);
    const [busy, setBusy] = useState('');
    const [toast, setToast] = useState(null);
    const [selected, setSelected] = useState(() => new Set());
    const [activeSource, setActiveSource] = useState('');
    const [targetRepo, setTargetRepo] = useState('');
    const [result, setResult] = useState(null);
    const [tokenInput, setTokenInput] = useState('');
    // 哪些容器是展开的（桌面端默认第一个非全局的展开）
    const [openSet, setOpenSet] = useState(() => new Set());
    // 弹窗：null | { kind:'create' } | { kind:'adopt' } | { kind:'browse', target } | ...
    const [modal, setModal] = useState(null);
    // 正在浏览远端内容的仓库（「远端内容」页的入口参数）
    const [browsingRepo, setBrowsingRepo] = useState(null);
    const toastTimer = useRef();

    const notify = useCallback((message, kind = '') => {
      setToast({ message, kind });
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), kind === 'bad' ? 6000 : 3000);
    }, []);

    const refreshSources = useCallback(async () => {
      const r = await call('inspectSources');
      if (!r.ok) return notify(r.error ?? '扫描失败', 'bad');
      const list = r.sources ?? [];
      setSources(list);
      setActiveSource((prev) => prev || list.find((s) => s.installed)?.id || '');
      // 桌面端默认勾选「对话」层级（非全局容器），并展开第一个
      setSelected((prev) => {
        if (prev.size > 0) return prev;
        const next = new Set();
        for (const s of list) for (const c of s.containers ?? []) if (!c.global) next.add(c.key);
        return next;
      });
      setOpenSet((prev) => {
        if (prev.size > 0) return prev;
        const next = new Set();
        const first = list.flatMap((s) => s.containers ?? []).find((c) => !c.global);
        if (first) next.add(first.key);
        return next;
      });
    }, [notify]);

    const refreshRepos = useCallback(async () => {
      const r = await call('listRepos');
      if (r.ok) setRepos(r.repos ?? []);
    }, []);

    useEffect(() => {
      let alive = true;
      (async () => {
        setBusy('boot');
        const info = await call('bootstrap');
        if (!alive) return;
        setBoot(info);
        setBusy('');
        await refreshSources();
        await refreshRepos();
      })();
      return () => { alive = false; };
    }, [refreshSources, refreshRepos]);

    const installed = useMemo(() => sources.filter((s) => s.installed), [sources]);
    const currentSource = useMemo(
      () => installed.find((s) => s.id === activeSource) ?? installed[0],
      [installed, activeSource],
    );
    const currentRepos = useMemo(
      () => repos.filter((r) => r.source === currentSource?.id),
      [repos, currentSource],
    );

    useEffect(() => {
      if (!targetRepo && currentRepos.length > 0) setTargetRepo(currentRepos[0].id);
      if (targetRepo && !currentRepos.some((r) => r.id === targetRepo)) {
        setTargetRepo(currentRepos[0]?.id ?? '');
      }
    }, [currentRepos, targetRepo]);

    const selectedCount = useMemo(() => {
      const c = currentSource?.containers ?? [];
      return c.filter((x) => selected.has(x.key)).length;
    }, [currentSource, selected]);

    // ── 勾选动作

    const setContainerChecked = (container, on) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (on) {
          next.add(container.key);
          for (const item of container.items ?? []) if (!item.blocked) next.add(item.key);
        } else {
          next.delete(container.key);
          for (const item of container.items ?? []) next.delete(item.key);
        }
        return next;
      });
    };

    const selectAll = (on) => {
      const c = currentSource?.containers ?? [];
      setSelected((prev) => {
        const next = new Set(prev);
        for (const container of c) {
          if (on) {
            next.add(container.key);
            for (const item of container.items ?? []) if (!item.blocked) next.add(item.key);
          } else {
            next.delete(container.key);
            for (const item of container.items ?? []) next.delete(item.key);
          }
        }
        return next;
      });
    };

    const toggleOpen = (key) => {
      setOpenSet((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    };

    // ── 同步动作

    const runSync = async (mode) => {
      if (!targetRepo) return notify('先给这个软件建一个仓库', 'bad');
      const keys = [...selected].filter((k) => k.startsWith(currentSource?.id ?? ''));
      if (keys.length === 0) return notify('至少选一个工作区', 'bad');
      setBusy('sync');
      setResult(null);
      const r = await call('sync', { repoId: targetRepo, mode, keys });
      setBusy('');
      setResult(r);
      notify(r.ok ? (mode === 'upload' ? '上传完成' : '下载完成') : (r.error ?? '同步失败'), r.ok ? 'ok' : 'bad');
      await refreshSources();
      await refreshRepos();
    };

    /** quiet: 后台刷新用，不弹提示，避免每次切页都打扰用户。 */
    const scanRemote = async ({ quiet = false } = {}) => {
      if (!quiet) setBusy('scan');
      const r = await call('discover');
      if (!quiet) setBusy('');
      if (!r.ok) {
        if (!quiet) notify(r.error ?? '扫描失败', 'bad');
        return;
      }
      setRemote(r);

      // 宿主会自动登记「GitHub 上已标识」的仓库，这里刷新本机列表，
      // 否则界面还显示旧的（0 个）。
      const adopted = Array.isArray(r.adopted) ? r.adopted : [];
      if (adopted.length > 0) {
        await refreshRepos();
        await refreshSources();
        if (!quiet) notify(`已自动接入 ${adopted.length} 个仓库：${adopted.map((x) => x.name).join('、')}`, 'ok');
        return;
      }

      if (quiet) return;

      const joinable = Object.values(r.counts ?? {}).reduce((a, b) => a + b.joinable, 0);
      const unknown = (r.unknown ?? []).filter((x) => !x.registered).length;
      const bits = [];
      if (joinable) bits.push(`${joinable} 个未加入`);
      if (unknown) bits.push(`${unknown} 个认不出归属`);
      notify(bits.length ? `GitHub 上：${bits.join('、')}` : `账号下 ${r.total} 个仓库，没有新的同步仓库`, 'ok');
    };

    const adopt = async (repo) => {
      setBusy('adopt');
      const r = await call('adopt', {
        owner: repo.owner, repoName: repo.name, source: currentSource?.id,
        name: repo.manifestName || repo.name, branch: repo.defaultBranch,
        private: repo.private, description: repo.description,
      });
      setBusy('');
      if (!r.ok) return notify(r.error ?? '加入失败', 'bad');
      notify(r.stamp?.ok === false
        ? `已加入，但标识没写进 GitHub：${r.stamp.error ?? '未知原因'}`
        : `已加入「${r.repo.name}」`, r.stamp?.ok === false ? 'bad' : 'ok');
      await refreshRepos();
      await scanRemote();
    };

    const claim = async (repo, sourceId) => {
      setBusy('claim');
      const r = await call('adopt', {
        owner: repo.owner, repoName: repo.name, source: sourceId,
        name: repo.name, branch: repo.defaultBranch,
        private: repo.private, description: repo.description,
      });
      setBusy('');
      if (!r.ok) return notify(r.error ?? '认领失败', 'bad');
      notify(r.stamp?.ok === false ? `已登记，但标识没写进去：${r.stamp.error}` : '已认领，标识已写入',
        r.stamp?.ok === false ? 'bad' : 'ok');
      await refreshRepos();
      await scanRemote();
    };

    const stampAll = async () => {
      setBusy('stamp');
      const r = await call('stampAll');
      setBusy('');
      if (!r.ok) return notify(r.error ?? '补写失败', 'bad');
      notify(r.stamped ? `已给 ${r.stamped} 个仓库补写标识` : '所有仓库都已有标识', 'ok');
      if (remote) await scanRemote();
    };

    // ── 弹窗动作

    const openCreateModal = () => setModal({ kind: 'create' });
    const openAdoptModal = () => setModal({ kind: 'adopt' });
    const openBrowse = (target) => setModal({ kind: 'browse', target });

    /** 新建仓库：建在 GitHub 上，带上本软件的标识，并登记到本机。 */
    const createRepo = async (form) => {
      setBusy('create');
      const r = await call('createRepo', {
        name: form.repoName,
        private: form.isPrivate,
        description: form.description,
        source: currentSource?.id,
        sourceLabel: currentSource?.label,
        localName: form.name,
        autoInit: true,
        // 更多属性（和桌面端一致）
        gitignoreTemplate: form.gitignoreTemplate,
        licenseTemplate: form.licenseTemplate,
        homepage: form.homepage,
        hasIssues: form.hasIssues,
        hasWiki: form.hasWiki,
        hasProjects: form.hasProjects,
      });
      setBusy('');
      if (!r.ok) return { ok: false, error: r.error ?? '创建失败' };
      await refreshRepos();
      if (remote) await scanRemote();
      return { ok: true, marker: r.marker };
    };

    /** 加入已有仓库：手填 owner/repo，由宿主识别归属。 */
    const adoptByAddress = async (form) => {
      setBusy('adopt');
      const r = await call('adopt', {
        owner: form.owner,
        repoName: form.repoName,
        source: form.source || currentSource?.id,
        name: form.name || undefined,
      });
      setBusy('');
      if (!r.ok) return { ok: false, error: r.error ?? '加入失败', undetermined: r.undetermined };
      await refreshRepos();
      if (remote) await scanRemote();
      return { ok: true, stamp: r.stamp };
    };

    // ── 渲染

    if (busy === 'boot') {
      return h('div', { className: 'dshwb-root' }, h('div', { className: 'dshwb-loading' }, '正在读取配置…'));
    }

    // 每个页面的标题与副标题，与桌面端 index.html 的 view-head 保持一致
    const VIEW_HEAD = {
      sync: ['要同步什么', '按软件自己的层级组织：工作区 / 项目 → 对话。'],
      repos: ['仓库', '一个软件可以有多个仓库。同步时在「同步」页选要传到哪个。'],
      browser: ['远端内容', 'GitHub 上真实存在的内容，按软件自己的层级展示。'],
      account: ['账号', '同步通过你自己的 GitHub 仓库进行，不经过任何第三方服务。'],
      options: ['选项', '每个软件只需要配一个「工作区根目录」，具体项目路径由它自动推导。'],
    };

    // 「远端内容」不是一级页签：它从仓库卡片的「远端内容」按钮进入，
    // 所以 mainTabs 里不列它，但 view 可以是它。
    // 「未识别」当独立标签页用（和桌面端一致），不占用真实软件 id。
    // 必须声明在渲染之前 —— 它被 renderRepos/renderRepoTabBar 在 return 里调用，
    // 放到 return 之后会撞上 const 的暂时性死区（实测报错 Cannot access before initialization）。
    const UNKNOWN_TAB = '__unknown__';

    const mainTabs = [['sync', '同步'], ['repos', '仓库'], ['account', '账号'], ['options', '选项']];
    const [headTitle, headSub] = VIEW_HEAD[view] ?? VIEW_HEAD.sync;

    // 令牌存在但读不出来（桌面端用 safeStorage 写的）时，顶部必须说清楚
    const tokenBlocked = boot && boot.tokenPresent && !boot.hasToken;

    return h(
      'div',
      { className: 'dshwb-root' },
      h(
        'div',
        { className: 'dshwb-view' },
        h(
          'div',
          { className: 'dshwb-head' },
          h('h1', null, headTitle),
          h('p', null, headSub),
        ),

        tokenBlocked
          ? h('div', { className: 'dshwb-notice' },
              h('div', { className: 'dshwb-notice-title' }, '令牌读不出来，需要重新连接一次'),
              h('div', null, boot.tokenProblem || '桌面客户端用系统加密保存了令牌，插件进程没有那把钥匙。'),
              h('div', { className: 'dshwb-row', style: { marginTop: 8 } },
                h('button', {
                  className: 'dshwb-btn primary sm',
                  onClick: () => setView('account'),
                }, '去「账号」页重新连接'),
              ))
          : null,

        boot && !boot.encryptionAvailable && boot.hasToken
          ? h('div', { className: 'dshwb-notice' },
              h('div', null, '这个运行环境没有系统加密存储，令牌以明文保存在 ',
                h('code', null, boot.paths?.credentials ?? '~/.dshwb-sync/credentials.json'), '。'))
          : null,

        h('div', { className: 'dshwb-tabs' },
          ...mainTabs.map(([id, label]) =>
            h('button', {
              key: id,
              className: 'dshwb-tab' + (view === id ? ' active' : ''),
              onClick: () => {
                setView(id);
                // 切到仓库页就刷新一次：和桌面端一致，
                // 否则删掉的仓库、别的机器新加的仓库都看不见。
                if (id === 'repos') refreshRepos().then(() => scanRemote({ quiet: true }));
              },
            },
              h('span', { className: 'dshwb-tab-label' }, label),
              id === 'repos' ? h('span', { className: 'dshwb-tab-count' }, String(repos.length)) : null,
            ))),

        view === 'sync' ? renderSync() : null,
        view === 'repos' ? renderRepos() : null,
        view === 'browser' ? h(BrowsePanel, {
          repo: browsingRepo,
          browseList: call,
          notify,
          onBack: () => setView('repos'),
        }) : null,
        view === 'account' ? renderAccount() : null,
        view === 'options' ? renderOptions() : null,
      ),

      modal ? renderModal() : null,
      toast ? h('div', { className: 'dshwb-toast ' + toast.kind }, toast.message) : null,
    );

    // ── 同步页

    function renderSync() {
      if (installed.length === 0) {
        return h('div', { className: 'dshwb-empty' },
          h('h3', null, '没发现可同步的软件'),
          h('div', null, '到「选项」里确认 DSH / WorkBuddy 的数据目录'));
      }
      const containers = currentSource?.containers ?? [];
      const tier = currentSource?.tier ?? { containerLabel: '分组', itemLabel: '条目' };

      return h(
        'div',
        null,
        // 软件标签
        h('div', { className: 'dshwb-tabs' },
          ...installed.map((s) => {
            const chosen = (s.containers ?? []).filter((c) => selected.has(c.key)).length;
            return h('button', {
              key: s.id,
              className: 'dshwb-tab' + (s.id === currentSource?.id ? ' active' : ''),
              onClick: () => { setActiveSource(s.id); setTargetRepo(''); },
            },
              h('span', { className: 'dshwb-tab-icon' }, s.icon ?? '▣'),
              h('span', { className: 'dshwb-tab-label' }, s.label),
              h('span', { className: 'dshwb-tab-count' }, `${chosen}/${(s.containers ?? []).length}`),
            );
          })),

        // 工具栏：全选 / 全不选 / 计数 / 重新扫描
        h('div', { className: 'dshwb-toolbar' },
          h('div', { className: 'dshwb-toolbar-left' },
            h('button', { className: 'dshwb-btn ghost sm', onClick: () => selectAll(true) }, '全选'),
            h('button', { className: 'dshwb-btn ghost sm', onClick: () => selectAll(false) }, '全不选'),
            h('span', { className: 'dshwb-hint-text' },
              `${currentSource?.label ?? ''}：已选 ${selectedCount} / ${containers.length} 个${tier.containerLabel}`),
          ),
          h('button', {
            className: 'dshwb-btn ghost sm',
            disabled: busy !== '',
            onClick: async () => { await refreshSources(); notify('已重新扫描', 'ok'); },
          }, '重新扫描'),
        ),

        // 容器列表
        containers.length === 0
          ? h('div', { className: 'dshwb-empty' }, '这个软件里没有可同步的内容')
          : h('div', null, ...containers.map((c) => renderContainer(c, tier))),

        // 底部吸住的操作条
        h('div', { className: 'dshwb-actions' },
          h('div', { className: 'dshwb-actions-left' },
            h('button', {
              className: 'dshwb-btn primary', disabled: busy !== '',
              onClick: () => runSync('upload'),
            }, h('span', { className: 'dshwb-btn-icon' }, '↑'), '上传到 GitHub'),
            h('button', {
              className: 'dshwb-btn', disabled: busy !== '',
              onClick: () => runSync('download'),
            }, h('span', { className: 'dshwb-btn-icon' }, '↓'), '从 GitHub 下载'),
          ),
          h('div', { className: 'dshwb-actions-right' },
            h('span', { className: 'dshwb-muted dshwb-sm' }, '传到'),
            h('select', {
              className: 'dshwb-select',
              value: targetRepo,
              onChange: (e) => setTargetRepo(e.target.value),
            },
              ...(currentRepos.length === 0
                ? [h('option', { key: '', value: '' }, `${currentSource?.label ?? ''} 还没有仓库`)]
                : currentRepos.map((r) =>
                    h('option', { key: r.id, value: r.id },
                      `${r.name} · ${r.repoName}${r.private ? '' : '（公开）'}`))),
            ),
          ),
        ),

        result ? renderResult() : null,
      );
    }

    function renderContainer(container, tier) {
      const open = openSet.has(container.key);
      const allChecked = selected.has(container.key) ||
        ((container.items ?? []).length > 0 &&
         (container.items ?? []).every((i) => selected.has(i.key)));

      return h('div', {
        key: container.key,
        className: 'dshwb-container' + (container.global ? ' global' : '') + (open ? ' open' : ''),
      },
        h('div', { className: 'dshwb-container-head', onClick: () => toggleOpen(container.key) },
          h('input', {
            type: 'checkbox', className: 'dshwb-check',
            checked: allChecked,
            onClick: (e) => e.stopPropagation(),
            onChange: (e) => setContainerChecked(container, e.target.checked),
          }),
          h('div', { className: 'dshwb-container-icon' }, container.global ? '⚙' : (currentSource?.icon ?? '▣')),
          h('div', { className: 'dshwb-container-info' },
            h('div', { className: 'dshwb-container-title-row' },
              h('span', { className: 'dshwb-container-title' }, container.label),
              h('span', { className: 'dshwb-container-kind' }, container.global ? '全局' : tier.containerLabel),
            ),
            container.detail ? h('div', { className: 'dshwb-container-detail' }, container.detail) : null,
          ),
          h('div', { className: 'dshwb-container-stats' },
            h('div', null, `${(container.items ?? []).length} 个${tier.itemLabel}`),
            container.bytes ? h('div', null, fmtBytes(container.bytes)) : null,
          ),
          h('span', { className: 'dshwb-container-toggle' }, '▾'),
        ),
        h('div', { className: 'dshwb-container-body' },
          ...(container.items ?? []).map((item) =>
            h('label', {
              key: item.key,
              className: 'dshwb-item' + (item.blocked ? ' blocked' : ''),
            },
              h('input', {
                type: 'checkbox', className: 'dshwb-check',
                checked: selected.has(item.key) || selected.has(container.key),
                disabled: Boolean(item.blocked),
                onChange: (e) => {
                  const on = e.target.checked;
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(item.key); else next.delete(item.key);
                    return next;
                  });
                },
              }),
              h('div', { className: 'dshwb-item-main' },
                h('div', { className: 'dshwb-item-label' }, item.label),
                item.detail ? h('div', { className: 'dshwb-item-detail' }, item.detail) : null,
              ),
              h('div', { className: 'dshwb-item-meta' }, item.meta ?? ''),
            )),
        ),
      );
    }

    function renderResult() {
      const steps = result.steps ?? [];
      const conflicts = result.conflicts ?? [];
      const warnings = result.warnings ?? [];
      return h('div', { className: 'dshwb-result' },
        h('div', { className: 'dshwb-result-head' },
          h('span', { className: 'dshwb-result-title' }, result.ok ? '完成' : '同步失败'),
          h('button', { className: 'dshwb-btn ghost xs', onClick: () => setResult(null) }, '收起'),
        ),
        h('ul', { className: 'dshwb-result-list' },
          ...(result.error ? [h('li', { key: 'e', className: 'err' }, result.error)] : []),
          ...steps.map((s, i) => h('li', { key: `s${i}`, className: 'ok' }, s)),
          ...conflicts.map((s, i) => h('li', { key: `c${i}`, className: 'warn' }, s)),
          ...warnings.map((s, i) => h('li', { key: `w${i}`, className: 'warn' }, s)),
        ),
      );
    }

    // ── 仓库页

    function renderRepos() {
      const bySource = remote?.bySource ?? {};
      const unknown = (remote?.unknown ?? []).filter((r) => !r.registered);

      // 当前是不是停在「未识别」标签页
      if (activeSource === UNKNOWN_TAB) {
        return h('div', null,
          renderRepoTabBar(),
          unknown.length === 0
            ? h('div', { className: 'dshwb-empty' },
                h('h3', null, '没有未识别的仓库'),
                h('div', null, '账号下看得见的仓库都认出来了。'))
            : h('div', null,
                h('div', { className: 'dshwb-notice' },
                  h('div', null, '这些仓库里既没有标识文件，也没有同步标签 —— 多半是网页端建的，或者用别的工具建的。'),
                  h('div', null, '选一个软件把它认领下来：程序会把标识写进仓库，以后在任何一台机器上都能自动认出来。')),
                h('div', { className: 'dshwb-repo-list' },
                  ...unknown.map((r) => renderUnknownCard(r)))),
        );
      }

      const list = currentSource ? (bySource[currentSource.id] ?? []) : [];
      const joinable = list.filter((r) => !r.registered);

      return h(
        'div',
        null,
        // 软件标签（最后一个是「未识别」）
        renderRepoTabBar(),
        renderRepoToolbar(joinable),
        ...renderRepoBody(joinable),
      );
    }

    /** 仓库页的软件标签栏：每个软件一个，末尾跟一个「未识别」。 */
    function renderRepoTabBar() {
      const unknown = (remote?.unknown ?? []).filter((r) => !r.registered);
      return h('div', { className: 'dshwb-tabs' },
        ...installed.map((s) => {
          const count = repos.filter((r) => r.source === s.id).length;
          const info = remote?.counts?.[s.id];
          return h('button', {
            key: s.id,
            className: 'dshwb-tab' + (s.id === activeSource ? ' active' : ''),
            onClick: () => setActiveSource(s.id),
          },
            h('span', { className: 'dshwb-tab-icon' }, s.icon ?? '▣'),
            h('span', { className: 'dshwb-tab-label' }, s.label),
            h('span', { className: 'dshwb-tab-count' }, String(count)),
            info && info.joinable > 0
              ? h('span', {
                  title: `GitHub 上还有 ${info.joinable} 个没加入本机`,
                  style: { width: 6, height: 6, borderRadius: '50%', background: '#d29922', flex: 'none' },
                })
              : null,
          );
        }),

        // 只有真有未识别仓库时才显示这个标签，避免空标签页
        unknown.length > 0
          ? h('button', {
              key: UNKNOWN_TAB,
              className: 'dshwb-tab unknown' + (activeSource === UNKNOWN_TAB ? ' active' : ''),
              title: '这些仓库里没有标识文件，也没写标签',
              onClick: () => setActiveSource(UNKNOWN_TAB),
            },
              h('span', { className: 'dshwb-tab-icon' }, '?'),
              h('span', { className: 'dshwb-tab-label' }, '未识别'),
              h('span', { className: 'dshwb-tab-count' }, String(unknown.length)),
              h('span', {
                style: { width: 6, height: 6, borderRadius: '50%', background: '#d29922', flex: 'none' },
              }),
            )
          : null,
      );
    }

    /** 仓库工具栏。 */
    function renderRepoToolbar(joinable) {
      return h('div', { className: 'dshwb-toolbar' },
        h('div', { className: 'dshwb-toolbar-left' },
          h('span', { className: 'dshwb-hint-text' },
            `${currentSource?.label ?? ''}：${currentRepos.length} 个仓库` +
            (joinable.length ? ` · GitHub 上还有 ${joinable.length} 个未加入` : '')),
        ),
        h('div', { className: 'dshwb-row' },
          h('span', { className: 'dshwb-card-status' + (remote?.fetchedAt ? ' ok' : '') },
            remote?.fetchedAt ? `已刷新 ${fmtDate(remote.fetchedAt).split(' ')[1] ?? ''}` : ''),
          h('button', { className: 'dshwb-btn ghost sm', disabled: busy !== '', onClick: () => scanRemote() },
            busy === 'scan' ? '刷新中…' : '刷新'),
          h('button', { className: 'dshwb-btn ghost sm', disabled: busy !== '' || repos.length === 0, onClick: stampAll },
            '补写标识'),
          h('button', { className: 'dshwb-btn ghost sm', disabled: busy !== '', onClick: openAdoptModal },
            '加入已有仓库'),
          h('button', { className: 'dshwb-btn sm', disabled: !currentSource, onClick: openCreateModal },
            '＋ 给这个软件新建仓库'),
        ),
      );
    }

    /** 仓库正文：本机仓库 + 可加入的。 */
    function renderRepoBody(joinable) {
      const out = [];

      out.push(
        currentRepos.length === 0 && joinable.length === 0
          ? h('div', { className: 'dshwb-empty' },
              h('h3', null, `还没有 ${currentSource?.label ?? ''} 的仓库`),
              h('div', null, remote
                ? `账号下没有带 ${currentSource?.label ?? ''} 标识的仓库，点右上角「＋ 给这个软件新建仓库」`
                : '点「刷新」读取账号下已有的仓库'))
          : h('div', { className: 'dshwb-repo-list' },
              ...currentRepos.map((repo) => renderRepoCard(repo))),
      );

      if (joinable.length > 0) {
        out.push(
          h('div', { className: 'dshwb-section' },
            h('div', { className: 'dshwb-section-head' },
              h('span', { className: 'dshwb-section-title' }, 'GitHub 上已有，本机还没加入'),
              h('button', {
                className: 'dshwb-btn ghost xs', disabled: busy !== '',
                onClick: async () => { for (const r of joinable) await adopt(r); },
              }, `全部加入（${joinable.length}）`),
            ),
            h('div', { className: 'dshwb-repo-list' }, ...joinable.map((r) => renderRemoteCard(r)))),
        );
      }

      return out;
    }

    function renderRepoCard(repo) {
      return h('div', { key: repo.id, className: 'dshwb-repo-card' },
        h('div', { className: 'dshwb-repo-main' },
          h('div', { className: 'dshwb-repo-title-row' },
            h('span', { className: 'dshwb-repo-name' }, repo.name),
            h('span', { className: 'dshwb-repo-target' }, `${repo.owner}/${repo.repoName}`),
            h('span', { className: 'dshwb-pill' + (repo.private ? '' : ' public') }, repo.private ? '私有' : '公开'),
            // 远端状态：和桌面端同一套判断，不要只显示「已建好」
            repo.remote?.exists
              ? h('span', { className: 'dshwb-pill ok' }, '已建好')
              : repo.remote === undefined
                ? h('span', { className: 'dshwb-pill' }, '未检查')
                : repo.remote?.error
                  ? h('span', { className: 'dshwb-pill warn' }, '远端未确认')
                  : h('span', { className: 'dshwb-pill warn' }, '仓库不存在'),
            repo.cloned ? h('span', { className: 'dshwb-pill ok' }, '已克隆') : null,
          ),
          repo.description ? h('div', { className: 'dshwb-repo-meta' }, h('span', null, repo.description)) : null,
          h('div', { className: 'dshwb-repo-meta' },
            h('span', null, `分支 ${repo.branch}`),
            // 本地占用（桌面端有，插件之前漏了）
            h('span', null, `本地 ${fmtBytes(repo.sizeOnDisk ?? 0)}`),
            repo.lastSyncAt ? h('span', null, `上次同步 ${fmtDate(repo.lastSyncAt)}`) : null,
          ),
        ),
        h('div', { className: 'dshwb-repo-actions' },
          h('button', { className: 'dshwb-btn ghost xs', onClick: () => { setBrowsingRepo(repo); setView('browser'); } }, '远端内容'),
          h('button', { className: 'dshwb-btn ghost xs', onClick: () => onSyncRepo(repo) }, '同步'),
          h('button', { className: 'dshwb-btn ghost xs', onClick: () => openRepoModal(repo) }, '编辑'),
          h('button', {
            className: 'dshwb-btn ghost xs',
            onClick: () => openRepoUrl(repo),
          }, '打开'),
          h('button', { className: 'dshwb-btn ghost xs danger-text', onClick: () => removeRepo(repo) }, '移除'),
        ),
      );
    }

    function confidencePill(confidence) {
      const map = {
        marker: ['ok', '标识文件'], legacy: ['ok', '旧版标记'],
        topic: ['ok', '标签识别'], description: ['ok', '描述识别'],
        'marker-unknown': ['warn', '本机没这个软件'],
      };
      const hit = map[confidence];
      return hit ? h('span', { className: `dshwb-pill ${hit[0]}` }, hit[1]) : null;
    }

    // ── 本机仓库卡片上的动作（与桌面端一致）

    /** 切到同步页并把这个仓库选中作为上传目标。 */
    function onSyncRepo(repo) {
      setTargetRepo(repo.id);
      setView('sync');
    }

    /** 打开仓库在 GitHub 上的页面。失败要说出来，不能静默。 */
    function openRepoUrl(repo) {
      const url = repo.htmlUrl || (repo.owner && repo.repoName
        ? `https://github.com/${repo.owner}/${repo.repoName}`
        : '');
      if (!url) return notify('这个仓库还没有 GitHub 地址', 'bad');
      window.open(url, '_blank', 'noopener');
    }

    /** 编辑：改显示名 / 描述 / 可见性。 */
    function openRepoModal(repo) {
      setModal({ kind: 'edit', repo });
    }

    /** 移除：先问是否连云端一起删，再走统一的刷新。 */
    async function removeRepo(repo) {
      const target = `${repo.owner}/${repo.repoName}`;
      setModal({
        kind: 'confirm',
        title: '移除仓库',
        message: `${target}\n\n要连 GitHub 上的仓库一起删掉吗？删掉后本机和云端都没有了，无法恢复。`,
        okText: '两端都删',
        danger: true,
        onOk: async () => {
          const r = await call('deleteRemote', { owner: repo.owner, repoName: repo.repoName });
          if (!r.ok) {
            // 云端删不掉：再问一次是否只删本机
            setModal({
              kind: 'confirm',
              title: '云端删除失败',
              message: `${r.error ?? '未知错误'}\n\n要只从本机移除吗？GitHub 上的仓库会保留。`,
              okText: '只移除本机',
              onOk: async () => {
                await call('removeRepo', { id: repo.id, deleteCache: true });
                await afterRepoRemoved(false);
                notify('已从本机移除，GitHub 上的仓库保留', 'bad');
              },
            });
            return;
          }
          await call('removeRepo', { id: repo.id, deleteCache: true });
          await afterRepoRemoved(true);
          notify(r.alreadyGone
            ? 'GitHub 上已经没有这个仓库了，已从本机移除'
            : '已删除，本机和 GitHub 上都没有了', 'ok');
        },
        onCancel: () => {
          // 取消「两端都删」时，再问是否只删本机
          setModal({
            kind: 'confirm',
            title: '只从本机移除？',
            message: `${target}\n\nGitHub 上的仓库会保留，之后可以重新加入。`,
            okText: '只移除本机',
            onOk: async () => {
              await call('removeRepo', { id: repo.id, deleteCache: true });
              await afterRepoRemoved(false);
              notify('已从本机移除，GitHub 上的仓库保留');
            },
          });
        },
      });
    }

    /**
     * 仓库变更后的刷新。
     *
     * 关键：这里**不重新扫远端**。宿主会把「GitHub 上已标识的仓库」自动登记，
     * 删除后立刻重扫会把还在云端的仓库又加回来，看起来就是「删了还在」。
     */
    async function afterRepoRemoved(alsoDeletedRemote) {
      if (alsoDeletedRemote) setRemote(null);
      await refreshRepos();
      await refreshSources();
    }

    function renderRemoteCard(repo) {
      return h('div', { key: repo.fullName, className: 'dshwb-repo-card remote' },
        h('div', { className: 'dshwb-repo-main' },
          h('div', { className: 'dshwb-repo-title-row' },
            h('span', { className: 'dshwb-repo-name' }, repo.manifestName || repo.name),
            h('span', { className: 'dshwb-repo-target' }, repo.fullName),
            h('span', { className: 'dshwb-pill' + (repo.private ? '' : ' public') }, repo.private ? '私有' : '公开'),
            confidencePill(repo.confidence),
          ),
          repo.description ? h('div', { className: 'dshwb-repo-meta' }, h('span', null, repo.description)) : null,
          h('div', { className: 'dshwb-repo-meta' },
            repo.manifestMachine ? h('span', null, `来自 ${repo.manifestMachine}`) : null,
            repo.lastCommit ? h('span', null, `更新于 ${fmtDate(repo.lastCommit)}`) : null,
            repo.hasMarker ? h('span', null, '含 dshwb-sync.json') : null,
          ),
        ),
        h('div', { className: 'dshwb-repo-actions' },
          h('button', { className: 'dshwb-btn primary xs', disabled: busy !== '', onClick: () => adopt(repo) }, '加入本机'),
          h('button', {
            className: 'dshwb-btn ghost xs',
            onClick: () => window.open(repo.htmlUrl || `https://github.com/${repo.fullName}`, '_blank'),
          }, '打开'),
        ),
      );
    }

    function renderUnknownCard(repo) {
      const belongsElsewhere = repo.confidence === 'marker-unknown';
      return h('div', { key: repo.fullName, className: 'dshwb-repo-card unknown' },
        h('div', { className: 'dshwb-repo-main' },
          h('div', { className: 'dshwb-repo-title-row' },
            h('span', { className: 'dshwb-repo-name' }, repo.manifestName || repo.name),
            h('span', { className: 'dshwb-repo-target' }, repo.fullName),
            h('span', { className: 'dshwb-pill' + (repo.private ? '' : ' public') }, repo.private ? '私有' : '公开'),
            belongsElsewhere
              ? h('span', { className: 'dshwb-pill warn' }, `属于 ${repo.manifestSource}`)
              : h('span', { className: 'dshwb-pill warn' }, '未识别'),
          ),
          h('div', { className: 'dshwb-repo-meta' },
            h('span', null, belongsElsewhere
              ? `仓库标识指向「${repo.manifestSource}」，本机没有这个软件`
              : (repo.identityHint || '没有标识文件'))),
        ),
        h('div', { className: 'dshwb-repo-actions row' },
          h('select', {
            className: 'dshwb-select', defaultValue: '',
            onChange: (e) => { e.target.dataset.pick = e.target.value; },
            style: { minWidth: 140 },
          },
            h('option', { value: '' }, '当作…的仓库'),
            ...installed.map((s) => h('option', { key: s.id, value: s.id }, s.label)),
          ),
          h('button', {
            className: 'dshwb-btn primary xs', disabled: busy !== '',
            onClick: (e) => {
              const sel = e.currentTarget.parentElement.querySelector('select');
              if (!sel?.value) return notify('先选一个软件', 'bad');
              claim(repo, sel.value);
            },
          }, '认领'),
        ),
      );
    }

    // ── 账号页

    function renderAccount() {
      return h('div', null,
        h('div', { className: 'dshwb-card' },
          h('div', { className: 'dshwb-card-head' },
            h('div', null,
              h('h2', null, 'GitHub'),
              h('p', { className: 'dshwb-muted dshwb-sm' },
                '浏览器里登录 ≠ 命令行有权限。这里需要一个有 repo 权限的个人访问令牌。'),
            ),
            h('span', { className: 'dshwb-card-status ' + (boot?.hasToken ? 'ok' : 'bad') },
              boot?.hasToken ? '已连接' : (boot?.tokenPresent ? '需要重新连接' : '未连接')),
          ),
          h('div', { className: 'dshwb-card-body' },
            boot?.hasToken
              ? h('div', null,
                  h('div', { className: 'dshwb-row' },
                    h('span', { className: 'dshwb-repo-name' }, boot.config?.github?.login ?? '已保存令牌')),
                  h('div', { className: 'dshwb-row', style: { marginTop: 14 } },
                    h('button', {
                      className: 'dshwb-btn danger',
                      onClick: async () => {
                        await call('disconnect');
                        const info = await call('bootstrap');
                        setBoot(info);
                        notify('已断开连接');
                      },
                    }, '断开连接'),
                  ),
                )
              : h('div', null,
                  // 令牌存在但读不了：这是最容易让人困惑的状态，必须解释清楚
                  boot?.tokenPresent
                    ? h('div', { className: 'dshwb-notice', style: { marginBottom: 14 } },
                        h('div', { className: 'dshwb-notice-title' }, '已有的令牌读不出来'),
                        h('div', null, boot.tokenProblem || '桌面客户端用系统加密保存了令牌，插件的运行环境没有那把钥匙。'),
                        h('div', { style: { marginTop: 6 } },
                          '在下面重新粘贴一次同一个令牌即可 —— 之后会以插件能读的方式保存，两个界面都能用。'),
                      )
                    : null,
                  h('div', { className: 'dshwb-field' },
                    h('label', null, '粘贴令牌'),
                    h('input', {
                      className: 'dshwb-input', type: 'password',
                      placeholder: 'ghp_… 或 github_pat_…',
                      value: tokenInput,
                      onChange: (e) => setTokenInput(e.target.value),
                    }),
                    h('div', { className: 'dshwb-hint' },
                      '创建地址：GitHub → Settings → Developer settings → Personal access tokens'),
                    // 和桌面端一致的快捷入口
                    h('div', { className: 'dshwb-row', style: { marginTop: 8 } },
                      h('button', {
                        className: 'dshwb-btn ghost xs',
                        onClick: () => window.open('https://github.com/settings/tokens/new?scopes=repo&description=dshwb-sync', '_blank', 'noopener'),
                      }, '① 打开 GitHub 创建令牌'),
                      h('button', {
                        className: 'dshwb-btn ghost xs',
                        onClick: () => window.open('https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens', '_blank', 'noopener'),
                      }, '怎么创建？'),
                    ),
                  ),
                  h('button', {
                    className: 'dshwb-btn primary', disabled: busy !== '',
                    onClick: async () => {
                      if (!tokenInput.trim()) return notify('先粘贴令牌', 'bad');
                      setBusy('auth');
                      const r = await call('connect', { token: tokenInput.trim() });
                      setBusy('');
                      if (!r.ok) return notify(r.error ?? '验证失败', 'bad');
                      notify(`已连接 ${r.login}`, 'ok');
                      setTokenInput('');
                      const info = await call('bootstrap');
                      setBoot(info);
                    },
                  }, busy === 'auth' ? '验证中…' : '验证并保存'),
                ),
          ),
        ),

        h('div', { className: 'dshwb-card' },
          h('div', { className: 'dshwb-card-head' },
            h('div', null,
              h('h2', null, '网络通道'),
              h('p', { className: 'dshwb-muted dshwb-sm' }, 'GitHub 在某些网络下需要代理。')),
            h('span', { className: 'dshwb-card-status' }, boot?.proxy ? '走代理' : '直连'),
          ),
          h('div', { className: 'dshwb-card-body' },
            h('button', {
              className: 'dshwb-btn', disabled: busy !== '',
              onClick: async () => {
                setBusy('probe');
                const r = await call('probe');
                setBusy('');
                notify(r.ok ? (r.proxy ? `走代理 ${r.proxy}` : '直连可用') : '连不上 GitHub',
                  r.ok ? 'ok' : 'bad');
              },
            }, busy === 'probe' ? '检测中…' : '自动检测'),
          ),
        ),
      );
    }

    // ── 选项页

    function renderOptions() {
      const config = boot?.config ?? {};
      const customList = config.customSources ?? [];

      return h('div', null,
        // 目录
        h('div', { className: 'dshwb-card' },
          h('div', { className: 'dshwb-card-head' },
            h('div', null,
              h('h2', null, '目录'),
              h('p', { className: 'dshwb-muted dshwb-sm' },
                '工作区根目录是项目所在的父目录——换机时只改这一个，克隆下来的内容会按它还原到对应位置。'),
            ),
          ),
          h('div', { className: 'dshwb-card-body' },
            ...installed.map((s) => {
              const root = config.workspaceRoot?.[s.id] ?? '';
              const home = config.softwareHome?.[s.id] ?? '';
              return h('div', { key: s.id, className: 'dshwb-path-row' },
                h('div', { className: 'dshwb-path-head' },
                  h('span', null, s.icon ?? '▣'),
                  h('span', { className: 'dshwb-path-label' }, s.label),
                  s.tier?.containerLabel && !s.generic
                    ? h('span', { className: 'dshwb-pill' }, s.tier.containerLabel)
                    : null,
                ),
                // 工作区根目录（结构化软件才有）
                s.generic ? null : h('div', { className: 'dshwb-path-entry' },
                  h('span', { className: 'dshwb-path-kind' }, '工作区根目录'),
                  h('span', { className: 'dshwb-path-value' }, root || '（未设置）'),
                  h('button', {
                    className: 'dshwb-btn ghost xs',
                    onClick: () => openBrowse({ sourceId: s.id, kind: 'workspaceRoot' }),
                  }, '选择'),
                ),
                h('div', { className: 'dshwb-path-entry' },
                  h('span', { className: 'dshwb-path-kind' }, '数据目录'),
                  h('span', { className: 'dshwb-path-value' }, home || '（未设置）'),
                  h('button', {
                    className: 'dshwb-btn ghost xs',
                    onClick: () => openBrowse({ sourceId: s.id, kind: 'softwareHome' }),
                  }, '选择'),
                ),
              );
            }),
          ),
        ),

        // 追加软件
        h('div', { className: 'dshwb-card' },
          h('div', { className: 'dshwb-card-head' },
            h('div', null,
              h('h2', null, '追加软件'),
              h('p', { className: 'dshwb-muted dshwb-sm' },
                'Codex、Claude Code 或任何把数据放在目录里的工具。'),
            ),
          ),
          h('div', { className: 'dshwb-card-body' },
            h('div', { className: 'dshwb-row' },
              h('select', {
                className: 'dshwb-select', defaultValue: '',
                onChange: (e) => { e.currentTarget.dataset.preset = e.target.value; },
                style: { flex: 1 },
              },
                h('option', { value: '' }, '选择软件…'),
                ...(boot?.presets ?? []).map((p) =>
                  h('option', { key: p.id, value: p.id }, `${p.icon} ${p.label} — ${p.description}`)),
              ),
              h('button', {
                className: 'dshwb-btn sm',
                onClick: async (e) => {
                  const sel = e.currentTarget.parentElement.querySelector('select');
                  const presetId = sel?.value;
                  if (!presetId) return notify('先选一个软件', 'bad');
                  const preset = (boot?.presets ?? []).find((p) => p.id === presetId);
                  // 先让用户挑目录，再添加
                  setModal({
                    kind: 'browse',
                    target: { sourceId: `__add__${presetId}`, kind: 'addSource', preset },
                  });
                },
              }, '选择目录并添加'),
            ),
            h('div', { className: 'dshwb-hint' },
              '插件没有系统的「选择文件夹」对话框，点开后会列出目录让你逐层选。'),
            customList.length > 0
              ? h('div', { style: { marginTop: 12 } },
                  ...customList.map((c) => h('div', { key: c.id, className: 'dshwb-path-entry' },
                    h('span', null, `${c.icon ?? '▣'} ${c.label}`),
                    h('span', { className: 'dshwb-path-value', style: { flex: 1 } },
                      config.softwareHome?.[c.homeKey] ?? ''),
                    h('button', {
                      className: 'dshwb-btn ghost xs',
                      onClick: async () => {
                        const r = await call('removeCustomSource', { id: c.id });
                        if (!r.ok) return notify(r.error ?? '移除失败', 'bad');
                        const info = await call('bootstrap');
                        setBoot(info);
                        await refreshSources();
                        notify('已移除', 'ok');
                      },
                    }, '移除'),
                  )))
              : null,
          ),
        ),

        // 诊断
        h('div', { className: 'dshwb-card' },
          h('div', { className: 'dshwb-card-head' },
            h('div', null,
              h('h2', null, '诊断'),
              h('p', { className: 'dshwb-muted dshwb-sm' }, '出问题时把这段贴出来就能定位。'),
            ),
            h('button', {
              className: 'dshwb-btn ghost sm',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(boot ?? {}, null, 2));
                  notify('已复制', 'ok');
                } catch {
                  notify('复制失败', 'bad');
                }
              },
            }, '复制'),
          ),
          h('div', { className: 'dshwb-card-body' },
            h('pre', {
              style: {
                fontSize: 11, color: '#6b7482', whiteSpace: 'pre-wrap',
                margin: 0, fontFamily: 'Cascadia Code, Consolas, monospace',
                maxHeight: 260, overflow: 'auto',
              },
            }, JSON.stringify({
              paths: boot?.paths,
              platform: boot?.platform,
              engine: boot?.engineVersion,
              tokenMode: boot?.tokenMode,
              tokenPresent: boot?.tokenPresent,
              encryptionAvailable: boot?.encryptionAvailable,
              repos: (boot?.config?.repos ?? []).map((r) => `${r.name} → ${r.owner}/${r.repoName}（${r.source}）`),
            }, null, 2)),
          ),
        ),
      );
    }

    // ── 弹窗

    function renderModal() {
      // 注意：这里必须「渲染组件」而不是「调用函数」。
      // 直接把带 useState 的函数当普通函数调用，会让 hooks 挂在父组件上，
      // 弹窗一开一关就报 React error #310（hooks 数量变化）。
      if (modal.kind === 'confirm') {
        return h(ConfirmModal, {
          title: modal.title,
          message: modal.message,
          okText: modal.okText,
          danger: modal.danger,
          onOk: modal.onOk,
          onCancel: modal.onCancel ?? (() => setModal(null)),
        });
      }
      if (modal.kind === 'edit') {
        return h(EditRepoModal, {
          repo: modal.repo,
          call,
          notify,
          onClose: () => setModal(null),
          onSaved: async () => {
            await refreshRepos();
            if (remote) await scanRemote({ quiet: true });
          },
        });
      }
      if (modal.kind === 'create') {
        return h(CreateRepoModal, {
          source: currentSource,
          busy,
          // 下拉选项来自宿主 bootstrap（和桌面端同一份）
          presets: {
            gitignoreTemplates: boot?.gitignoreTemplates ?? [''],
            licenseKeys: boot?.licenseKeys ?? [''],
          },
          onClose: () => setModal(null),
          onSubmit: createRepo,
          notify,
        });
      }
      if (modal.kind === 'adopt') {
        return h(AdoptRepoModal, {
          boot,
          repos,
          busy,
          call,
          onClose: () => setModal(null),
          onSubmit: adoptByAddress,
          notify,
        });
      }
      if (modal.kind === 'browse') {
        return h(BrowseDirModal, {
          target: modal.target,
          call,
          boot,
          onClose: () => setModal(null),
          onPicked: async () => {
            const info = await call('bootstrap');
            setBoot(info);
            await refreshSources();
          },
          notify,
        });
      }
      return null;
    }

    // ── 弹窗组件（独立组件，各自持有自己的 hooks）

    /**
     * 远端内容页：浏览仓库里真实存在的内容。
     *
     * 和桌面端「远端内容」是同一套数据（都走 browseRemote），
     * 所以层级、状态（一致/差异/仅远端/路径未映射）完全一致。
     */
    function BrowsePanel({ repo, browseList, notify: _notify, onBack }) {
      const { useState, useEffect, useCallback } = React;
      const h = React.createElement;

      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [query, setQuery] = useState('');
      const [diff, setDiff] = useState(null);
      const [working, setWorking] = useState(false);
      const [confirming, setConfirming] = useState(null);
      const [openSet, setOpenSet] = useState(() => new Set());

      const load = useCallback(async (q = '') => {
        if (!repo) return;
        setLoading(true);
        setError('');
        const r = await browseList('browseList', { repoId: repo.id, query: q });
        setLoading(false);
        if (!r.ok) {
          setError(r.error ?? '读取失败');
          setData(null);
          return;
        }
        setData(r);
        // 默认展开所有分组，和桌面端一致
        setOpenSet(new Set((r.containers ?? []).map((c) => c.key)));
      }, [repo, browseList]);

      useEffect(() => { load(''); }, [load]);

      const openDiff = async (relPath) => {
        setDiff({ relPath, loading: true });
        const r = await browseList('browseCompare', { repoId: repo.id, relPath });
        if (!r.ok) {
          setDiff({ relPath, error: r.error ?? '对比失败' });
          return;
        }
        setDiff({ relPath, ...r, loading: false });
      };

      const deleteItem = async (relPath, label) => {
        // 用应用内的确认框，不用浏览器原生 confirm（风格统一）
        setConfirming({ relPath, label });
      };

      const doDelete = async (relPath) => {
        setConfirming(null);
        setWorking(true);
        const r = await browseList('browseDeleteRemote', { repoId: repo.id, relPath });
        setWorking(false);
        if (!r.ok) return _notify?.(r.error ?? '删除失败', 'bad');
        _notify?.('已从远端删除', 'ok');
        setDiff(null);
        await load(query);
      };

      if (!repo) {
        return h('div', { className: 'dshwb-empty' }, '没有选中仓库');
      }

      if (loading && !data) {
        return h('div', { className: 'dshwb-loading' }, '正在读取 GitHub 上的内容…');
      }

      if (error) {
        return h('div', null,
          h('div', { className: 'dshwb-row', style: { marginBottom: 12 } },
            h('button', { className: 'dshwb-btn ghost sm', onClick: onBack }, '← 返回仓库'),
            h('button', { className: 'dshwb-btn sm', onClick: () => load(query) }, '重试'),
          ),
          h('div', { className: 'dshwb-empty' }, error));
      }

      const containers = data?.containers ?? [];
      const tier = data?.tier ?? { containerLabel: '分组', itemLabel: '条目' };

      // 统计
      let same = 0, differs = 0, remoteOnly = 0, unmapped = 0;
      for (const c of containers) {
        for (const it of c.items ?? []) {
          if (it.state === 'same') same++;
          else if (it.state === 'differs') differs++;
          else if (it.state === 'unmapped') unmapped++;
          else remoteOnly++;
        }
      }

      return h('div', null,
        // 顶部条：返回 + 仓库标识 + 统计
        h('div', { className: 'dshwb-row', style: { marginBottom: 12 } },
          h('button', { className: 'dshwb-btn ghost sm', onClick: onBack }, '← 返回仓库'),
          h('span', { className: 'dshwb-repo-name' }, repo.name),
          h('span', { className: 'dshwb-repo-target' }, `${repo.owner}/${repo.repoName}`),
          h('span', { className: 'dshwb-card-status ok' }, `${containers.length} 个${tier.containerLabel}`),
        ),

        // 搜索 + 刷新
        h('div', { className: 'dshwb-row', style: { marginBottom: 10 } },
          h('input', {
            className: 'dshwb-input', placeholder: '搜索…', value: query,
            style: { flex: 1 },
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') load(query); },
          }),
          h('button', { className: 'dshwb-btn sm', disabled: loading, onClick: () => load(query) },
            loading ? '读取中…' : '刷新'),
        ),

        // 统计
        h('div', { className: 'dshwb-row', style: { marginBottom: 10, gap: 14 } },
          h('span', { className: 'dshwb-hint ok' }, `一致 ${same}`),
          h('span', { className: 'dshwb-hint' }, `有差异 ${differs}`),
          h('span', { className: 'dshwb-hint' }, `仅远端 ${remoteOnly}`),
          unmapped > 0 ? h('span', { className: 'dshwb-hint bad' }, `路径未映射 ${unmapped}`) : null,
        ),

        containers.length === 0
          ? h('div', { className: 'dshwb-empty' }, '仓库里还没有内容，先上传一次')
          : h('div', { className: 'dshwb-tree' },
              ...containers.map((c) => {
                const open = openSet.has(c.key);
                return h('div', { key: c.key, className: 'dshwb-container' + (open ? ' open' : '') },
                  h('div', {
                    className: 'dshwb-container-head',
                    onClick: () => {
                      setOpenSet((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
                        return next;
                      });
                    },
                  },
                    h('div', { className: 'dshwb-container-icon' }, c.global ? '⚙' : '▣'),
                    h('div', { className: 'dshwb-container-info' },
                      h('div', { className: 'dshwb-container-title-row' },
                        h('span', { className: 'dshwb-container-title' }, c.label),
                        h('span', { className: 'dshwb-container-kind' }, c.global ? '全局' : tier.containerLabel),
                      ),
                      c.detail ? h('div', { className: 'dshwb-container-detail' }, c.detail) : null,
                    ),
                    h('div', { className: 'dshwb-container-stats' },
                      h('div', null, `${(c.items ?? []).length} 个${tier.itemLabel}`)),
                    h('span', { className: 'dshwb-container-toggle' }, '▾'),
                  ),
                  h('div', { className: 'dshwb-container-body' },
                    ...(c.items ?? []).map((it) => {
                      const badge = {
                        same: ['ok', '一致'],
                        differs: ['warn', '差异'],
                        unmapped: ['bad', '路径未映射'],
                      }[it.state] ?? ['', '仅远端'];
                      return h('div', { key: it.key, className: 'dshwb-item', style: { cursor: 'pointer' } },
                        h('span', { className: `dshwb-pill ${badge[0]}` }, badge[1]),
                        h('div', { className: 'dshwb-item-main', onClick: () => openDiff(it.path) },
                          h('div', { className: 'dshwb-item-label' }, it.label),
                          h('div', { className: 'dshwb-item-detail' },
                            it.state === 'same' ? '内容与本地相同'
                              : it.state === 'unmapped' ? '仓库里记录的工作目录在本机没有对应位置'
                                : it.localExists ? `远端 ${fmtBytes(it.size)} · 本地 ${fmtBytes(it.localSize ?? 0)}`
                                  : `远端 ${fmtBytes(it.size)} · 本机没有`),
                        ),
                        h('button', { className: 'dshwb-btn ghost xs', onClick: () => openDiff(it.path) }, '对比'),
                        h('button', {
                          className: 'dshwb-btn ghost xs danger-text',
                          disabled: working,
                          onClick: () => deleteItem(it.path, it.label),
                        }, '删除'),
                      );
                    }),
                  ),
                );
              }),
            ),

        // 对比面板
        diff ? h(DiffPanel, {
          diff, working,
          onClose: () => setDiff(null),
          onTakeRemote: async () => {
            setWorking(true);
            const r = await browseList('browseTakeRemote', { repoId: repo.id, relPath: diff.relPath });
            setWorking(false);
            if (!r.ok) return _notify?.(r.error ?? '失败', 'bad');
            _notify?.('已用远端版本覆盖本地（原文件已备份）', 'ok');
            await openDiff(diff.relPath);
            await load(query);
          },
          onPushLocal: async () => {
            setWorking(true);
            const r = await browseList('browsePushLocal', { repoId: repo.id, relPath: diff.relPath });
            setWorking(false);
            if (!r.ok) return _notify?.(r.error ?? '失败', 'bad');
            _notify?.(r.pushed ? '已推送到远端' : '远端已是最新', 'ok');
            await openDiff(diff.relPath);
            await load(query);
          },
        }) : null,

        // 删除确认（应用内，不用浏览器原生 confirm）
        confirming ? h(ConfirmModal, {
          title: '从 GitHub 删除',
          message: `「${confirming.label}」\n\n会提交一次删除，本地文件不受影响。`,
          okText: '删除',
          danger: true,
          onOk: () => doDelete(confirming.relPath),
          onCancel: () => setConfirming(null),
        }) : null,
      );
    }

    /** 单文件对比面板。 */
    function DiffPanel({ diff, working, onClose, onTakeRemote, onPushLocal }) {
      const h = React.createElement;

      return h('div', { className: 'dshwb-card', style: { marginTop: 14 } },
        h('div', { className: 'dshwb-card-head' },
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('h2', null, String(diff.relPath).split('/').pop()),
            h('p', { className: 'dshwb-muted dshwb-sm' }, diff.relPath),
          ),
          h('span', {
            className: 'dshwb-card-status ' + (diff.same ? 'ok' : diff.localExists === false ? 'bad' : ''),
          },
            diff.loading ? '对比中…' : diff.error ? '失败' : diff.same ? '完全一致' : diff.localExists ? '有差异' : '本机没有'),
          h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '关闭'),
        ),
        h('div', { className: 'dshwb-card-body' },
          diff.error
            ? h('div', { className: 'dshwb-hint bad' }, diff.error)
            : diff.loading
              ? h('div', { className: 'dshwb-loading' }, '正在对比…')
              : diff.binary
                ? h('div', null,
                    h('div', { className: 'dshwb-hint' }, '这是二进制文件，只比较大小和指纹。'),
                    h('div', { className: 'dshwb-hint' },
                      `远端 ${fmtBytes(diff.remoteSize)} · 本机 ${diff.localExists ? fmtBytes(diff.localSize) : '不存在'}`))
                : h('div', null,
                    h('div', { className: 'dshwb-row', style: { marginBottom: 10 } },
                      h('button', { className: 'dshwb-btn sm', disabled: working || diff.same, onClick: onTakeRemote },
                        '用远端覆盖本地'),
                      h('button', {
                        className: 'dshwb-btn sm',
                        disabled: working || diff.same || !diff.localExists || !diff.localPath,
                        onClick: onPushLocal,
                      }, '把本地推上去'),
                    ),
                    h('pre', {
                      style: {
                        maxHeight: 420, overflow: 'auto', margin: 0,
                        fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                        fontFamily: 'Cascadia Code, Consolas, monospace',
                        background: '#0b0e13', padding: '10px 12px', borderRadius: 8,
                      },
                    },
                      ...(diff.hunks ?? []).map((hunk, i) => {
                        if (hunk.type === 'skip') {
                          return h('div', { key: i, style: { color: '#6b7482', fontStyle: 'italic' } },
                            `… 省略 ${hunk.count} 行 …`);
                        }
                        const prefix = hunk.type === 'add' ? '+ ' : hunk.type === 'del' ? '− ' : '  ';
                        const text = hunk.type === 'add' ? hunk.right : hunk.left;
                        return h('div', {
                          key: i,
                          style: {
                            color: hunk.type === 'add' ? '#3fb950' : hunk.type === 'del' ? '#f85149' : '#9aa4b2',
                            background: hunk.type === 'add' ? '#3fb95012' : hunk.type === 'del' ? '#f8514912' : 'transparent',
                          },
                        }, prefix + (text ?? ''));
                      })),
                  ),
        ));
    }

    /** 通用确认框（替换浏览器原生 confirm，风格与界面统一）。 */
    function ConfirmModal({ title, message, okText, danger, onOk, onCancel }) {
      const { useState } = React;
      const h = React.createElement;
      const [working, setWorking] = useState(false);

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onCancel(); },
      },
        h('div', { className: 'dshwb-modal', style: { width: 460 } },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, title),
              h('p', { className: 'dshwb-muted dshwb-sm', style: { whiteSpace: 'pre-wrap' } }, message),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', null),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onCancel }, '取消'),
              h('button', {
                className: 'dshwb-btn ' + (danger ? 'danger' : 'primary'),
                disabled: working,
                onClick: async () => {
                  setWorking(true);
                  try {
                    await onOk();
                  } finally {
                    setWorking(false);
                  }
                },
              }, okText ?? '确定'),
            ),
          ),
        ));
    }

    /** 编辑仓库：显示名 / 描述 / 可见性。 */
    function EditRepoModal({ repo, call, onClose, onSaved, notify: _notify }) {
      const { useState } = React;
      const h = React.createElement;
      const [name, setName] = useState(repo.name ?? '');
      const [description, setDescription] = useState(repo.description ?? '');
      const [isPrivate, setIsPrivate] = useState(repo.private !== false);
      const [hint, setHint] = useState({ text: '', kind: '' });
      const [saving, setSaving] = useState(false);

      const save = async () => {
        if (!name.trim()) return setHint({ text: '显示名不能为空', kind: 'bad' });
        setSaving(true);
        setHint({ text: '正在保存…', kind: '' });

        // 先改本机登记
        const local = await call('updateRepo', {
          id: repo.id,
          patch: { name: name.trim(), description: description.trim(), private: isPrivate },
        });
        if (!local.ok) {
          setSaving(false);
          return setHint({ text: local.error ?? '保存失败', kind: 'bad' });
        }

        // 再改 GitHub 上的属性
        const remoteRes = await call('updateRemote', {
          owner: repo.owner,
          repoName: repo.repoName,
          patch: {
            description: description.trim() || undefined,
            private: isPrivate,
          },
        });
        setSaving(false);

        if (!remoteRes.ok) {
          setHint({ text: `本机已保存，但 GitHub 那边没改成：${remoteRes.error}`, kind: 'bad' });
          await onSaved();
          return;
        }
        onClose();
        await onSaved();
        _notify?.('已保存，GitHub 上的属性也更新了', 'ok');
      };

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'dshwb-modal', style: { width: 560 } },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, `编辑「${repo.name}」`),
              h('p', { className: 'dshwb-muted dshwb-sm' }, `${repo.owner}/${repo.repoName} · 改动会同步到 GitHub 上。`),
            ),
            h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'dshwb-modal-body' },
            h('div', { className: 'dshwb-field' },
              h('label', null, '显示名'),
              h('input', { className: 'dshwb-input', value: name, onChange: (e) => setName(e.target.value) }),
              h('div', { className: 'dshwb-hint' }, '只在你自己的界面里显示'),
            ),
            h('div', { className: 'dshwb-field' },
              h('label', null, '可见性'),
              h('div', { className: 'dshwb-seg' },
                h('button', {
                  className: 'dshwb-seg-item' + (isPrivate ? ' active' : ''),
                  onClick: () => setIsPrivate(true),
                },
                  h('span', { className: 'dshwb-seg-title' }, '私有'),
                  h('span', { className: 'dshwb-seg-sub' }, '只有你能看')),
                h('button', {
                  className: 'dshwb-seg-item' + (!isPrivate ? ' active' : ''),
                  onClick: () => setIsPrivate(false),
                },
                  h('span', { className: 'dshwb-seg-title' }, '公开'),
                  h('span', { className: 'dshwb-seg-sub' }, '可分享给别人')),
              ),
            ),
            h('div', { className: 'dshwb-field' },
              h('label', null, '描述'),
              h('input', {
                className: 'dshwb-input', value: description,
                onChange: (e) => setDescription(e.target.value),
              }),
              h('div', { className: 'dshwb-hint' }, '显示在 GitHub 上，自动加软件标识'),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', { className: 'dshwb-hint ' + hint.kind }, hint.text),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onClose }, '取消'),
              h('button', { className: 'dshwb-btn primary', disabled: saving, onClick: save },
                saving ? '保存中…' : '保存'),
            ),
          ),
        ));
    }

    /** 新建仓库（对应桌面端的「＋ 给这个软件新建仓库」）。 */
    function CreateRepoModal({ source, onSubmit, onClose, presets, notify: _notify }) {
      const [name, setName] = useState(source?.label ? source.label + ' 同步' : '同步');
      const [repoName, setRepoName] = useState((source?.id ?? 'sync') + '-sync');
      const [isPrivate, setIsPrivate] = useState(true);
      const [description, setDescription] = useState('');
      // 更多属性（对齐桌面端）
      const [gitignoreTemplate, setGitignoreTemplate] = useState('');
      const [licenseTemplate, setLicenseTemplate] = useState('');
      const [homepage, setHomepage] = useState('');
      const [hasIssues, setHasIssues] = useState(false);
      const [hasWiki, setHasWiki] = useState(false);
      const [hasProjects, setHasProjects] = useState(false);
      const [hint, setHint] = useState({ text: '', kind: '' });
      const [submitting, setSubmitting] = useState(false);
      const sourceLabel = source?.label ?? '';

      const submit = async () => {
        if (!name.trim() || !repoName.trim()) {
          setHint({ text: '显示名和仓库名都要填', kind: 'bad' });
          return;
        }
        setHint({ text: '正在创建…', kind: '' });
        setSubmitting(true);
        const r = await onSubmit({
          name: name.trim(),
          repoName: repoName.trim(),
          isPrivate,
          description: description.trim(),
          // 更多属性：和桌面端一起交给 createRepo
          gitignoreTemplate: gitignoreTemplate || undefined,
          licenseTemplate: licenseTemplate || undefined,
          homepage: homepage.trim() || undefined,
          hasIssues,
          hasWiki,
          hasProjects,
        });
        setSubmitting(false);
        if (!r.ok) {
          setHint({ text: r.error, kind: 'bad' });
          return;
        }
        onClose();
        if (r.marker && r.marker.ok === false) {
          _notify?.('仓库已创建，但标识没写进 GitHub：' + (r.marker.error ?? '未知原因'), 'bad');
        } else {
          _notify?.((isPrivate ? '私有' : '公开') + '仓库已创建，已打上「' + sourceLabel + '」标识', 'ok');
        }
      };

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'dshwb-modal' },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, '为 ' + sourceLabel + ' 建仓库'),
              h('p', { className: 'dshwb-muted dshwb-sm' }, '这个仓库只收 ' + sourceLabel + ' 的内容。'),
            ),
            h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'dshwb-modal-body' },
            h('div', { className: 'dshwb-grid2' },
              h('div', { className: 'dshwb-field' },
                h('label', null, '显示名'),
                h('input', {
                  className: 'dshwb-input', value: name,
                  onChange: (e) => setName(e.target.value),
                }),
                h('div', { className: 'dshwb-hint' }, '只在你自己的界面里显示'),
              ),
              h('div', { className: 'dshwb-field' },
                h('label', null, 'GitHub 仓库名'),
                h('input', {
                  className: 'dshwb-input', value: repoName,
                  onChange: (e) => setRepoName(e.target.value),
                }),
                h('div', { className: 'dshwb-hint' }, '对方看到的仓库名'),
              ),
            ),
            h('div', { className: 'dshwb-field' },
              h('label', null, '可见性'),
              h('div', { className: 'dshwb-seg' },
                h('button', {
                  className: 'dshwb-seg-item' + (isPrivate ? ' active' : ''),
                  onClick: () => setIsPrivate(true),
                },
                  h('span', { className: 'dshwb-seg-title' }, '私有'),
                  h('span', { className: 'dshwb-seg-sub' }, '只有你能看'),
                ),
                h('button', {
                  className: 'dshwb-seg-item' + (!isPrivate ? ' active' : ''),
                  onClick: () => setIsPrivate(false),
                },
                  h('span', { className: 'dshwb-seg-title' }, '公开'),
                  h('span', { className: 'dshwb-seg-sub' }, '可分享给别人'),
                ),
              ),
            ),
            h('div', { className: 'dshwb-field' },
              h('label', null, '描述'),
              h('input', {
                className: 'dshwb-input', value: description,
                placeholder: sourceLabel + ' 跨电脑同步',
                onChange: (e) => setDescription(e.target.value),
              }),
              h('div', { className: 'dshwb-hint' }, '显示在 GitHub 上，自动加软件标识'),
            ),

            /* ── 更多属性：和桌面端一样的 .gitignore / 许可证 / 主页 / 议题 / 维基 / 项目 ── */
            h('details', { className: 'dshwb-advanced' },
              h('summary', null, '更多属性（.gitignore、许可证、主页、议题 / 维基 / 项目）'),
              h('div', { style: { paddingTop: 12 } },
                h('div', { className: 'dshwb-grid2' },
                  h('div', { className: 'dshwb-field' },
                    h('label', null, '.gitignore 模板'),
                    h('select', {
                      className: 'dshwb-select', value: gitignoreTemplate,
                      style: { width: '100%' },
                      onChange: (e) => setGitignoreTemplate(e.target.value),
                    },
                      ...(presets.gitignoreTemplates ?? ['']).map((name) =>
                        h('option', { key: name, value: name }, name || '（不生成）'))),
                    h('div', { className: 'dshwb-hint' }, '由 GitHub 生成'),
                  ),
                  h('div', { className: 'dshwb-field' },
                    h('label', null, '许可证'),
                    h('select', {
                      className: 'dshwb-select', value: licenseTemplate,
                      style: { width: '100%' },
                      onChange: (e) => setLicenseTemplate(e.target.value),
                    },
                      ...(presets.licenseKeys ?? ['']).map((key) =>
                        h('option', { key: key, value: key }, key || '（不添加）'))),
                    h('div', { className: 'dshwb-hint' }, '公开仓库建议选一个'),
                  ),
                ),
                h('div', { className: 'dshwb-field' },
                  h('label', null, '主页网址'),
                  h('input', {
                    className: 'dshwb-input', value: homepage, placeholder: 'https://（可留空）',
                    onChange: (e) => setHomepage(e.target.value),
                  }),
                ),
                h('div', { className: 'dshwb-field' },
                  h('label', null, '附加功能'),
                  h('div', { className: 'dshwb-row', style: { gap: 14 } },
                    h('label', { className: 'dshwb-row', style: { gap: 6, cursor: 'pointer' } },
                      h('input', { type: 'checkbox', className: 'dshwb-check', checked: hasIssues,
                        onChange: (e) => setHasIssues(e.target.checked) }),
                      h('span', { className: 'dshwb-hint', style: { marginTop: 0 } }, '议题 Issues'),
                    ),
                    h('label', { className: 'dshwb-row', style: { gap: 6, cursor: 'pointer' } },
                      h('input', { type: 'checkbox', className: 'dshwb-check', checked: hasWiki,
                        onChange: (e) => setHasWiki(e.target.checked) }),
                      h('span', { className: 'dshwb-hint', style: { marginTop: 0 } }, '维基 Wiki'),
                    ),
                    h('label', { className: 'dshwb-row', style: { gap: 6, cursor: 'pointer' } },
                      h('input', { type: 'checkbox', className: 'dshwb-check', checked: hasProjects,
                        onChange: (e) => setHasProjects(e.target.checked) }),
                      h('span', { className: 'dshwb-hint', style: { marginTop: 0 } }, '项目 Projects'),
                    ),
                  ),
                ),
              ),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', { className: 'dshwb-hint ' + hint.kind }, hint.text),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onClose }, '取消'),
              h('button', { className: 'dshwb-btn primary', disabled: submitting, onClick: submit },
                submitting ? '创建中…' : '创建仓库'),
            ),
          ),
        ));
    }

    /** 加入已有仓库（对应桌面端的「加入已有仓库」）。 */
    function AdoptRepoModal({ boot, repos, call, onSubmit, onClose, notify: _notify }) {
      const [owner, setOwner] = useState(boot?.config?.github?.login ?? '');
      const [repoName, setRepoName] = useState('');
      const [hint, setHint] = useState({ text: '', kind: '' });
      const [candidates, setCandidates] = useState(null);
      const [submitting, setSubmitting] = useState(false);

      useEffect(() => {
        let alive = true;
        (async () => {
          const r = await call('availableRepos');
          if (!alive) return;
          if (r.ok) setCandidates(r.repos ?? []);
          else setCandidates({ failed: r.error });
        })();
        return () => { alive = false; };
      }, []);

      const registered = new Set(repos.map((r) => r.owner + '/' + r.repoName));
      const failed = candidates && !Array.isArray(candidates) ? candidates.failed : '';
      const list = Array.isArray(candidates)
        ? candidates.filter((r) => !registered.has(r.fullName)).slice(0, 60)
        : [];

      const submit = async () => {
        if (!owner.trim() || !repoName.trim()) {
          setHint({ text: '所有者和仓库名都要填', kind: 'bad' });
          return;
        }
        setHint({ text: '正在读取仓库标识…', kind: '' });
        setSubmitting(true);
        const r = await onSubmit({ owner: owner.trim(), repoName: repoName.trim() });
        setSubmitting(false);
        if (!r.ok) {
          setHint({ text: r.error, kind: 'bad' });
          return;
        }
        onClose();
        _notify?.(r.stamp && r.stamp.ok === false
          ? '已加入，但标识没写进 GitHub：' + (r.stamp.error ?? '未知原因')
          : '已加入本机', r.stamp && r.stamp.ok === false ? 'bad' : 'ok');
      };

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'dshwb-modal' },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, '加入已有仓库'),
              h('p', { className: 'dshwb-muted dshwb-sm' }, '另一台机器建过的仓库，这里填地址就能接管，不用重建。'),
            ),
            h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'dshwb-modal-body' },
            h('div', { className: 'dshwb-grid2' },
              h('div', { className: 'dshwb-field' },
                h('label', null, 'GitHub 所有者'),
                h('input', { className: 'dshwb-input', value: owner, onChange: (e) => setOwner(e.target.value) }),
              ),
              h('div', { className: 'dshwb-field' },
                h('label', null, '仓库名'),
                h('input', {
                  className: 'dshwb-input', value: repoName, placeholder: 'dsh-private-sync',
                  onChange: (e) => setRepoName(e.target.value),
                }),
              ),
            ),
            h('div', { className: 'dshwb-hint' }, '程序会读取仓库里的标识文件，自动认出它属于哪个软件'),
            h('div', { className: 'dshwb-field' },
              h('label', null, '或者从账号下的仓库里选'),
              candidates === null
                ? h('div', { className: 'dshwb-hint' }, '正在读取…')
                : failed
                  ? h('div', { className: 'dshwb-hint bad' }, '读不到账号下的仓库：' + failed)
                  : list.length === 0
                    ? h('div', { className: 'dshwb-hint' }, '账号下的仓库都已经登记过了')
                    : h('div', { className: 'dshwb-browser' },
                        ...list.map((r) => h('div', {
                          key: r.fullName, className: 'dshwb-browser-row',
                          onClick: () => { setOwner(r.owner); setRepoName(r.name); },
                        },
                          h('span', { className: 'name' }, r.fullName),
                          h('span', { className: 'dshwb-pill' }, r.private ? '私有' : '公开'),
                        ))),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', { className: 'dshwb-hint ' + hint.kind }, hint.text),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onClose }, '取消'),
              h('button', { className: 'dshwb-btn primary', disabled: submitting, onClick: submit },
                submitting ? '加入中…' : '加入'),
            ),
          ),
        ));
    }

    /**
     * 目录选择器。
     *
     * 插件没有系统的「选择文件夹」对话框（那是 Electron 主进程能力），
     * 所以自己列目录让用户点进去选，并允许直接填绝对路径。
     */
    function BrowseDirModal({ target, call, onClose, onPicked, notify: _notify }) {
      const [listing, setListing] = useState(null);
      const [manual, setManual] = useState('');
      const [hint, setHint] = useState({ text: '', kind: '' });

      const load = async (p) => {
        const r = await call('browseDir', { path: p });
        if (!r.ok) {
          setHint({ text: r.error, kind: 'bad' });
          return;
        }
        setListing(r);
        setManual(r.path);
        setHint({ text: '', kind: '' });
      };

      useEffect(() => { load(''); }, []);

      const pick = async (value) => {
        if (target.kind === 'addSource') {
          const preset = target.preset ?? {};
          const id = preset.id === 'custom' ? 'custom-' + Date.now().toString(36) : preset.id;
          const r = await call('addCustomSource', {
            id,
            label: preset.id === 'custom' ? String(value).split(/[\\/]/).pop() : preset.label,
            description: preset.description,
            icon: preset.icon,
            home: value,
          });
          if (!r.ok) {
            setHint({ text: r.error ?? '添加失败', kind: 'bad' });
            return;
          }
          onClose();
          await onPicked();
          _notify?.('已添加 ' + (preset.label ?? id), 'ok');
          return;
        }

        const r = await call('setPath', { sourceId: target.sourceId, kind: target.kind, value });
        if (!r.ok) {
          setHint({ text: r.error ?? '保存失败', kind: 'bad' });
          return;
        }
        onClose();
        await onPicked();
        _notify?.('已更新目录', 'ok');
      };

      const title = target.kind === 'workspaceRoot'
        ? '选择工作区根目录'
        : target.kind === 'addSource'
          ? '为 ' + (target.preset?.label ?? '新软件') + ' 选择数据目录'
          : '选择数据目录';

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'dshwb-modal' },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, title),
              h('p', { className: 'dshwb-muted dshwb-sm' }, '点目录进入；双击目录直接选中它。'),
            ),
            h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'dshwb-modal-body' },
            h('div', { className: 'dshwb-field' },
              h('label', null, '路径'),
              h('div', { className: 'dshwb-row' },
                h('input', {
                  className: 'dshwb-input', value: manual, style: { flex: 1 },
                  onChange: (e) => setManual(e.target.value),
                }),
                h('button', { className: 'dshwb-btn sm', onClick: () => load(manual) }, '前往'),
              ),
            ),
            h('div', { className: 'dshwb-browser' },
              listing
                ? h('div', null,
                    h('div', { className: 'dshwb-browser-path' }, listing.path || '（根）'),
                    listing.parent
                      ? h('div', { className: 'dshwb-browser-row', onClick: () => load(listing.parent) },
                          h('span', { className: 'name' }, '.. 上一级'))
                      : null,
                    ...(listing.dirs ?? []).map((d) =>
                      h('div', {
                        key: d.path, className: 'dshwb-browser-row',
                        onClick: () => load(d.path),
                        onDoubleClick: () => pick(d.path),
                      },
                        h('span', { className: 'name' }, d.name),
                        h('span', { className: 'dshwb-hint' }, '双击选中'),
                      )),
                  )
                : h('div', { className: 'dshwb-loading' }, '读取中…'),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', { className: 'dshwb-hint ' + hint.kind }, hint.text),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onClose }, '取消'),
              h('button', {
                className: 'dshwb-btn primary',
                onClick: () => pick(manual || listing?.path || ''),
              }, '用这个目录'),
            ),
          ),
        ));
    }
  };
}


/**
 * Client 半片的渲染测试（不需要浏览器）。
 *
 * 用一个最小的 React 替身把组件树摊平取文本：验证槽位注册、插件页的连接卡、
 * 套版方案卡与提交检查卡对格式匠真实返回结构的解析，以及解析失败时的降级文案。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

/* ---------------------------- React 替身 ---------------------------- */

/**
 * 换成 React 替身时也要守住一条：元素类型只能是字符串或函数。
 *
 * 真 React 遇到 `h(SomeElement())` 会直接报 "Element type is invalid ... got: object"，
 * 而宿主把这个错误关进 SlotErrorBoundary，页面上只留一片空白——没有这条断言，
 * 测试全绿、真机全白。
 */
function createElement(type, props, ...children) {
  if (typeof type !== 'string' && typeof type !== 'function') {
    throw new TypeError(`元素类型非法：期望字符串或组件函数，实际是 ${type === null ? 'null' : typeof type}`);
  }
  return { type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) };
}

/**
 * 复刻宿主渲染槽位的方式：直接调用组件函数、拿回元素，再由 React 渲染。
 * 这一层守卫让「在槽位函数里直接用 hook」变成可测的失败，而不是等页面上出现空白。
 */
let renderDepth = 0;

function render(node) {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(render);
  if (typeof node.type === 'function') {
    renderDepth += 1;
    try {
      return render(node.type({ ...node.props, children: node.children }));
    } finally {
      renderDepth -= 1;
    }
  }
  return (node.children || []).flatMap(render);
}

function text(node) {
  return render(node).join(' ');
}

/**
 * hook 只能在 render() 里调用。
 *
 * 默认不启用守卫：工具卡在宿主里是正常渲染的，测试也会直接调用它们拿元素。
 * 需要验证「槽位组件被宿主直接调用」这条契约时（settings.section 就是这样），
 * 把 strict 打开，直接调用若碰了 hook 会立刻失败，而不是等到页面上出现空白。
 */
const hookGuard = { strict: false };

function assertInRender(name) {
  if (!hookGuard.strict) return;
  if (renderDepth === 0) {
    throw new Error(`Invalid hook call：${name} 只能在 React 渲染过程中调用，槽位组件必须是无 hook 的薄壳`);
  }
}

/** 无状态替身：卡片只用 useState 存「只看错误」「已复制」这类开关，一次渲染足够。 */
const React = {
  createElement,
  useState(initial) {
    assertInRender('useState');
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() { assertInRender('useEffect'); },
  useRef(value) { assertInRender('useRef'); return { current: value }; },
};

/**
 * 带 hook 存储的替身：插件页的首帧是「正在读取状态」，要等 /state 的 then 回调
 * 把 setState 写进去，再渲染第二帧才能看到真正的连接卡。
 */
function createHookReact() {
  const slots = [];
  let cursor = 0;
  const react = {
    createElement,
    useState(initial) {
      assertInRender('useState');
      const index = cursor;
      cursor += 1;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useEffect(fn) {
      assertInRender('useEffect');
      const index = cursor;
      cursor += 1;
      if (!slots[index]) slots[index] = { ran: false, cleanup: null };
      if (!slots[index].ran) {
        slots[index].ran = true;
        slots[index].cleanup = fn();
      }
    },
    useRef(value) {
      assertInRender('useRef');
      const index = cursor;
      cursor += 1;
      if (!slots[index]) slots[index] = { value: { current: value } };
      return slots[index].value;
    },
    reset() { cursor = 0; },
  };
  return react;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---------------------------- 装载 ---------------------------- */

function loadClient() {
  let captured = null;
  const g = globalThis;
  const previous = g.window;
  g.window = {
    __ModuleLoader__: {
      load(entry) { captured = entry; },
    },
  };
  const source = fs.readFileSync(clientPath, 'utf8');
  new Function('window', 'require', source)(g.window, (id) => {
    if (id === 'react') return React;
    throw new Error(`未预期的模块：${id}`);
  });
  g.window = previous;
  assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load');
  return captured;
}

function makeSlots() {
  const registrations = [];
  return {
    registrations,
    ctx: {
      effect(fn) { return fn(); },
      slots: {
        inject(name, fn) {
          assert.ok(typeof name === 'string' && name, 'inject 需要槽位名');
          return fn() ?? (() => {});
        },
        register(target, component) {
          registrations.push({ target, component });
          return () => {};
        },
      },
    },
  };
}

function pickCard(name, key, react = React) {
  const entry = loadClient();
  const { ctx, registrations } = makeSlots();
  const module = entry.factory((id) => (id === 'react' ? react : null));
  module.apply(ctx);
  // 槽位标识并不统一：工具卡用 key，设置分节用 id，两种都认。
  const found = registrations.find(
    (item) =>
      item.target.name === name &&
      (key === undefined || item.target.key === key || item.target.id === key)
  );
  assert.ok(found, `没有注册 ${name}${key ? ` / ${key}` : ''}`);
  return found;
}

/** 工具卡的 key 就是工具名。 */
function pickTool(toolName, react) {
  return pickCard('tool.call.toolview', toolName, react).component;
}

/** 把组件函数展开成带标签的树，便于按文案找按钮（render/text 只保留文字）。 */
function expandTree(node) {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(expandTree).filter((child) => child !== null);
  if (typeof node.type === 'function') return expandTree(node.type({ ...node.props, children: node.children }));
  const children = (node.children || []).map(expandTree).filter((child) => child !== null);
  return { tag: node.type, props: node.props, children };
}

/** 在渲染树上找第一个文字包含 label 的按钮，用来点真实按钮而不是直接调内部函数。 */
function buttonByText(tree, label) {
  let found = null;
  const walk = (node) => {
    if (found || node === null || node === undefined) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.tag === 'button' && (node.children || []).some((child) => typeof child === 'string' && child.includes(label))) {
      found = node;
      return;
    }
    (node.children || []).forEach(walk);
  };
  walk(expandTree(tree));
  return found;
}

/** 插件页的状态来自同源接口，替身里直接给一份固定快照。 */
function stubStateFetch(state) {
  const previous = globalThis.fetch;
  const previousInterval = globalThis.setInterval;
  // 轮询会把 Node 的事件循环一直占着，替身里不真的起定时器。
  globalThis.setInterval = () => 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/state')) return { ok: true, json: async () => ({ state }) };
    if (String(url).endsWith('/diagnostics')) return { ok: true, json: async () => ({ text: '格式匠论文助手 0.2.0' }) };
    return { ok: true, json: async () => ({ ok: true, state }) };
  };
  return () => {
    globalThis.fetch = previous;
    globalThis.setInterval = previousInterval;
  };
}

/* ---------------------------- 样本 ---------------------------- */

const EXE = 'D:\\GoRoom\\docx-cli\\bin\\格式匠.exe';

function stateFixture(overrides = {}) {
  return {
    ok: false,
    tone: 'error',
    label: '需要修复',
    detail: '桥接连接断开',
    server: {
      name: 'geshijiang',
      state: 'failed',
      toolCount: 0,
      lastError: 'dial tcp 127.0.0.1:51823: connect: connection refused',
      attempt: 3,
      maxAttempts: 10,
      nextRetryAtMs: 0,
    },
    geshijiang: {
      executable: EXE,
      installationId: 'ins_abc123',
      installationKind: 'dsh',
      dataDir: 'C:\\Users\\20182\\geshijiang-data',
      mcpEnabled: true,
      port: 51823,
      safeWrite: true,
    },
    hints: [],
    pluginVersion: '0.2.0',
    bridge: { transport: 'stdio', skill: 'geshijiang-paper' },
    updatedAt: '2026-11-12T12:00:00.000Z',
    ...overrides,
  };
}

/** 与格式匠 previewLayoutPlan 的真实返回同构。 */
const PLAN_PAYLOAD = {
  schema_version: 1,
  plan: {
    verdict: 'warn',
    version_id: 12,
    layout_config_id: 3,
    cleanup_mode: 'none',
    steps: [
      { module: 'margins', rule: '页边距', target: '全文', action: 'set', affected_count: 48, text_impact: 'none' },
      { module: 'headings', rule: '一级标题', target: '标题', action: 'style', affected_count: 14 },
    ],
    conflicts: [{ severity: 'warning', code: 'MARGIN_CONFLICT', message: '页边距与模板要求的页眉距离冲突' }],
    protected_facts: { sections: 7, tables: 3 },
    paragraph_summary: { body: 380, heading1: 14 },
    requires_review: false,
    diagnostics: [],
  },
  confirmation_token: 'tok_abc123',
  confirmation_expires_in_seconds: 300,
};

/** 与格式匠 runPaperDiagnostic 的真实返回同构（findings 在 run 里）。 */
const DIAGNOSTIC_PAYLOAD = {
  schema_version: 1,
  run: {
    id: 88,
    profile_id: 'thesis-default',
    profile_name: '学位论文',
    paper_name: '县域义务教育资源配置效率研究',
    version_no: 12,
    status: 'completed',
    summary: '共发现 3 个问题',
    findings: [
      { severity: 'error', category: 'figure_caption', message: '图 4-2 题注与正文引用不一致', evidence: [{ source: '正文', paragraph_index: 122, quote: '如图 4-2 所示' }] },
      { severity: 'warning', category: 'references', message: '参考文献 [12] 缺少页码' },
      { severity: 'info', category: 'layout', message: '页眉距边界 1.2 cm，低于模板要求' },
    ],
    report_ids: [5],
    source_changed: false,
  },
  resource_uri: 'geshijiang://diagnostics/88',
};

/* ---------------------------- 用例 ---------------------------- */

test('只注册约定的槽位与工具卡', () => {
  const entry = loadClient();
  assert.equal(entry.id, '@local/geshijiang-assistant');
  const { ctx, registrations } = makeSlots();
  const module = entry.factory((id) => (id === 'react' ? React : null));
  assert.deepEqual(module.inject, ['slots']);
  module.apply(ctx);

  const keys = registrations.map((item) => `${item.target.name}:${item.target.key ?? item.target.id ?? '*'}`);
  assert.deepEqual(keys.sort(), [
    'plugins.bundle.config:@local/geshijiang-assistant',
    'settings.section.icon:geshijiang',
    'settings.section:geshijiang',
    'tool.call.toolview:geshijiang_connect',
    'tool.call.toolview:geshijiang_diagnostics',
    'tool.call.toolview:geshijiang_open',
    'tool.call.toolview:geshijiang_status',
    'tool.call.toolview:mcp__geshijiang__list_findings',
    'tool.call.toolview:mcp__geshijiang__preview_layout_plan',
    'tool.call.toolview:mcp__geshijiang__run_paper_diagnostic',
  ]);
});

test('设置页按三步给出当前卡点与下一步', async () => {
  const react = createHookReact();
  const state = stateFixture();
  // 还没建本机安装：第二步应当是「未完成」，并直接写出该点哪里。
  state.geshijiang.installationId = '';
  state.geshijiang.installationKind = '';
  const restore = stubStateFetch(state);
  try {
    const entry = loadClient();
    const { ctx, registrations } = makeSlots();
    const module = entry.factory((id) => (id === 'react' ? react : null));
    module.apply(ctx);
    const settings = registrations.find((item) => item.target.name === 'settings.section');
    assert.ok(settings, '没有注册 settings.section');
    assert.equal(settings.target.label, '格式匠');
    assert.equal(typeof settings.target.order, 'number');

    // 宿主调用槽位组件时不在 React 渲染里：这里直接调用必须只返回元素、不碰 hook。
    hookGuard.strict = true;
    let element;
    try {
      element = settings.component({});
    } finally {
      hookGuard.strict = false;
    }
    assert.equal(typeof element.type, 'function', '槽位组件应当返回一个元素，而不是自己渲染');

    const icon = registrations.find((item) => item.target.name === 'settings.section.icon');
    assert.ok(icon, '没有注册 settings.section.icon');
    assert.equal(icon.target.id, 'geshijiang', '图标 id 必须等于分节 id，否则不会渲染');
    const iconElement = icon.component({ size: 16, active: false });
    assert.equal(iconElement.type, 'svg');
    assert.equal(iconElement.props.width, 16);

    render(settings.component({}));
    await flush();
    react.reset();
    const body = text(settings.component({}));
    assert.match(body, /格式匠论文助手/);
    assert.match(body, /连接外部助手/);
    assert.match(body, /DeepSeek Harness/, '接入指引要指向能免弹原生框的客户端类型');
    assert.match(body, /信任所选服务/, '接入指引要一并给出执行方式，否则每次写入仍要人工批准');
    assert.match(body, /重新连接/);
    assert.match(body, /在对话里怎么用/);
  } finally {
    restore();
  }
});

test('插件页在连接断开时给出错误原文与「打开格式匠」', async () => {
  const react = createHookReact();
  const restore = stubStateFetch(stateFixture());
  try {
    const page = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
    const props = { view: 'page' };
    // 第一帧挂上 effect 并发出 /state 请求；等回调写完状态再渲染第二帧。
    render(page(props));
    await flush();
    react.reset();
    const rendered = text(page(props));

    assert.match(rendered, /需要修复/);
    assert.match(rendered, /connect: connection refused/);
    assert.match(rendered, /打开格式匠/);
    assert.match(rendered, /重新连接/);
    assert.match(rendered, /复制诊断信息/);
    assert.match(rendered, /ins_abc123/);
    assert.match(rendered, /0\.2\.0/);
    assert.match(rendered, /会自动重连/);

    react.reset();
    const summary = text(page({ view: 'summary' }));
    assert.match(summary, /格式匠接入/);
  } finally {
    restore();
  }
});

test('请求失败时把按钮放回可点状态并说明原因', async () => {
  const react = createHookReact();
  const restore = stubStateFetch(stateFixture());
  try {
    const page = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
    const props = { view: 'page' };
    render(page(props));
    await flush();

    react.reset();
    const tree = page(props);
    const button = buttonByText(tree, '重新连接');
    assert.ok(button, '没有找到「重新连接」按钮');

    // 宿主没响应：fetch 直接失败，按钮不能永久禁用，还要给出可读原因。
    globalThis.fetch = async () => { throw new Error('offline'); };
    button.props.onClick();
    await flush();
    react.reset();
    const after = text(page(props));
    assert.match(after, /请求没有完成，稍后再试/);
    assert.match(after, /重新连接/, '按钮仍然在');
  } finally {
    restore();
  }
});

test('套版方案卡按真实计划字段摊开影响、冲突与受保护内容', () => {
  const PlanCard = pickTool('mcp__geshijiang__preview_layout_plan');
  const result = (payload) => ({ phase: 'result', block: { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] } });

  // 真机返回外面还有一层 { data, status, summary, trace, warnings } 信封。
  const envelope = (payload) => ({ data: payload, status: 'ok', summary: '', trace: {}, warnings: [] });

  const html = text(PlanCard(result(envelope(PLAN_PAYLOAD))));
  assert.match(html, /套版方案/);
  assert.match(html, /有冲突/, 'verdict=warn 要显示成有冲突');
  assert.match(html, /影响段落/);
  assert.match(html, /394 段/, '380 正文 + 14 标题');
  assert.match(html, /页边距与模板要求的页眉距离冲突/);
  assert.match(html, /受保护内容/);
  assert.match(html, /节 7/);
  assert.match(html, /表格 3/);
  assert.match(html, /影响 48 处/);
  assert.match(html, /5 分钟内有效/);
  assert.match(html, /直接创建分支版本/, '有令牌时下一步是直接建分支');
  assert.doesNotMatch(html, /确认套版/, '不再要求用户回复确认才建分支');

  const blocked = text(PlanCard(result(envelope({
    plan: { ...PLAN_PAYLOAD.plan, verdict: 'block' },
    warnings: ['存在阻断问题，未签发 confirmation_token。'],
  }))));
  assert.match(blocked, /已阻断/);
  assert.match(blocked, /没有可用令牌/);

  const broken = text(PlanCard(result('结构快照还没确认')));
  assert.match(broken, /未解析/);
  assert.match(broken, /结构快照还没确认/);
});

test('提交检查卡按 severity 计数，并给出问题定位与两个操作', () => {
  const Card = pickTool('mcp__geshijiang__run_paper_diagnostic');
  const result = (payload) => ({ phase: 'result', block: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });

  // 真机返回带信封，拆包后才能拿到 run.findings。
  const html = text(Card(result({ data: DIAGNOSTIC_PAYLOAD, status: 'ok' })));
  assert.match(html, /提交检查/);
  assert.match(html, /县域义务教育资源配置效率研究/);
  assert.match(html, /v12/);
  assert.match(html, /错误/);
  assert.match(html, /警告/);
  assert.match(html, /提示/);
  assert.match(html, /图 4-2 题注与正文引用不一致/);
  assert.match(html, /正文，段落 122/, '定位来自 evidence 的来源与段落序号');
  assert.match(html, /只看错误/, '有错误时给出筛选');
  assert.match(html, /在格式匠中查看报告/);
  assert.match(html, /复制运行 ID/);

  // 源文件在检查后又变过：必须明确说不能当作当前文件的结论。
  const stale = text(Card(result({ data: { run: { ...DIAGNOSTIC_PAYLOAD.run, source_changed: true } }, status: 'ok' })));
  assert.match(stale, /不能当作当前文件的结论/);
});

test('真实返回里的 fail 归入错误，未知 severity 不悄悄消失', () => {
  const Card = pickTool('mcp__geshijiang__run_paper_diagnostic');
  const result = (payload) => ({ phase: 'result', block: { content: [{ type: 'text', text: JSON.stringify({ data: payload, status: 'ok' }) }] } });

  const html = text(Card(result({
    run: {
      id: 7,
      status: 'completed',
      findings: [
        { severity: 'fail', message: '参考文献区混入了致谢' },
        { severity: 'warn', message: '未检测到自动目录域。' },
        { severity: 'weird', message: '来自未来的严重级别' },
      ],
    },
  })));
  assert.match(html, /1 错误/, 'fail 要算进错误');
  assert.match(html, /1 警告/);
  assert.match(html, /1 其他/, '未知级别单独成栏，而不是被丢掉');
  assert.match(html, /只看错误/, '有错误时出现筛选');
});

test('问题清单入口用同一张卡，计数与列表不另起一套', () => {
  const Card = pickTool('mcp__geshijiang__list_findings');
  const html = text(Card({
    phase: 'result',
    block: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          data: {
            run_id: 88,
            items: [
              { severity: 'error', message: '参考文献 [3] 的页码与正文不符' },
              { severity: 'info', message: '共 2 条问题' },
            ],
            resource_uri: 'geshijiang://diagnostics/88',
          },
          status: 'ok',
        }),
      }],
    },
  }));
  assert.match(html, /参考文献 \[3\] 的页码与正文不符/);
  assert.match(html, /复制运行 ID/);
});

test('没有解析出结构时退回原文，不编造字段', () => {
  const Card = pickTool('mcp__geshijiang__run_paper_diagnostic');
  const broken = text(Card({ phase: 'result', block: { content: [{ type: 'text', text: '检查已提交，稍后用 list_findings 读取' }] } }));
  assert.match(broken, /未解析/);
  assert.match(broken, /检查已提交/);
});

test('状态类工具只显示一行，不在对话里铺开', () => {
  const status = pickTool('geshijiang_status');
  const row = text(status({ phase: 'result', block: { content: [{ type: 'text', text: '格式匠：已连接（32 个工具可用）' }] } }));
  assert.match(row, /格式匠状态/);
  assert.match(row, /32 个工具可用/);

  const diagnostics = pickTool('geshijiang_diagnostics');
  const line = text(diagnostics({ phase: 'result', block: { content: [{ type: 'text', text: '格式匠论文助手 0.2.0' }] } }));
  assert.match(line, /格式匠诊断/);
});


test('断开时按自动重连进度说明还要不要等', async () => {
  async function renderWith(state) {
    const react = createHookReact();
    const restore = stubStateFetch(state);
    try {
      const page = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
      const props = { view: 'page' };
      render(page(props));
      await flush();
      react.reset();
      return text(page(props));
    } finally {
      restore();
    }
  }

  const waiting = await renderWith(stateFixture({
    auto: { enabled: true, attempts: 1, max: 3, exhausted: false, nextAtMs: Date.now() + 30_000 },
  }));
  assert.match(waiting, /秒后自动重连（第 2 次）/);

  const stopped = await renderWith(stateFixture({
    auto: { enabled: true, attempts: 3, max: 3, exhausted: true, nextAtMs: 0 },
  }));
  assert.match(stopped, /自动重连已停止/);

  const base = stateFixture();
  const updating = await renderWith(stateFixture({
    geshijiang: { ...base.geshijiang, updating: true },
    auto: { enabled: true, attempts: 0, max: 3, exhausted: false, nextAtMs: 0 },
  }));
  assert.match(updating, /正在安装更新/);
});

test('连上之后列出工具、资源与提示词，读不到时说明原因', async () => {
  async function renderWith(state) {
    const react = createHookReact();
    const restore = stubStateFetch(state);
    try {
      const page = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
      const props = { view: 'page' };
      render(page(props));
      await flush();
      react.reset();
      return text(page(props));
    } finally {
      restore();
    }
  }

  const base = stateFixture();
  const connected = {
    ...base,
    tone: 'ok',
    label: '已连接',
    detail: '50 个工具可用',
    server: { ...base.server, state: 'connected', toolCount: 50, lastError: '', attempt: 0, maxAttempts: 0 },
    catalog: {
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      stale: false,
      error: '',
      data: {
        server: { name: '格式匠 MCP 聚合网关', version: '1.0.58' },
        protocolVersion: '2026-07-28',
        tools: [{ name: 'list_papers', description: '列出论文' }],
        resources: [{ uri: 'geshijiang://paper/1', name: '论文 1' }],
        resourceTemplates: [{ uriTemplate: 'geshijiang://paper/{id}', name: '论文' }],
        prompts: [{ name: 'geshijiang/thesis' }],
        truncated: false,
        durationMs: 89,
      },
    },
  };

  const listed = await renderWith(connected);
  assert.match(listed, /连接后获得/);
  assert.match(listed, /工具 1/);
  assert.match(listed, /固定资源 1/);
  assert.match(listed, /list_papers/);
  assert.match(listed, /1\.0\.58/);
  assert.match(listed, /2026-07-28/);

  const broken = await renderWith({
    ...connected,
    catalog: { fetchedAt: new Date().toISOString(), ageMs: 0, stale: false, error: 'geshijiang mcp describe: 未知子命令', data: null },
  });
  assert.match(broken, /未知子命令/);
  assert.match(broken, /升级/);
});

test('已连接时给出「断开连接」，断开后换成恢复提示', async () => {
  async function renderWith(state) {
    const react = createHookReact();
    const restore = stubStateFetch(state);
    try {
      const page = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
      const props = { view: 'page' };
      render(page(props));
      await flush();
      react.reset();
      return text(page(props));
    } finally {
      restore();
    }
  }

  const base = stateFixture();
  const connected = {
    ...base,
    tone: 'ok',
    label: '已连接',
    detail: '50 个工具可用',
    server: { ...base.server, state: 'connected', toolCount: 50, lastError: '' },
  };
  const online = await renderWith(connected);
  assert.match(online, /断开连接/);

  const offline = await renderWith({
    ...connected,
    tone: 'idle',
    label: '已断开',
    detail: '手动断开，点「重新连接」恢复',
    paused: true,
    server: { ...base.server, state: 'unmounted', toolCount: 0, lastError: '' },
  });
  assert.doesNotMatch(offline, /断开连接/);
  assert.match(offline, /重新连接/);
  assert.match(offline, /已手动断开/);
});

test('读不到状态时给出原因与重试，而不是一直停在「正在读取」', async () => {
  const react = createHookReact();
  const previousFetch = globalThis.fetch;
  const previousInterval = globalThis.setInterval;
  // 轮询会把进程吊住；这里只验证首帧失败后的呈现。
  globalThis.setInterval = () => 0;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  try {
    const page = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
    const props = { view: 'page' };
    render(page(props));
    await flush();
    react.reset();
    const rendered = text(page(props));

    assert.doesNotMatch(rendered, /正在读取格式匠状态/, '失败后不应继续显示「正在读取」');
    assert.match(rendered, /读不到格式匠状态/);
    assert.match(rendered, /HTTP 404/);
    assert.match(rendered, /重试/);
    assert.match(rendered, /内置插件/, '要告诉用户先去哪儿看插件状态');
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setInterval = previousInterval;
  }
});

test('设置页读不到状态时也把原因写出来', async () => {
  const react = createHookReact();
  const previousFetch = globalThis.fetch;
  const previousInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  globalThis.fetch = async () => {
    const error = new Error('offline');
    throw error;
  };
  try {
    const settings = pickCard('settings.section', 'geshijiang', react).component;
    render(settings({}));
    await flush();
    react.reset();
    const rendered = text(settings({}));

    assert.match(rendered, /读不到格式匠状态/);
    assert.match(rendered, /offline/);
    assert.match(rendered, /重试/);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setInterval = previousInterval;
  }
});

test('端口没在听时清单写「当前未监听」，不把配置当成已就绪', async () => {
  const react = createHookReact();
  const fixture = stateFixture();
  fixture.geshijiang.listening = false;
  const restore = stubStateFetch(fixture);
  try {
    const settings = pickCard('settings.section', 'geshijiang', react).component;
    render(settings({}));
    await flush();
    react.reset();
    const rendered = text(settings({}));

    assert.match(rendered, /当前未监听/, '标题要把「配置开了」和「真的在听」分开');
    assert.match(rendered, /没有监听/, '要说明端口没有监听、格式匠可能没在运行');
  } finally {
    restore();
  }
});

test('端口在听时清单不加「未监听」，也不改标题', async () => {
  const react = createHookReact();
  const fixture = stateFixture();
  fixture.geshijiang.listening = true;
  const restore = stubStateFetch(fixture);
  try {
    const settings = pickCard('settings.section', 'geshijiang', react).component;
    render(settings({}));
    await flush();
    react.reset();
    const rendered = text(settings({}));

    assert.doesNotMatch(rendered, /当前未监听/);
  } finally {
    restore();
  }
});

test('桥接交给预设时，设置页说清在哪用，并带上预设里最近的状态', async () => {
  const react = createHookReact();
  const state = stateFixture({
    mountScope: 'preset',
    ok: true,
    tone: 'ok',
    label: '已连接',
    detail: '110 个工具可用（「格式匠」预设 · 刚刚）',
    server: { name: 'geshijiang', state: 'unmounted', toolCount: 0, lastError: '', attempt: 0, maxAttempts: 0, nextRetryAtMs: 0 },
    presetBridge: { state: 'connected', toolCount: 110, lastError: '', at: Date.now() },
  });
  const restore = stubStateFetch(state);
  try {
    const entry = loadClient();
    const { ctx, registrations } = makeSlots();
    const module = entry.factory((id) => (id === 'react' ? react : null));
    module.apply(ctx);
    const settings = registrations.find((item) => item.target.name === 'settings.section');
    render(settings.component({}));
    await flush();
    react.reset();
    const body = text(settings.component({}));

    assert.match(body, /「格式匠」预设/);
    assert.match(body, /110 个工具可用/);
    // 预设模式下这两个按钮按了也没用，不该出现。
    assert.ok(!body.includes('重新连接'), body);
    assert.ok(!body.includes('断开连接'), body);
    assert.match(body, /打开格式匠/);
  } finally {
    restore();
  }
});

test('预设里没有记录时，插件页不画红灯，改说明去哪儿用', async () => {
  const react = createHookReact();
  const state = stateFixture({
    mountScope: 'preset',
    tone: 'idle',
    label: '由预设提供',
    detail: '桥接由「格式匠」预设提供',
    server: { name: 'geshijiang', state: 'unmounted', toolCount: 0, lastError: '', attempt: 0, maxAttempts: 0, nextRetryAtMs: 0 },
    presetBridge: null,
  });
  const restore = stubStateFetch(state);
  try {
    const card = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
    const props = { view: 'card' };
    render(card(props));
    await flush();
    react.reset();
    const body = text(card(props));

    assert.match(body, /桥接由「格式匠」预设提供/);
    // 「未挂载」是配置结果：不能再出现「桥接没有挂上，按下面的按钮重新连接」这类待修文案。
    assert.ok(!body.includes('桥接没有挂上'), body);
    assert.match(body, /由「格式匠」预设提供/);
  } finally {
    restore();
  }
});

/**
 * 官方 mcp 客户端不写交接记录，预设里那条「已连接」永远不存在：第三步不能因此
 * 一直显示未完成。机器三步齐了（usable）就该标成就绪，剩下的只是去预设会话里用。
 */
test('预设里没有交接记录时，设置页按宿主通道把这步标成就绪', async () => {
  async function renderWith(state) {
    // 每个 fixture 都要用新的 hook 替身：它按调用顺序复用 slot，换状态会读到上一份。
    const react = createHookReact();
    const restore = stubStateFetch(state);
    try {
      const settings = pickCard('settings.section', 'geshijiang', react).component;
      render(settings({}));
      await flush();
      react.reset();
      return text(settings({}));
    } finally {
      restore();
    }
  }

  const ready = await renderWith(stateFixture({
    mountScope: 'preset',
    usable: true,
    tone: 'idle',
    label: '由预设提供',
    detail: '',
    server: { name: 'geshijiang', state: 'unmounted', toolCount: 0, lastError: '', attempt: 0, maxAttempts: 0, nextRetryAtMs: 0 },
    presetBridge: null,
  }));
  assert.match(ready, /本机已就绪，在「格式匠」预设的会话里使用/);
  assert.match(ready, /宿主工具（附件、会话）不经过桥接/);

  // 配置不全（缺安装 ID，宿主算出的 usable 为假）时不能谎报就绪。
  const missing = await renderWith(stateFixture({
    mountScope: 'preset',
    usable: false,
    tone: 'idle',
    label: '由预设提供',
    detail: '',
    server: { name: 'geshijiang', state: 'unmounted', toolCount: 0, lastError: '', attempt: 0, maxAttempts: 0, nextRetryAtMs: 0 },
    presetBridge: null,
    geshijiang: { executable: EXE, installationId: '', installationKind: '', dataDir: '', mcpEnabled: true, port: 0 },
  }));
  assert.doesNotMatch(missing, /本机已就绪/);
  assert.match(missing, /在「格式匠」预设的会话里使用/);
});

/**
 * mountScope: off 是用户自己选的配置，不是故障：面板不能画成「桥接没有挂上、点重新连接」，
 * 那个按钮在 off 模式下按了也只会回一句配置说明。
 */
test('mountScope: off 时面板说清是配置选择，不给按不动的重连按钮', async () => {
  const react = createHookReact();
  const state = stateFixture({
    mountScope: 'off',
    tone: 'idle',
    label: '桥接已关闭',
    detail: '',
    server: { name: 'geshijiang', state: 'unmounted', toolCount: 0, lastError: '', attempt: 0, maxAttempts: 0, nextRetryAtMs: 0 },
    presetBridge: null,
  });
  const restore = stubStateFetch(state);
  try {
    const card = pickCard('plugins.bundle.config', '@local/geshijiang-assistant', react).component;
    const props = { view: 'page' };
    render(card(props));
    await flush();
    react.reset();
    const body = text(card(props));

    assert.match(body, /mountScope: off/);
    assert.ok(!body.includes('桥接没有挂上'), body);
    assert.ok(!body.includes('重新连接'), body);
    // 宿主工具不受影响这件事要说出来，别让用户以为整个插件废了。
    assert.match(body, /宿主工具（附件、会话）不受影响/);
  } finally {
    restore();
  }
});

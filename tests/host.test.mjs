/**
 * Host 半片的装配测试（不需要 DSH 运行时）。
 *
 * 覆盖：桥接条目参数、三个工具、系统提示节、命令、面板接口的授权与错误分支，
 * 以及「找不到程序 / 找不到安装」时仍然挂载但报错的状态。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as plugin from '../index.js';

const EXE = 'D:\\GoRoom\\docx-cli\\bin\\格式匠.exe';

/**
 * 造一个宿主替身。
 *
 * @param {{missing?: string[]}} options - 模拟「服务还没起来」：列在这里的服务
 *   既不在 ctx 上，get() 也拿不到，用来验证插件不会因此停止装配。
 */
function makeCtx({ missing = [], loader = null, baseUrl = '', pluginStatus = null } = {}) {
  const record = {
    tools: [],
    mounts: [],
    unmounts: 0,
    prompts: [],
    commands: [],
    skills: [],
    routes: [],
    effects: [],
    disposers: [],
    effectHandles: [],
    warnings: [],
  };
  let live = 0;
  const serverView = { name: 'formatjiang', configured: true, status: { state: 'connected', toolCount: 32, connectedAt: Date.now() } };
  const ctx = {
    logger: {
      warn: (msg) => record.warnings.push(String(msg)),
      error: (msg) => record.warnings.push(String(msg)),
    },
    tools: {
      register(definition) {
        record.tools.push(definition);
        return () => {};
      },
    },
    mcpManager: {
      register(name, entry) {
        record.mounts.push({ name, entry });
        live += 1;
        return () => {
          live -= 1;
          record.unmounts += 1;
        };
      },
      list() {
        // 用「还活着的注册数」判断：卸载之后列表必须为空，否则断开态测不出来。
        return live > 0 ? [serverView] : [];
      },
      restart() {},
      probe() {},
      watch() { return () => {}; },
    },
    get(service) {
      if (missing.includes(service)) return undefined;
      if (service === 'systemPrompt') {
        return {
          section(section) {
            record.prompts.push(section);
            return () => {};
          },
        };
      }
      if (service === 'commands') {
        return {
          register(command) {
            record.commands.push(command);
            return () => {};
          },
        };
      }
      if (service === 'skills') {
        return {
          register(skill) {
            record.skills.push(skill);
            return () => {};
          },
        };
      }
      if (service === 'webServer') {
        return {
          getOrigin: () => 'http://127.0.0.1:5173',
          register(route) {
            record.routes.push(route);
            return () => {};
          },
        };
      }
      // 插件可能走 ctx.get 读服务（不 inject 时唯一不抛错的路），与属性同源。
      if (service === 'mcpManager') return ctx.mcpManager;
      if (service === 'loader') return loader === null ? undefined : loader;
      return undefined;
    },
    effect(fn, label) {
      record.effects.push(label);
      const dispose = fn();
      record.effectHandles.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} });
      if (typeof dispose === 'function') record.disposers.push(dispose);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    /**
     * 预设作用域那一份会用 ctx.plugin 自己挂 mcp 客户端。
     * 句柄给 await()/dispose()/statusCell，够插件把状态与卸载走完。
     */
    plugin(pluginObject, config) {
      record.plugins = record.plugins || [];
      record.plugins.push({ pluginObject, config });
      let current = pluginStatus
        ? { ...pluginStatus }
        : { state: 'connected', toolCount: 3, connectedAt: Date.now() };
      const listeners = [];
      const handle = {
        statusCell: {
          current: () => current,
          closure: () => ({ closeConfirmed: true }),
          onChange: (fn) => {
            listeners.push(fn);
            return () => {
              const index = listeners.indexOf(fn);
              if (index >= 0) listeners.splice(index, 1);
            };
          },
        },
        disposed: 0,
        /** 用例里把状态改成 failed 等，模拟桥接中途断掉。 */
        fire(status) {
          current = status;
          for (const fn of [...listeners]) fn(status);
        },
        listenerCount: () => listeners.length,
        async await() {},
        async dispose() { handle.disposed += 1; },
      };
      record.lastPluginHandle = handle;
      return handle;
    },
    /**
     * 宿主 cordis 的 ctx.inject：依赖齐了才执行回调，服务变化会重跑。
     * 测试里服务都是现成的，所以同步执行；缺服务时不执行（与真实行为一致）。
     */
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps || {});
      const missing = names.filter((name) => ctx[name] === undefined && ctx.get(name) === undefined);
      if (missing.length) {
        record.skippedInjects = (record.skippedInjects || []).concat([{ names, missing }]);
        return () => {};
      }
      const label = `inject:${names.join(',')}`;
      record.effects.push(label);
      const dispose = callback(ctx);
      const handle = typeof dispose === 'function' ? dispose : () => {};
      record.effectHandles.push({ label, dispose: handle });
      record.disposers.push(handle);
      return handle;
    },
  };
  // mcpManager 用属性挂在 ctx 上，缺服务时把它摘掉，模拟宿主还没提供。
  if (missing.includes('mcpManager')) ctx.mcpManager = undefined;
  // 插件加载器的 baseUrl 一般由宿主继承下来；用例里显式给才知道拼出来的 parent 是什么。
  if (baseUrl !== '') ctx.baseUrl = baseUrl;
  return { ctx, record, serverView };
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const listeners = new Map();
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      listeners.set(event, handler);
      return request;
    },
    destroy() {},
  };
  if (body) {
    setTimeout(() => {
      listeners.get('data')?.(Buffer.from(body, 'utf8'));
      listeners.get('end')?.();
    }, 0);
  } else {
    setTimeout(() => listeners.get('end')?.(), 0);
  }
  return request;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { res.headers[key] = value; },
    end(chunk) { res.body = String(chunk ?? ''); },
  };
  return res;
}

async function call(route, options) {
  const res = fakeRes();
  await route.handler(fakeReq(options), res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

test('挂载参数与工具面符合桥接契约', () => {
  assert.equal(plugin.name, 'formatjiang-assistant');
  // 只有 tools 是硬依赖：mcpManager/webServer 改成「等到了再装配」，
  // 否则服务晚启动时整个插件会停在 pending，工具与面板一起消失。
  assert.deepEqual(plugin.inject, ['tools']);
  assert.ok(fs.existsSync(EXE), `测试用的格式匠程序不存在：${EXE}`);

  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0001' });
  assert.equal(record.mounts.length, 1);
  assert.equal(record.mounts[0].name, 'formatjiang');
  assert.equal(record.mounts[0].entry.transport, 'stdio');
  assert.equal(record.mounts[0].entry.command, EXE);
  assert.deepEqual(record.mounts[0].entry.args, ['mcp', 'bridge', '--installation-id', 'ins_test0001']);
  assert.equal(record.mounts[0].entry.startupTimeoutMs, 90000);
  assert.equal(record.mounts[0].entry.toolCallTimeoutMs, 270000);

  assert.deepEqual(
    record.tools.map((tool) => tool.name),
    ['formatjiang_status', 'formatjiang_connect', 'formatjiang_disconnect', 'formatjiang_open', 'formatjiang_diagnostics', 'formatjiang_catalog', 'formatjiang_stage_attachment', 'formatjiang_session', 'formatjiang_import_document', 'formatjiang_receive_manuscript', 'formatjiang_use_attachments', 'formatjiang_save_file'],
  );
  for (const tool of record.tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.type, 'json');
  }

  assert.equal(record.prompts.length, 1);
  assert.equal(record.prompts[0].interpolate, false);
  assert.match(record.prompts[0].text, /mcp__formatjiang__/);

  assert.equal(record.commands.length, 1);
  assert.equal(record.commands[0].name, 'formatjiang');
});

/**
 * 复刻宿主装配系统提示词时对 section 的那条链。
 *
 * 上游：@deepseek-ai/dsh-system-prompt/src/index.ts 的 renderPrompt()（约 297-302 行）——
 *   sections.map(s => s.interpolate === false ? s.text : interpolate(s, ...))
 *           .filter(text => text.length > 0).join('\n\n')
 * 调用点：@deepseek-ai/dsh-agent-loop/src/agent.ts（每轮 generate 前）。
 * 宿主只认 section.text；写成别的字段名就会在 text.length 上抛
 * "Cannot read properties of undefined (reading 'length')"，表现为「一发消息就报错」。
 * 这里保留同一条链的写法，让字段名写错时测试直接复现宿主的崩溃。
 */
function renderPromptLikeHost(sections) {
  return sections
    // 宿主对 interpolate:false 的分节原样取 section.text；其余分节进 interpolate()，
    // 那里的第一行同样是 const text = input.text。
    .map((section) => section.text)
    .filter((text) => text.length > 0)
    .join('\n\n');
}

test('系统提示节符合宿主的 PromptSection 契约', () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0004' });

  assert.equal(record.prompts.length, 1);
  const section = record.prompts[0];
  assert.equal(typeof section.name, 'string');
  assert.equal(typeof section.order, 'number');
  assert.equal(section.interpolate, false);
  assert.equal(typeof section.text, 'string', '宿主只读 section.text');
  assert.ok(section.text.length > 0);
  assert.equal(section.content, undefined, 'content 不是宿主字段，写了也读不到');

  const rendered = renderPromptLikeHost(record.prompts);
  assert.match(rendered, /mcp__formatjiang__/);
  assert.doesNotMatch(rendered, /\bundefined\b/);
});

test('宿主 renderPrompt 契约：分节缺 text 时会以 reading "length" 崩溃', () => {
  // 复现线上症状，保证上面那个复刻函数没有跑偏：宿主不会在注册时报错，
  // 只会在下一轮装配系统提示词时抛 TypeError。
  assert.throws(
    () => renderPromptLikeHost([{ name: 'x', order: 1, interpolate: false }]),
    /Cannot read properties of undefined \(reading 'length'\)/,
  );
});

test('配置里写的程序路径无效时回退到安装位置', () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: 'D:\\nope\\不存在.exe', installationId: 'ins_test0002' });
  assert.equal(record.mounts.length, 1, '应当回退到自动发现到的格式匠程序');
  const command = record.mounts[0].entry.command;
  assert.ok(command.endsWith('格式匠.exe'), `发现到的程序不对：${command}`);
  assert.ok(fs.existsSync(command));
});

test('找不到可用安装时不挂载，并把原因写清楚', async () => {
  const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-empty-'));
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: '', dataDir: emptyDataDir });
  assert.equal(record.mounts.length, 0);
  const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
  const value = await status.execute({});
  assert.equal(value.ok, false);
  assert.match(value.text, /没有找到格式匠数据库/);
  assert.ok(value.hints.some((hint) => hint.includes(emptyDataDir)));
  fs.rmSync(emptyDataDir, { recursive: true, force: true });
});

test('面板接口只服务本机同源页面', async () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0003' });
  const route = record.routes.find((item) => item.path === '/formatjiang/api');
  assert.ok(route, '没有注册 /formatjiang/api');
  assert.equal(route.kind, 'prefix');

  const state = await call(route, { url: '/formatjiang/api/state', headers: { host: '127.0.0.1:5173' } });
  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.state.label, '已连接');
  assert.equal(state.json.state.server.toolCount, 32);

  const sameOrigin = await call(route, {
    method: 'POST',
    url: '/formatjiang/api/connect',
    headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
    body: '{"restart":true}',
  });
  assert.equal(sameOrigin.status, 200);
  assert.ok(sameOrigin.json.ok);

  const crossOrigin = await call(route, {
    url: '/formatjiang/api/state',
    headers: { host: '127.0.0.1:5173', origin: 'http://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);

  const remoteHost = await call(route, { url: '/formatjiang/api/state', headers: { host: 'evil.example' } });
  assert.equal(remoteHost.status, 403);

  const missing = await call(route, { method: 'POST', url: '/formatjiang/api/nothing', headers: { host: '127.0.0.1:5173' }, body: '{}' });
  assert.equal(missing.status, 404);
});

test('工作流技能符合宿主的运行时技能契约', () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0005' });

  assert.equal(record.skills.length, 1);
  const skill = record.skills[0];
  // 上游：@deepseek-ai/dsh-skill 的 validateRuntimeSkill() 只校验名字、描述与 invocation；
  // source/content 在 list()/get() 时按 SkillDefinition 校验，source 是必填字段。
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(skill.description.length > 0);
  assert.equal(skill.source, 'runtime');
  assert.equal(typeof skill.content, 'string');
  assert.ok(skill.content.length > 200);
  assert.match(skill.content, /preview_layout_plan/);
  assert.match(skill.content, /run_paper_diagnostic/);
  assert.equal(skill.invocation, undefined, '不传就用宿主默认：模型与用户都可调用');
});

test('诊断信息只含状态与路径，不含令牌', async () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0006' });
  const tool = record.tools.find((item) => item.name === 'formatjiang_diagnostics');
  const value = await tool.execute({});
  assert.match(value.text, /格式匠论文助手/);
  assert.match(value.text, /ins_test0006/);
  assert.ok(value.text.includes(EXE), `诊断信息里缺少程序路径：${value.text}`);
  assert.match(value.text, /桥接：stdio/);
  assert.doesNotMatch(value.text, /token/i);

  const route = record.routes.find((item) => item.path === '/formatjiang/api');
  const diagnostics = await call(route, { url: '/formatjiang/api/diagnostics', headers: { host: '127.0.0.1:5173' } });
  assert.equal(diagnostics.status, 200);
  assert.match(diagnostics.json.text, /接入状态/);
});

test('命令支持诊断与重连两个参数', () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0007' });
  const command = record.commands[0];
  assert.match(command.input.hint, /诊断/);

  const doctor = command.handler({ rawInput: ' 诊断 ' });
  assert.equal(doctor.kind, 'success');
  assert.match(doctor.text, /格式匠论文助手/);

  const reconnect = command.handler({ rawInput: '重连' });
  assert.equal(reconnect.kind, 'success');
  assert.equal(record.unmounts, 1, '重连应当先卸载旧连接');

  const plain = command.handler({ rawInput: '' });
  assert.match(plain.text, /格式匠：/);
});

test('打开失败不抛未捕获异常，而是变成可读的错误', async () => {
  // 指向一个存在但不可执行的文本文件：spawn 会以同步异常或 'error' 事件失败，
  // 两种都必须被接住——没接住的话整个宿主进程会崩。
  const bogus = path.join(os.tmpdir(), `fj-bogus-${process.pid}.txt`);
  fs.writeFileSync(bogus, 'not an executable');
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: bogus, installationId: 'ins_test0008' });
    const open = record.tools.find((item) => item.name === 'formatjiang_open');
    const value = await open.execute({});
    assert.equal(value.ok, false);
    assert.match(value.text, /打开格式匠失败/);

    // 失败原因要进状态，不能只留在一次返回值里。
    const status = record.tools.find((item) => item.name === 'formatjiang_status');
    const snap = await status.execute({});
    assert.ok(snap.hints.some((hint) => /打开格式匠失败/.test(hint)), `状态里缺少打开失败：${JSON.stringify(snap.hints)}`);
  } finally {
    fs.rmSync(bogus, { force: true });
  }
});

test('打开格式匠会等到端口就绪，并在状态里立刻体现', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-open-ready-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port }), 'utf8');
  try {
    const { ctx, record } = makeCtx();
    // 用 node 自己当「桌面程序」：stdio 被忽略，进程起来就退，不会真的打开窗口。
    plugin.apply(ctx, { executablePath: process.execPath, installationId: 'ins_open_ready', dataDir: dir, autoReconnect: false });
    const open = record.tools.find((item) => item.name === 'formatjiang_open');
    // spawn 的调用被替身记了下来：拉起桌面时必须带「后台」环境变量，
    // 否则模型一调工具就把窗口弹到最前面挡住用户。
    globalThis.__fjSpawnCalls = [];
    const value = await open.execute({});
    assert.equal(value.ok, true, value.text);
    assert.match(value.text, new RegExp(`端口 ${port} 已经在听`));
    const launched = (globalThis.__fjSpawnCalls || []).find((item) => item.file === process.execPath);
    assert.ok(launched, `没有拉起桌面程序：${JSON.stringify(globalThis.__fjSpawnCalls)}`);
    assert.equal(launched.options?.env?.FORMATJIANG_LAUNCH_BACKGROUND, '1', '拉起桌面时必须声明后台启动');

    // 刚测到的事实要写进状态，紧接着的状态查询不能再报旧值。
    const status = record.tools.find((item) => item.name === 'formatjiang_status');
    const snap = await status.execute({});
    assert.equal(snap.formatjiang.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('两个会话同时打开时只启动一次，后到的复用同一次结果', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-open-once-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port }), 'utf8');
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: process.execPath, installationId: 'ins_open_once', dataDir: dir, autoReconnect: false });
    const open = record.tools.find((item) => item.name === 'formatjiang_open');
    const [first, second] = await Promise.all([open.execute({}), open.execute({})]);
    assert.equal(first, second, '两次调用应当复用同一个结果对象');
    assert.equal(first.ok, true, first.text);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('打开后端口等不到就绪时照实说，不把「已请求」讲成「已就绪」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-open-slow-'));
  // 先占一个端口再关掉：配置里写的是「没人听」的端口。
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port }), 'utf8');
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: process.execPath, installationId: 'ins_open_slow', dataDir: dir, autoReconnect: false });
    const open = record.tools.find((item) => item.name === 'formatjiang_open');
    const value = await open.execute({});
    assert.equal(value.ok, false, value.text);
    assert.match(value.text, /没有就绪/);
    assert.match(value.text, /formatjiang_status/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('面板请求体超限返回 413，且不触发重连', async () => {  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0009' });
  const route = record.routes[0];
  const oversized = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
  const result = await call(route, {
    method: 'POST',
    url: '/formatjiang/api/connect',
    headers: { host: '127.0.0.1:5173', 'content-type': 'application/json' },
    body: oversized,
  });
  assert.equal(result.status, 413);
  assert.equal(record.mounts.length, 1, '请求体被拒时不应该去重建连接');
});

test('挂载失败只报错，再次重连可以恢复', async () => {
  const { ctx, record } = makeCtx();
  const realRegister = ctx.mcpManager.register;
  let first = true;
  ctx.mcpManager.register = (name, entry) => {
    if (first) {
      first = false;
      throw new Error('server name already exists');
    }
    return realRegister(name, entry);
  };

  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0010' });
  const status = record.tools.find((item) => item.name === 'formatjiang_status');
  const failed = await status.execute({});
  assert.equal(failed.ok, false);
  assert.match(failed.text, /需要修复|already exists/);

  const connect = record.tools.find((item) => item.name === 'formatjiang_connect');
  const recovered = await connect.execute({});
  assert.equal(recovered.ok, true);
  assert.equal(record.mounts.filter((item) => item.name === 'formatjiang').length, 1);
});

/* ------------------------- 自动重连 ------------------------- */

/** 捕获宿主侧的 setInterval，让测试手动推进守护定时器。 */
function captureTimers(fn) {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const timers = [];
  globalThis.setInterval = (cb, ms) => {
    const handle = { cb, ms, unref() { return handle; } };
    timers.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { if (handle) handle.cleared = true; };
  try {
    return fn(timers);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

/** 固定时钟，避免依赖真实等待。 */
function withClock(start, fn) {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    return fn({ advance: (ms) => { now += ms; } });
  } finally {
    Date.now = realNow;
  }
}

test('桥接 failed 后按退避自动重连，连上清零，次数用尽即停', () => {
  captureTimers((timers) => withClock(1_700_000_000_000, (clock) => {
    const { ctx, record, serverView } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto001' });
    assert.equal(record.mounts.length, 1);
    assert.equal(timers.length, 1, '只应起一个守护定时器');
    const tick = timers[0].cb;

    serverView.status = { state: 'connecting', attempt: 2 };
    tick();
    assert.equal(record.mounts.length, 1, '宿主还在自己重试时不要插手');

    serverView.status = { state: 'failed', lastError: 'Connection closed' };
    tick();
    assert.equal(record.mounts.length, 2, 'failed 之后重挂一次');
    assert.equal(record.unmounts, 1, '重挂前先卸掉失败的那条');

    tick();
    assert.equal(record.mounts.length, 2, '退避未到不连点');

    clock.advance(30_000);
    tick();
    assert.equal(record.mounts.length, 3);

    clock.advance(60_000);
    tick();
    assert.equal(record.mounts.length, 4);

    clock.advance(60_000);
    tick();
    assert.equal(record.mounts.length, 4, '本轮三次用尽后不再尝试');

    serverView.status = { state: 'connected', toolCount: 50 };
    tick();
    serverView.status = { state: 'failed', lastError: 'Connection closed' };
    clock.advance(15_000);
    tick();
    assert.equal(record.mounts.length, 5, '恢复后再断开，从第一次重新开始');
  }));
});

test('用户完全退出格式匠时不自作主张拉起', () => {
  captureTimers((timers) => withClock(1_700_000_000_000, () => {
    const { ctx, record, serverView } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto002' });
    serverView.status = { state: 'failed', lastError: '格式匠已由用户完全退出，本次不会自动打开' };
    for (let i = 0; i < 5; i += 1) timers[0].cb();
    assert.equal(record.mounts.length, 1);
  }));
});

test('关掉 autoReconnect 就不起守护定时器', () => {
  captureTimers((timers) => {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto003', autoReconnect: false });
    assert.equal(timers.length, 0);
    assert.equal(record.mounts.length, 1);
  });
});

test('状态接口给出自动重连进度', async () => {
  captureTimers((timers) => withClock(1_700_000_000_000, (clock) => {
    const { ctx, record, serverView } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto004' });
    const route = record.routes.find((item) => item.path === '/formatjiang/api');
    return (async () => {
      let body = await call(route, {});
      assert.equal(body.json.state.auto.enabled, true);
      assert.equal(body.json.state.auto.attempts, 0);

      serverView.status = { state: 'failed', lastError: 'Connection closed' };
      timers[0].cb();
      clock.advance(30_000);
      body = await call(route, {});
      assert.equal(body.json.state.auto.attempts, 1);
      assert.ok(body.json.state.auto.nextAtMs > 0, '应给出下一次重连的时间');
    })();
  }));
});

test('插件卸载时停掉守护定时器并卸掉桥接', () => {
  captureTimers((timers) => {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto005' });
    assert.equal(timers.length, 1);
    const bridge = record.effectHandles.find((item) => item.label === 'inject:mcpManager');
    assert.ok(bridge, '应当注册桥接生命周期');
    bridge.dispose();
    assert.equal(timers[0].cleared, true, '卸载后不应继续轮询');
    assert.equal(record.unmounts, 1, '卸载时把桥接一起摘掉');
  });
});

test('安装更新期间不重挂，标记摘掉后自动恢复', () => {
  captureTimers((timers) => withClock(1_700_000_000_000, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-update-'));
    const exe = path.join(dir, '格式匠.exe');
    const marker = path.join(dir, 'update-in-progress.marker');
    fs.writeFileSync(exe, '');
    fs.writeFileSync(marker, 'updating');
    try {
      const { ctx, record, serverView } = makeCtx();
      plugin.apply(ctx, { executablePath: exe, installationId: 'ins_auto006' });
      serverView.status = { state: 'failed', lastError: 'Connection closed' };
      timers[0].cb();
      assert.equal(record.mounts.length, 1, '安装期间桥接被拒绝启动，重挂没有意义');

      fs.unlinkSync(marker);
      timers[0].cb();
      assert.equal(record.mounts.length, 2, '标记摘掉后照常恢复');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));
});

test('用户退出后手动打开格式匠，端口通了就自动接上', async () => {
  const net = await import('node:net');
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-gateway-'));
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port }), 'utf8');
  try {
    await captureTimers(async (timers) => {
      const { ctx, record, serverView } = makeCtx();
      plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto007', dataDir: dir });
      serverView.status = { state: 'failed', lastError: '格式匠已由用户完全退出，本次不会自动打开；请手动启动格式匠或恢复连接' };
      timers[0].cb();
      assert.equal(record.mounts.length, 1, '探测是异步的，这一刻还没重挂');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(record.mounts.length, 2, '端口通了就应当自动重挂');
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('用户退出且格式匠没开时保持安静', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-gateway-off-'));
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port: 1 }), 'utf8');
  try {
    await captureTimers(async (timers) => {
      const { ctx, record, serverView } = makeCtx();
      plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto008', dataDir: dir });
      serverView.status = { state: 'failed', lastError: '格式匠已由用户完全退出，本次不会自动打开' };
      timers[0].cb();
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(record.mounts.length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('手动重连后重新记一轮，不会被之前用尽的次数卡住', async () => {
  await captureTimers(async (timers) => {
    await withClock(1_700_000_000_000, async (clock) => {
      const { ctx, record, serverView } = makeCtx();
      plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_auto009' });
      const tick = timers[0].cb;
      serverView.status = { state: 'failed', lastError: 'Connection closed' };
      tick();
      clock.advance(30_000);
      tick();
      clock.advance(60_000);
      tick();
      assert.equal(record.mounts.length, 4, '三次自动重连已经用尽');

      const connect = record.tools.find((item) => item.name === 'formatjiang_connect');
      await connect.execute({ restart: true });
      assert.equal(record.mounts.length, 5, '手动重连仍然有效');

      serverView.status = { state: 'failed', lastError: 'Connection closed' };
      clock.advance(15_000);
      tick();
      assert.equal(record.mounts.length, 6, '手动动作之后自动重连重新计数');
    });
  });
});

/* ------------------------- 能力清单 ------------------------- */

function stubDescribe(payload) {
  globalThis.__fjExecCalls = [];
  globalThis.__fjExec = {
    respond(record, callback) {
      if (payload instanceof Error) {
        callback(payload, '', 'formatjiang mcp describe: 未知子命令');
        return;
      }
      callback(null, JSON.stringify(payload) + '\n', '');
    },
  };
}

function clearDescribe() {
  delete globalThis.__fjExec;
  delete globalThis.__fjExecCalls;
}

const CATALOG_PAYLOAD = {
  server: { name: '格式匠 MCP 聚合网关', version: '1.0.58' },
  protocolVersion: '2026-07-28',
  tools: [
    { name: 'list_papers', description: '列出论文' },
    { name: 'run_paper_diagnostic', description: '提交检查' },
  ],
  resources: [{ uri: 'formatjiang://paper/1', name: '论文 1' }],
  resourceTemplates: [{ uriTemplate: 'formatjiang://paper/{id}', name: '论文' }],
  prompts: [{ name: 'formatjiang/thesis' }],
  truncated: false,
  durationMs: 89,
};

test('连上之后把工具、资源、模板与提示词的数量读回来', async () => {
  stubDescribe(CATALOG_PAYLOAD);
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_cat0001' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(globalThis.__fjExecCalls.length, 0, '挂载时不主动读，避免和桥接抢着拉起格式匠');

    const tool = record.tools.find((item) => item.name === 'formatjiang_catalog');
    await tool.execute({});
    assert.equal(globalThis.__fjExecCalls.length, 1, '连上之后按需读一次清单');
    assert.deepEqual(globalThis.__fjExecCalls[0].args, ['mcp', 'describe', '--installation-id', 'ins_cat0001']);

    const route = record.routes.find((item) => item.path === '/formatjiang/api');
    const body = await call(route, {});
    const catalog = body.json.state.catalog;
    assert.equal(catalog.error, '');
    assert.equal(catalog.data.tools.length, 2);
    assert.equal(catalog.data.tools[0].name, 'list_papers');
    assert.equal(catalog.data.resources.length, 1);
    assert.equal(catalog.data.resourceTemplates.length, 1);
    assert.equal(catalog.data.prompts.length, 1);
    assert.equal(catalog.data.server.version, '1.0.58');
    assert.equal(catalog.data.protocolVersion, '2026-07-28');
  } finally {
    clearDescribe();
  }
});

test('格式匠版本太旧时清单报错，而不是假装没有资源', async () => {
  stubDescribe(new Error('未知子命令'));
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_cat0002' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tool = record.tools.find((item) => item.name === 'formatjiang_catalog');
    const result = await tool.execute({});

    const route = record.routes.find((item) => item.path === '/formatjiang/api');
    const body = await call(route, {});
    assert.match(body.json.state.catalog.error, /未知子命令/);
    assert.equal(body.json.state.catalog.data, null);

    assert.equal(result.ok, false);
    assert.match(result.text, /读取能力清单失败/);
  } finally {
    clearDescribe();
  }
});

test('formatjiang_catalog 给出四类数量，强制刷新会再问一次', async () => {
  stubDescribe(CATALOG_PAYLOAD);
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_cat0003' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tool = record.tools.find((item) => item.name === 'formatjiang_catalog');
    const cached = await tool.execute({});
    assert.equal(cached.ok, true);
    assert.match(cached.text, /工具 2 个/);
    assert.match(cached.text, /固定资源 1 个/);
    assert.match(cached.text, /提示词 1 个/);
    assert.equal(globalThis.__fjExecCalls.length, 1, '默认走缓存');

    await tool.execute({ refresh: true });
    assert.equal(globalThis.__fjExecCalls.length, 2, 'refresh 必须重新问一次');
  } finally {
    clearDescribe();
  }
});

test('连上之后的轮询补读清单，TTL 内不重复读', async () => {
  stubDescribe(CATALOG_PAYLOAD);
  try {
    await captureTimers(async (timers) => {
      const { ctx } = makeCtx();
      plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_cat0004' });
      timers[0].cb();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(globalThis.__fjExecCalls.length, 1, '连上之后补读一次');
      timers[0].cb();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(globalThis.__fjExecCalls.length, 1, 'TTL 内不重复读');
    });
  } finally {
    clearDescribe();
  }
});

test('手动断开：卸掉桥接、暂停自动重连，重连后恢复', async () => {
  await captureTimers(async (timers) => {
    await withClock(1_700_000_000_000, async (clock) => {
      const { ctx, record, serverView } = makeCtx();
      plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_disc0001' });
      const tick = timers[0].cb;
      assert.equal(record.mounts.length, 1);

      const disconnect = record.tools.find((item) => item.name === 'formatjiang_disconnect');
      const state = await disconnect.execute({});
      assert.equal(state.ok, true);
      assert.equal(record.unmounts, 1, '断开要真的卸掉桥接');
      assert.equal(state.paused, true);
      assert.equal(state.label, '已断开');

      // 断开期间即使宿主报告失败，也不要自动重挂。
      serverView.status = { state: 'failed', lastError: 'Connection closed' };
      clock.advance(60_000);
      tick();
      tick();
      assert.equal(record.mounts.length, 1, '手动断开之后守护定时器必须安静');

      const connect = record.tools.find((item) => item.name === 'formatjiang_connect');
      const resumed = await connect.execute({ restart: true });
      assert.equal(resumed.ok, true);
      assert.equal(record.mounts.length, 2, '重连要重新挂上');
      const snap = await (record.tools.find((item) => item.name === 'formatjiang_status')).execute({});
      assert.equal(snap.paused, false);
    });
  });
});

test('面板 /disconnect 同样能断开并报告状态', async () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_disc0002' });
  const route = record.routes.find((item) => item.path === '/formatjiang/api');
  const body = await call(route, { method: 'POST', url: '/formatjiang/api/disconnect', headers: { host: '127.0.0.1:5173' } });
  assert.equal(body.status, 200);
  assert.equal(body.json.state.paused, true);
  assert.equal(record.unmounts, 1);
  assert.equal(body.json.state.server.state, 'unmounted');
});

/**
 * 面板的两个连接动作在 preset 模式下没有对象：以前 /disconnect 会把 paused 置上，
 * 而预设模式又没有「重新连接」按钮，宿主通道会被这个标记一直挡住；/connect 则回一句
 * 「重连失败」。这两条都必须在 API 层就分开处理，不能只靠隐藏按钮。
 */
test('预设模式下 /disconnect 不停宿主通道，/connect 回「不用重连」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-http-preset-'));
  const { ctx, record } = makeCtx();
  try {
    plugin.apply(ctx, {
      executablePath: EXE,
      installationId: 'ins_http_preset',
      dataDir: dir,
      mountScope: 'preset',
      autoReconnect: false,
    });
    const route = record.routes.find((item) => item.path === '/formatjiang/api');

    const off = await call(route, { method: 'POST', url: '/formatjiang/api/disconnect', headers: { host: '127.0.0.1:5173' } });
    assert.equal(off.status, 200);
    assert.equal(off.json.state.paused, false, '预设模式没有可断开的连接，不能把 paused 置上');
    assert.equal(off.json.state.hostChannel.ok, true);
    assert.match(off.json.note, /没有可断开的连接/);

    const on = await call(route, {
      method: 'POST',
      url: '/formatjiang/api/connect',
      headers: { host: '127.0.0.1:5173', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.ok, true);
    assert.match(on.json.note, /不用重连/);
    assert.equal(record.mounts.length, 0, '预设模式不该在宿主层挂桥接');
  } finally {
    record.disposers.forEach((dispose) => dispose());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * mountScope: off 是主动配置，不是 preset 的另一种写法：connect 不能套用「桥接由预设负责」，
 * disconnect 也不能假装断开了一条根本不存在的桥接。
 */
test('mountScope: off 时 connect 与 disconnect 说清「配置关闭」，不套用预设的说法', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-off-scope-'));
  const { ctx, record } = makeCtx();
  try {
    plugin.apply(ctx, {
      executablePath: EXE,
      installationId: 'ins_off_scope',
      dataDir: dir,
      mountScope: 'off',
      autoReconnect: false,
    });

    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    const snap = await status.execute({});
    assert.match(snap.text, /桥接已关闭/);
    assert.match(snap.text, /mountScope: off/);

    const connect = record.tools.find((tool) => tool.name === 'formatjiang_connect');
    const result = await connect.execute({});
    assert.equal(result.ok, false);
    assert.match(result.text, /mountScope: off/);
    assert.doesNotMatch(result.text, /官方 mcp 客户端/, 'off 与 preset 是两种配置，不能混用一句话');

    const disconnect = record.tools.find((tool) => tool.name === 'formatjiang_disconnect');
    const stopped = await disconnect.execute({});
    assert.equal(stopped.ok, false);
    assert.match(stopped.text, /没有可断开的连接/);
    assert.equal(record.unmounts, 0);
  } finally {
    record.disposers.forEach((dispose) => dispose());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 暂存必须拒绝目录跳转，并且正常复制不改用户原件。
test('附件暂存拒绝路径逃逸并保留原件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-stage-audit-'));
  const { ctx, record } = makeCtx();
  try {
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_stage_audit', dataDir: dir, autoReconnect: false });
    const stage = record.tools.find(tool => tool.name === 'formatjiang_stage_attachment');
    const source = path.join(dir, 'source.docx');
    fs.writeFileSync(source, 'document');
    const exec = { agent: { session: { header: { id: 'real-chat-a' } } } };
    let stagedPath = '';
    globalThis.__fjExec = { respond(record, callback) {
      if (record.args[1] !== 'host') return callback(new Error('非宿主请求'), '', '');
      assert.equal(record.args.at(-1), 'real-chat-a');
      assert.equal(record.input.name, 'receive_file');
      stagedPath = record.input.arguments.source_path;
      assert.equal(fs.readFileSync(stagedPath, 'utf8'), 'document');
      callback(null, JSON.stringify({ status: 'ok', data: { file: { file_id: 'f_real' } } }), '');
    } };
    for (const file_name of ['../../escaped.docx', '..\\escaped.docx', 'C:escape.docx', 'NUL']) {
      const result = await stage.execute({ path: source, file_name }, exec);
      assert.equal(result.ok, false, file_name);
    }
    assert.equal((await stage.execute({ path: 'relative.docx' }, exec)).ok, false);
    assert.equal((await stage.execute({ path: source })).ok, false, '缺少宿主身份须拒绝');
    const copied = await stage.execute({ path: source, file_name: 'copy.docx' }, exec);
    assert.equal(copied.ok, true);
    assert.equal(copied.data.file.file_id, 'f_real');
    assert.equal(fs.existsSync(path.dirname(stagedPath)), false, '接收完成后回收本次暂存目录');
    assert.equal(fs.readFileSync(source, 'utf8'), 'document');
    assert.equal(path.relative(path.join(dir, 'mcp-files', 'inbox'), stagedPath).startsWith('..'), false);
  } finally {
    delete globalThis.__fjExec;
    record.disposers.forEach(dispose => dispose());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('宿主动作传递取消信号并拒绝伪造保存回执', async () => {
  const { ctx, record } = makeCtx();
  try {
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_host_validation', autoReconnect: false });
    const save = record.tools.find(tool => tool.name === 'formatjiang_save_file');
    const controller = new AbortController();
    const exec = { agent: { session: { header: { id: 'actual-chat' } } }, signal: controller.signal };
    const target = path.join(os.tmpdir(), 'fj-saved-output.docx');
    for (const response of ['[]', '{}', '{"saved":false}', '{"saved":true,"file_id":"different"}']) {
      globalThis.__fjExec = { respond(call, done) { assert.equal(call.options.signal, controller.signal); done(null, response, ''); } };
      assert.equal((await save.execute({ file_id: 'f_saved', path: target }, exec)).ok, false);
    }
    globalThis.__fjExec = { respond(call, done) { done(null, JSON.stringify({ saved: true, file_id: 'f_saved', path: target, byte_size: 3, sha256: 'a'.repeat(64) }), ''); } };
    assert.equal((await save.execute({ file_id: 'f_saved', path: target }, exec)).ok, true);
    controller.abort();
    globalThis.__fjExec = { respond() { assert.fail('取消后不能再启动宿主请求'); } };
    assert.equal((await save.execute({ file_id: 'f_saved', path: target }, exec)).ok, false);
  } finally {
    delete globalThis.__fjExec;
    record.disposers.forEach(dispose => dispose());
  }
});

test('附件复制失败时清理本次半成品且保留原件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-copy-failure-'));
  const { ctx, record } = makeCtx();
  const originalCopy = fs.promises.copyFile;
  try {
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_copy_failure', dataDir: dir, autoReconnect: false });
    const source = path.join(dir, 'source.docx'); fs.writeFileSync(source, 'original');
    fs.promises.copyFile = async (from, to) => { await fs.promises.writeFile(to, 'partial'); throw new Error('复制中断'); };
    const stage = record.tools.find(tool => tool.name === 'formatjiang_stage_attachment');
    const result = await stage.execute({ path: source }, { agent: { session: { header: { id: 'copy-chat' } } } });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(source, 'utf8'), 'original');
    assert.equal(fs.readdirSync(path.join(dir, 'mcp-files', 'inbox')).length, 0);
  } finally {
    fs.promises.copyFile = originalCopy;
    record.disposers.forEach(dispose => dispose());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * 装配期失败的隔离与降级。
 *
 * 这一组用例守的是同一条底线：服务没就绪、或某条工具写错，只影响它自己，
 * 不能让工具面、系统提示、技能与面板路由一起消失——那在界面上只会表现成
 * 「设置页一直在读状态」。
 */

test('webServer 没就绪时其余装配照常，只是面板接口没挂上', () => {
  const { ctx, record } = makeCtx({ missing: ['webServer'] });
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_noweb' });

  assert.equal(record.tools.length, 12, '工具不应因为面板服务缺席而消失');
  assert.equal(record.prompts.length, 1, '系统提示应当照常注册');
  assert.equal(record.skills.length, 1, '工作流技能应当照常注册');
  assert.equal(record.routes.length, 0, 'webServer 缺席时不应当有面板路由');
  assert.deepEqual(record.skippedInjects?.[0]?.missing, ['webServer']);
});

test('mcpManager 没就绪时工具照常装配，状态说明在等服务', async () => {
  const { ctx, record } = makeCtx({ missing: ['mcpManager'] });
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_nomcp' });

  assert.equal(record.tools.length, 12);
  assert.equal(record.mounts.length, 0, '服务没起来时不应当假装挂过桥接');
  assert.equal(record.routes.length, 1, '面板路由与 mcpManager 无关，仍应挂上');

  const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
  const result = await status.execute({});
  assert.match(result.text, /等待 MCP 客户端服务就绪/);
});

test('单条工具注册失败只记一笔，其余工具与面板照常', () => {
  const { ctx, record } = makeCtx();
  const realRegister = ctx.tools.register;
  ctx.tools.register = (definition) => {
    if (definition.name === 'formatjiang_catalog') throw new Error('宿主拒绝了这条工具');
    return realRegister(definition);
  };
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_onetool' });

  assert.equal(record.tools.length, 11, '坏掉的那条不注册，其余照常');
  assert.equal(record.routes.length, 1, '面板路由不应当被一条工具连累');
  const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
  assert.ok(status, '状态工具本身不应当被连累');
});

/*
 * 「配置说已开启」和「现在有人在听」是两件事。
 *
 * 这两种事实混成一句打勾，用户就会在格式匠根本没运行时看到「已经就绪」，
 * 然后把「一直连不上」当成插件坏了。这一组用例守的是：状态里必须分开说。
 */

test('端口没在听时状态写「没有监听」，而不是把配置当就绪', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-listen-off-'));
  // 1 号端口不会有服务在听，探测会立刻失败。
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port: 1 }), 'utf8');
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_listen_off', dataDir: dir, autoReconnect: false });
    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    // 第一次快照触发端口探测（异步），等结果落地后再取一次同样的状态。
    await status.execute({});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snap = await status.execute({});

    assert.equal(snap.formatjiang.listening, false, '探测不到监听时必须写 false');
    assert.equal(snap.formatjiang.mcpEnabled, true, '配置事实仍然照实报');
    assert.ok(snap.hints.some((hint) => hint.includes('没有监听')), `缺少「没有监听」提示：${JSON.stringify(snap.hints)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端口真的在听时状态写「正在监听」，诊断信息也照实说', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-listen-on-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port }), 'utf8');
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_listen_on', dataDir: dir, autoReconnect: false });
    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    const diagnostics = record.tools.find((tool) => tool.name === 'formatjiang_diagnostics');
    // 第一次快照触发端口探测（异步），等结果落地后再取一次同样的状态。
    await status.execute({});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snap = await status.execute({});

    assert.equal(snap.formatjiang.listening, true);
    assert.ok(!snap.hints.some((hint) => hint.includes('没有监听')), '端口在听时不该提示未监听');
    const report = await diagnostics.execute({});
    assert.match(report.text, /端口 \d+（正在监听）/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('宿主只说 Connection closed 时，插件自己把桥接 stderr 捞回来', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-probe-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, 'mcp_settings.json'), JSON.stringify({ enabled: true, port }), 'utf8');
  const { ctx, record, serverView } = makeCtx();
  serverView.status.state = 'failed';
  serverView.status.lastError = 'mcp-client(formatjiang): startup: SdkError: Connection closed';
  try {
    // 用 node 当「桥接程序」：它必然会因为这个参数组合失败并往 stderr 写东西，
    // 正好用来验证「探测能不能把子进程那句话取回来」，不依赖真的格式匠。
    plugin.apply(ctx, { executablePath: process.execPath, installationId: 'ins_probe', dataDir: dir, autoReconnect: false });
    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    // 第一步触发端口探测，等它落地；第二步才会轮到桥接探测，再等子进程退出。
    await status.execute({});
    await new Promise((resolve) => setTimeout(resolve, 200));
    await status.execute({});
    await new Promise((resolve) => setTimeout(resolve, 900));
    const snap = await status.execute({});

    assert.ok(snap.probe && snap.probe.at > 0, '没有发起桥接探测');
    assert.ok(snap.probe.reason.length > 0, `没有取回 stderr 原文：${JSON.stringify(snap.probe)}`);
    assert.ok(snap.hints.some((hint) => hint.includes('桥接启动失败的原因')), `缺少旁证提示：${JSON.stringify(snap.hints)}`);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});




test('宿主那一份选了 mountScope: preset 就不再挂桥接，状态里说清去哪儿找工具', async () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_test0002', mountScope: 'preset' });

  // 桥接这一件事已经完全交给预设；宿主再挂一次就又变成全局可见了。
  assert.equal(record.mounts.length, 0);
  // 插件页、工具、技能与命令都还归宿主这一份，缩水只缩桥接。
  assert.equal(record.tools.length, 12);
  assert.equal(record.routes.length, 1);

  const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
  const snap = await status.execute({});
  assert.equal(snap.mountScope, 'preset');
  assert.equal(snap.server.state, 'unmounted');
  assert.match(snap.text, /业务工具由「格式匠」预设里的官方 mcp 客户端/);

  // 手动连接按钮要给出同一条说明，而不是一句「未挂载」。
  // preset 模式下这不是故障：桥接归预设里的官方 mcp 客户端，宿主没有可重建的连接，
  // 宿主通道可用时这条调用算成功（见 presetScopeNote）。
  const connect = record.tools.find((tool) => tool.name === 'formatjiang_connect');
  const result = await connect.execute({});
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /不用重连/);
  assert.match(result.text, /宿主通道：可用/);
  assert.ok(result.text.includes('「格式匠」预设'), result.text);
});

/**
 * 这一组守的是 preset 模式用官方 mcp 客户端的那条配置：
 *
 * 宿主这一份看不到预设里那份客户端的连接状态（没有交接记录），所以 `snap.ok` 永远是
 * false。以前 `callHost` 与附件暂存拿它当门禁，附件与会话操作因此全被挡死，模型只能
 * 回一句「没选预设」。宿主通道与桥接是两条路，必须各有各的门禁与状态。
 */
test('预设用官方 mcp 客户端时（没有交接记录），宿主工具照常可用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-preset-host-'));
  const { ctx, record } = makeCtx();
  try {
    plugin.apply(ctx, {
      executablePath: EXE,
      installationId: 'ins_preset_host',
      dataDir: dir,
      mountScope: 'preset',
      autoReconnect: false,
    });
    // 这是 preset 模式的既定分工：宿主这一份不挂桥接，桥接归预设里的官方 mcp 客户端。
    assert.equal(record.mounts.length, 0);

    const source = path.join(dir, 'draft.docx');
    fs.writeFileSync(source, 'preset-host');
    const exec = { agent: { session: { header: { id: 'preset-chat' } } } };
    let stagedPath = '';
    globalThis.__fjExec = {
      respond(call, done) {
        assert.equal(call.args[1], 'host');
        assert.equal(call.args.at(-1), 'preset-chat');
        assert.equal(call.input.name, 'receive_file');
        stagedPath = call.input.arguments.source_path;
        done(null, JSON.stringify({ status: 'ok', data: { file: { file_id: 'f_preset' } } }), '');
      },
    };

    const stage = record.tools.find((tool) => tool.name === 'formatjiang_stage_attachment');
    const staged = await stage.execute({ path: source }, exec);
    assert.equal(staged.ok, true, staged.text);
    assert.equal(staged.data.file.file_id, 'f_preset');
    // 收件区必须落在格式匠自己的数据目录里，不能跑到当前工作目录下。
    assert.equal(path.relative(path.join(dir, 'mcp-files', 'inbox'), stagedPath).startsWith('..'), false);

    // 会话身份同样走宿主通道：它以前也被「还没连上」挡住。
    globalThis.__fjExec = {
      respond(call, done) {
        assert.equal(call.input.name, 'get_session_binding');
        done(null, JSON.stringify({ status: 'ok', data: { binding: null } }), '');
      },
    };
    const session = record.tools.find((tool) => tool.name === 'formatjiang_session');
    const bound = await session.execute({ action: 'get' }, exec);
    assert.equal(bound.ok, true, bound.text);

    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    const snap = await status.execute({});
    assert.equal(snap.mountScope, 'preset');
    assert.equal(snap.presetBridge, null, '官方客户端不写交接记录');
    assert.equal(snap.server.state, 'unmounted');
    assert.equal(snap.hostChannel.ok, true);
    assert.equal(snap.ok, true, '宿主通道可用时不能把整条接入判成不可用');
    assert.match(snap.text, /宿主通道：可用/);
    assert.doesNotMatch(snap.text, /还没连上/);
    assert.doesNotMatch(snap.text, /选了这个预设的会话才加载/);
    assert.doesNotMatch(snap.text, /再等一个回合/);
  } finally {
    delete globalThis.__fjExec;
    record.disposers.forEach((dispose) => dispose());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('宿主通道缺安装 ID 时报缺什么，不再说「还没连上」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-preset-noins-'));
  const { ctx, record } = makeCtx();
  try {
    // 空的临时数据目录里没有格式匠数据库：安装 ID 发现不了，这是配置问题，不是连接问题。
    plugin.apply(ctx, { executablePath: EXE, installationId: '', dataDir: dir, mountScope: 'preset', autoReconnect: false });
    const stage = record.tools.find((tool) => tool.name === 'formatjiang_stage_attachment');
    const source = path.join(dir, 'draft.docx');
    fs.writeFileSync(source, 'x');
    let spawns = 0;
    globalThis.__fjExec = { respond() { spawns += 1; assert.fail('通道不可用时不该起宿主进程'); } };

    const staged = await stage.execute({ path: source }, { agent: { session: { header: { id: 'noins-chat' } } } });
    assert.equal(staged.ok, false);
    assert.match(staged.text, /宿主通道不可用/);
    assert.doesNotMatch(staged.text, /还没连上/);
    assert.equal(spawns, 0);

    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    const snap = await status.execute({});
    assert.equal(snap.hostChannel.ok, false);
    assert.match(snap.text, /宿主通道：不可用/);
    // 没有交接记录、宿主通道又不可用：整体确实还没接好，不能硬报成功。
    assert.equal(snap.ok, false);
  } finally {
    delete globalThis.__fjExec;
    record.disposers.forEach((dispose) => dispose());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('预设作用域那一份只挂桥接，不注册工具、提示、技能、命令与面板', async () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_preset01', bridgeOnly: true });
  // 动态 import 与 ctx.plugin 都是异步的，等两拍让它走完。
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(record.tools.length, 0);
  assert.equal(record.prompts.length, 0);
  assert.equal(record.skills.length, 0);
  assert.equal(record.commands.length, 0);
  assert.equal(record.routes.length, 0);

  assert.equal((record.plugins || []).length, 1, '预设里没有挂上 mcp 客户端');
  const bridged = record.plugins[0];
  assert.equal(bridged.config.serverName, 'formatjiang');
  assert.equal(bridged.config.transport, 'stdio');
  assert.equal(bridged.config.command, EXE);
  assert.deepEqual(bridged.config.args, ['mcp', 'bridge', '--installation-id', 'ins_preset01']);
  // 格式匠没开时连不上是常态，不能因此让整个会话装不起来。
  assert.equal(bridged.config.failOnStartupError, false);
});

test('桥接挂在预设上时，系统提示先把「这个会话看不到业务工具」说在前面', () => {
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_prompt01', mountScope: 'preset' });
  const text = record.prompts[0].text;
  assert.match(text, /只在「格式匠」预设的会话里加载/);
  // 位置也要对：这句必须排在第一段说明后面，模型先读到它再读流程。
  const lines = text.split('\n');
  const scopeLine = lines.findIndex((line) => line.includes('只在「格式匠」预设的会话里加载'));
  assert.ok(scopeLine > 0 && scopeLine < 6, `这行位置不对：${scopeLine}`);

  // 宿主层自己挂的时候不该出现这句：那种会话里工具本来就是全的。
  const host = makeCtx();
  plugin.apply(host.ctx, { executablePath: EXE, installationId: 'ins_prompt02' });
  assert.doesNotMatch(host.record.prompts[0].text, /只在「格式匠」预设的会话里加载/);
});

/**
 * 交接台（两份实例之间那个临时文件）。
 * 用例直接读写它，所以每个用例前后都要清干净、并丢掉插件里的读取缓存。
 */
function sharedFilePath() {
  return process.env.FORMATJIANG_STATE_FILE;
}

function resetSharedFile() {
  fs.rmSync(path.dirname(sharedFilePath()), { recursive: true, force: true });
  plugin.__resetSharedCache();
}

function writeSharedFile(value) {
  fs.mkdirSync(path.dirname(sharedFilePath()), { recursive: true });
  fs.writeFileSync(sharedFilePath(), JSON.stringify(value), 'utf8');
  plugin.__resetSharedCache();
}

function sharedFileText() {
  plugin.__resetSharedCache();
  try {
    return fs.readFileSync(sharedFilePath(), 'utf8');
  } catch {
    return '';
  }
}

function readSharedFile() {
  plugin.__resetSharedCache();
  try {
    return JSON.parse(fs.readFileSync(sharedFilePath(), 'utf8'));
  } catch {
    return {};
  }
}

test('桥接交给预设时，宿主把「程序在哪、安装 ID 是什么」写到交接台', async () => {
  resetSharedFile();
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_handoff01', mountScope: 'preset' });
    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    await status.execute({});

    const shared = readSharedFile();
    assert.equal(shared.hostTarget?.executable, EXE);
    assert.equal(shared.hostTarget?.installationId, 'ins_handoff01');
    assert.ok(shared.hostTarget?.at > 0);
  } finally {
    resetSharedFile();
  }
});

test('预设那一份写了状态，宿主的面板与状态工具要能读到', async () => {
  resetSharedFile();
  try {
    writeSharedFile({
      presetBridge: { state: 'connected', toolCount: 110, lastError: '', at: Date.now() },
    });
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_handoff02', mountScope: 'preset' });
    // 装配时 snapshot 里会调用 handoffTarget —— 那一步会重写文件，所以先执行工具再断言。
    writeSharedFile({
      presetBridge: { state: 'connected', toolCount: 110, lastError: '', at: Date.now() },
    });
    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    const snap = await status.execute({});

    assert.equal(snap.ok, true, '预设里连上了，宿主这份的 ok 也该是 true');
    assert.equal(snap.label, '已连接');
    assert.equal(snap.presetBridge.toolCount, 110);
    assert.match(snap.text, /预设桥接：connected/);
  } finally {
    resetSharedFile();
  }
});

test('预设那一份连不上时，宿主要把原因和「多久以前」讲出来', async () => {
  resetSharedFile();
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_handoff03', mountScope: 'preset' });
    writeSharedFile({
      presetBridge: { state: 'failed', toolCount: 0, lastError: 'SdkError: Connection closed', at: Date.now() - 5 * 60 * 1000 },
    });
    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    const snap = await status.execute({});

    assert.equal(snap.ok, false);
    assert.equal(snap.label, '预设里连不上');
    assert.match(snap.detail, /5 分钟前/);
    assert.ok(snap.hints.some((hint) => hint.includes('「格式匠」预设里的桥接连不上')), JSON.stringify(snap.hints));
  } finally {
    resetSharedFile();
  }
});

test('预设那一份挂上桥接后把状态写给宿主', async () => {
  resetSharedFile();
  try {
    const { ctx } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_handoff04', bridgeOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const shared = readSharedFile();
    assert.equal(shared.presetBridge?.state, 'connected', JSON.stringify(shared));
    assert.equal(shared.presetBridge?.toolCount, 3);
  } finally {
    resetSharedFile();
  }
});

test('宿主还在挂桥接时，预设那一份不重复挂，并说明要怎么改', async () => {
  resetSharedFile();
  try {
    writeSharedFile({ hostBridge: { mounted: true, at: Date.now() } });
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_guard01', bridgeOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal((record.plugins || []).length, 0, '两份同时挂会出两套同名工具');
    const shared = readSharedFile();
    assert.equal(shared.presetBridge?.state, 'failed');
    assert.match(shared.presetBridge?.lastError || '', /mountScope: preset/);
  } finally {
    resetSharedFile();
  }
});

test('宿主已经通过 mcpManager 挂了同名服务器时，预设那一份认出来并让路', async () => {
  resetSharedFile();
  try {
    const { ctx, record } = makeCtx();
    // 模拟宿主那一份已经挂上（真实环境里它的 list() 会列出 formatjiang）。
    ctx.mcpManager.register('formatjiang', { transport: 'stdio' });
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_guard02', bridgeOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal((record.plugins || []).length, 0, '不认出来就会挂出第二套同名工具');
    assert.match(sharedFileText(), /宿主那半边已经在挂桥接/);
  } finally {
    resetSharedFile();
  }
});


test('交接台上超过十分钟的记录不再当成现在', async () => {
  resetSharedFile();
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_ttl01', mountScope: 'preset' });
    writeSharedFile({
      presetBridge: { state: 'connected', toolCount: 110, lastError: '', at: Date.now() - 11 * 60 * 1000 },
    });
    const status = record.tools.find((tool) => tool.name === 'formatjiang_status');
    const snap = await status.execute({});

    assert.equal(snap.presetBridge, null, '过期记录不能当成现在的状态');
    // 过期记录只说明「预设那一份的交接看不清了」；宿主通道仍然可用，整体不算故障。
    assert.equal(snap.ok, true, '过期的交接记录不该把整条接入判成不可用');
    assert.equal(snap.hostChannel.ok, true);
    assert.equal(snap.label, '由预设提供');
    assert.doesNotMatch(snap.text, /预设桥接：connected/);
  } finally {
    resetSharedFile();
  }
});

test('按安装目录拼另一个包的地址：只换包名那一段', () => {
  const base = 'file:///D:/software/deepseek-harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
  assert.equal(
    plugin.siblingModuleUrl(base, '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client'),
    'file:///D:/software/deepseek-harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js',
  );
  // 作用域那一段保持原样，只动包名：编码成 %40 的地址也照样拼得出来。
  const encoded = 'file:///tmp/n/%40deepseek-ai/dsh-tools/lib/index.js';
  assert.equal(
    plugin.siblingModuleUrl(encoded, '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client'),
    'file:///tmp/n/%40deepseek-ai/dsh-mcp-client/lib/index.js',
  );
});

test('拼不出来的地址返回空串，不瞎猜', () => {
  assert.equal(plugin.siblingModuleUrl('', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client'), '');
  assert.equal(plugin.siblingModuleUrl(undefined, '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client'), '');
  assert.equal(
    plugin.siblingModuleUrl('file:///x/@deepseek-ai/dsh-scope/lib/index.js', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client'),
    '',
  );
});

test('预设那一份优先用宿主加载器取 mcp-client：parent 给的是 profile 配置地址', async () => {
  resetSharedFile();
  try {
    const calls = [];
    const fakeModule = {
      Config: (options) => options,
      connectionStatusOf: () => undefined,
      apply() {},
      name: 'mcp-client',
    };
    const loader = {
      internal: {
        async import(specifier, parent, attributes) {
          calls.push({ specifier, parent, attributes });
          return fakeModule;
        },
      },
    };
    const { ctx, record } = makeCtx({ loader, baseUrl: 'file:///C:/Users/20182/.dsh/profiles/desktop/cordis.patch.yml' });
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_loader01', bridgeOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0].specifier, '@deepseek-ai/dsh-mcp-client');
    assert.match(calls[0].parent, /profiles\/desktop\/cordis\.patch\.yml$/);
    assert.equal((record.plugins || []).length, 1, '取到的模块要交给 ctx.plugin 挂桥接');
    assert.equal(record.plugins[0].pluginObject, fakeModule);
    assert.equal(record.plugins[0].config.serverName, 'formatjiang');
  } finally {
    resetSharedFile();
  }
});

test('宿主加载器也取不到时退回普通 import，桥接照样挂上', async () => {
  resetSharedFile();
  try {
    let called = 0;
    const loader = {
      internal: {
        async import() {
          called += 1;
          throw new Error('Cannot find package');
        },
      },
    };
    const { ctx, record } = makeCtx({ loader, baseUrl: 'file:///C:/Users/20182/.dsh/profiles/desktop/cordis.patch.yml' });
    plugin.apply(ctx, { executablePath: EXE, installationId: 'ins_loader02', bridgeOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(called, 1, '加载器那条路要先试一次');
    assert.equal((record.plugins || []).length, 1, '退回普通 import 后仍要挂上桥接');
    const shared = readSharedFile();
    assert.equal(shared.presetBridge?.state, 'connected', JSON.stringify(shared));
  } finally {
    resetSharedFile();
  }
});

test('预设那一份连接放弃后按节奏重挂，重挂不会被「已卸载」标记钉死', async () => {
  resetSharedFile();
  const realSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (cb, ms) => {
    const handle = { cb, ms, unref() { return handle; } };
    scheduled.push(handle);
    return handle;
  };
  try {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, { bridgeOnly: true, executablePath: EXE, installationId: 'ins_remount01' });
    await new Promise((resolve) => realSetTimeout(resolve, 40));
    assert.equal((record.plugins || []).length, 1, '先挂上第一份');
    const first = record.lastPluginHandle;

    first.fire({ state: 'failed', reason: 'gave-up', lastError: 'SdkError: Connection closed' });
    assert.equal(scheduled.length, 1, JSON.stringify(scheduled.map((item) => item.ms)));
    assert.equal(scheduled[0].ms, 15000);

    scheduled[0].cb();
    await new Promise((resolve) => realSetTimeout(resolve, 40));
    assert.equal(first.disposed, 1, '重挂前要把旧的那一份卸掉');
    assert.equal((record.plugins || []).length, 2, '重挂要真的再 ctx.plugin 一次');
    assert.equal(record.lastPluginHandle.listenerCount(), 1, '新的一份要重新订阅状态');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    resetSharedFile();
  }
});

test('预设那一份重挂最多三次，连上之后重新计数', async () => {
  resetSharedFile();
  const realSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (cb, ms) => {
    const handle = { cb, ms, unref() { return handle; } };
    scheduled.push(handle);
    return handle;
  };
  try {
    // 每一份新挂上来的实例一开始就是 failed：这样才测得到连续失败时退避递增。
    const { ctx, record } = makeCtx({ pluginStatus: { state: 'failed', lastError: 'SdkError: Connection closed' } });
    plugin.apply(ctx, { bridgeOnly: true, executablePath: EXE, installationId: 'ins_remount02' });
    await new Promise((resolve) => realSetTimeout(resolve, 40));

    for (let round = 1; round <= 3; round += 1) {
      record.lastPluginHandle.fire({ state: 'failed', lastError: 'SdkError: Connection closed' });
      const timer = scheduled[scheduled.length - 1];
      assert.equal(timer.ms, [15000, 30000, 60000][round - 1], `第 ${round} 次的间隔`);
      timer.cb();
      await new Promise((resolve) => realSetTimeout(resolve, 40));
    }
    const before = scheduled.length;
    record.lastPluginHandle.fire({ state: 'failed', lastError: 'SdkError: Connection closed' });
    assert.equal(scheduled.length, before, '三次用完就不再排定时器');

    // 连上之后次数归零：再断一次仍然是 15 秒起算。
    record.lastPluginHandle.fire({ state: 'connected', toolCount: 3, connectedAt: Date.now() });
    await new Promise((resolve) => realSetTimeout(resolve, 10));
    record.lastPluginHandle.fire({ state: 'failed', lastError: 'SdkError: Connection closed' });
    assert.equal(scheduled[scheduled.length - 1].ms, 15000);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    resetSharedFile();
  }
});

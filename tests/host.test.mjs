/**
 * Host 半片的装配测试（不需要 DSH 运行时）。
 *
 * 覆盖：桥接条目参数、三个工具、系统提示节、命令、面板接口的授权与错误分支，
 * 以及「找不到程序 / 找不到安装」时仍然挂载但报错的状态。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as plugin from '../index.js';

const EXE = 'D:\\GoRoom\\docx-cli\\bin\\格式匠.exe';

function makeCtx() {
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
      return undefined;
    },
    effect(fn, label) {
      record.effects.push(label);
      const dispose = fn();
      record.effectHandles.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} });
      if (typeof dispose === 'function') record.disposers.push(dispose);
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
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
  assert.deepEqual(plugin.inject, ['tools', 'mcpManager']);
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
    ['formatjiang_status', 'formatjiang_connect', 'formatjiang_disconnect', 'formatjiang_open', 'formatjiang_diagnostics', 'formatjiang_catalog', 'formatjiang_stage_attachment', 'formatjiang_session', 'formatjiang_import_document', 'formatjiang_use_attachments', 'formatjiang_save_file'],
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

test('面板请求体超限返回 413，且不触发重连', async () => {
  const { ctx, record } = makeCtx();
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
    const bridge = record.effectHandles.find((item) => item.label === 'formatjiang: bridge');
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

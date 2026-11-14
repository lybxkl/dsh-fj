/**
 * 测试期的 child_process 替身。
 *
 * spawn 必须是真的——「打开格式匠失败」那类用例要的就是真进程错误；
 * 这里只把调用记下来，让用例能核对「拉起桌面时带了哪些参数/环境变量」。
 * execFile 走替身：清单读取会去执行 格式匠.exe，测试里不能真的把应用拉起来，
 * 于是把调用记下来，由用例通过 globalThis.__fjExec.respond 决定回什么。
 */
import { spawn as realSpawn } from 'node:child_process';

export function spawn(file, args, options) {
  globalThis.__fjSpawnCalls = globalThis.__fjSpawnCalls || [];
  globalThis.__fjSpawnCalls.push({ file, args, options });
  return realSpawn(file, args, options);
}

export function execFile(file, args, options, callback) {
  const record = { file, args, options };
  globalThis.__fjExecCalls = globalThis.__fjExecCalls || [];
  globalThis.__fjExecCalls.push(record);
  const harness = globalThis.__fjExec;
  if (args?.[1] === 'host') {
    return { stdin: { on() {}, end(payload) { record.input = JSON.parse(payload); if (harness?.respond) harness.respond(record, callback); else callback(new Error('测试未配置宿主响应'), '', ''); } } };
  }
  if (harness && typeof harness.respond === 'function') {
    harness.respond(record, callback);
    return;
  }
  callback(Object.assign(new Error('测试替身没有配置 describe 输出'), { code: 'ENOENT' }), '', '测试替身：未配置清单输出');
}

export default { spawn, execFile };

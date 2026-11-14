/**
 * 测试期的模块重定向：把宿主的 @deepseek-ai/dsh-tools 指到本地替身。
 *
 * 真实包只存在于 DSH 的 app.asar 里，普通 Node 进程加载不到；替身只校验插件传的字段，
 * 不实现宿主行为，所以不会掩盖装配错误。
 */
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// 两份实例通过一个临时文件交接状态。测试必须换到自己的目录：
// 否则会写进真实宿主那份，把用户机器上的预设桥接记录带偏。
process.env.FORMATJIANG_STATE_FILE = path.join(os.tmpdir(), `dsh-formatjiang-test-${process.pid}`, 'state.json');

// 打开工具会等格式匠的端口就绪：测试里把它压到 1.2 秒，别让每条用例都等满 25 秒。
process.env.FORMATJIANG_OPEN_WAIT_MS = '1200';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return {
        url: new URL('./stub-dsh-tools.mjs', import.meta.url).href,
        shortCircuit: true,
      };
    }
    // 预设作用域那一份会动态 import mcp 客户端：同样指到替身，测试里不连真服务器。
    if (specifier === '@deepseek-ai/dsh-mcp-client') {
      return {
        url: new URL('./stub-dsh-mcp-client.mjs', import.meta.url).href,
        shortCircuit: true,
      };
    }
    // 清单读取会 execFile 格式匠程序；测试里换成替身，spawn 仍是真的。
    // 替身自己也要 import node:child_process 取真 spawn，这里必须放行，否则成环。
    if (specifier === 'node:child_process' && !String(context.parentURL || '').includes('stub-child-process')) {
      return {
        url: new URL('./stub-child-process.mjs', import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

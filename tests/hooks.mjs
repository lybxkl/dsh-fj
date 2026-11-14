/**
 * 测试期的模块重定向：把宿主的 @deepseek-ai/dsh-tools 指到本地替身。
 *
 * 真实包只存在于 DSH 的 app.asar 里，普通 Node 进程加载不到；替身只校验插件传的字段，
 * 不实现宿主行为，所以不会掩盖装配错误。
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return {
        url: new URL('./stub-dsh-tools.mjs', import.meta.url).href,
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

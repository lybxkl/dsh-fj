/**
 * @deepseek-ai/dsh-mcp-client 的测试替身。
 *
 * 真实包在 DSH 的 app.asar 里，普通 Node 进程加载不到。这里只实现插件用到的三样东西：
 * `Config()` 的默认值、`connectionStatusOf()` 读状态、以及一个可被 ctx.plugin 挂上的
 * 插件对象。宿主如何连服务器不在这里实现。
 */

/** 与真实包一致：stdio 配置里这些字段有默认值。 */
export function Config(input) {
  return {
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60000,
    closeTimeoutMs: 5000,
    expandTemplates: false,
    failOnStartupError: false,
    ...input,
  };
}

/** 每个替身句柄自带一个状态单元，测试可以改它模拟连接结果。 */
export function connectionStatusOf(handle) {
  return handle?.statusCell;
}

/** 被 ctx.plugin 挂上时调用；替身不注册任何工具。 */
export function apply() {}

export const name = 'mcp-client';
export const inject = ['tools'];

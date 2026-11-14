/**
 * 本地测试替身：只为在没有 DSH 运行时的环境里跑通 index.js 的装配路径。
 * 真实定义由宿主提供的 @deepseek-ai/dsh-tools 生成；这里只要求插件传对字段。
 */
export function defineTool(definition) {
  if (!definition || typeof definition.name !== 'string' || !definition.name) {
    throw new Error('defineTool 需要 name');
  }
  if (typeof definition.execute !== 'function') {
    throw new Error(`工具 ${definition.name} 缺少 execute`);
  }
  return definition;
}

export default { defineTool };

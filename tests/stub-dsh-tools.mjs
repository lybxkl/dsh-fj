/**
 * 本地测试替身：在没有 DSH 运行时的环境里跑通 index.js 的装配路径。
 *
 * 这里校验的参数/输出 schema 规则与宿主 @deepseek-ai/dsh-tools 的作者协议一致
 * （它的 src/schema.ts 在 defineTool 里同步编译，写错就抛）。这一点很关键：
 * 真实宿主里这个抛错发生在装配期，会把整条 apply 掀掉——后面的工具、系统提示、
 * 技能、面板路由与桥接全都不执行，界面上只表现成「插件页一直读不到状态」。
 *
 * 替身以前只检查 name/execute，所以「object 参数漏写 additionalProperties」
 * 这类错误一路绿灯，直到装进 DSH 才炸。现在按同一份规则把错误挡在测试里。
 */

/** 允许出现在任意 schema 节点上的注解键。 */
const ANNOTATIONS = ['description', 'title', 'default', 'examples'];
/** 允许作为 type 的值。 */
const TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'];

function fail(path, message) {
  throw new Error(`${path} ${message}`);
}

function assertKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) fail(path, `出现未声明的字段 "${key}"`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验一个值 schema。
 *
 * @param {unknown} node - 待校验节点。
 * @param {string} path - 出错时用于定位的路径。
 * @param {boolean} allowRequired - 参数属性允许 `required: true`，其余位置不允许。
 */
function checkValue(node, path, allowRequired) {
  if (!isRecord(node)) fail(path, '必须是 schema 对象');
  if (Object.hasOwn(node, 'required')) {
    if (!allowRequired) fail(path, '.required 只允许出现在参数属性上');
    if (node.required !== true) fail(path, '.required 只允许写 true');
  }
  const keys = [...ANNOTATIONS, ...(allowRequired ? ['required'] : [])];

  if (Object.hasOwn(node, 'oneOf')) {
    assertKeys(node, path, [...keys, 'oneOf', 'type']);
    if (Object.hasOwn(node, 'type')) fail(path, '不能同时声明 type 与 oneOf');
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) fail(`${path}.oneOf`, '必须是至少两个 schema 的数组');
    node.oneOf.forEach((branch, index) => checkValue(branch, `${path}.oneOf[${index}]`, false));
    return;
  }

  if (!TYPES.includes(node.type)) {
    fail(`${path}.type`, `必须是 ${TYPES.join('/')} 之一`);
  }

  if (node.type === 'object') {
    assertKeys(node, path, [...keys, 'type', 'properties', 'additionalProperties']);
    if (typeof node.additionalProperties !== 'boolean') {
      // 宿主原文：${path}.additionalProperties must be explicitly true or false
      fail(`${path}.additionalProperties`, '必须显式写 true 或 false');
    }
    if (Object.hasOwn(node, 'properties')) checkPropertyMap(node.properties, `${path}.properties`);
    return;
  }

  if (node.type === 'array') {
    assertKeys(node, path, [...keys, 'type', 'items']);
    if (Object.hasOwn(node, 'items')) checkValue(node.items, `${path}.items`, false);
    return;
  }

  assertKeys(node, path, [...keys, 'type', 'enum', 'const']);
  if (Object.hasOwn(node, 'enum') && !Array.isArray(node.enum)) fail(`${path}.enum`, '必须是数组');
}

/** 参数是「隐式开放对象根」：键是参数名，值是允许 required 的值 schema。 */
function checkPropertyMap(map, path) {
  if (!isRecord(map)) fail(path, '必须是对象');
  for (const [key, value] of Object.entries(map)) checkValue(value, `${path}.${key}`, true);
}

export function defineTool(definition) {
  if (!isRecord(definition)) throw new Error('defineTool 需要选项对象');
  if (typeof definition.name !== 'string' || !definition.name) throw new Error('defineTool 需要 name');
  if (typeof definition.description !== 'string' || !definition.description) {
    throw new Error(`工具 ${definition.name} 需要 description`);
  }
  if (typeof definition.execute !== 'function') throw new Error(`工具 ${definition.name} 缺少 execute`);
  checkPropertyMap(definition.parameters, `defineTool(${definition.name}).parameters`);
  if (!isRecord(definition.output) || !isRecord(definition.output.schema)) {
    throw new Error(`工具 ${definition.name} 需要 output.schema`);
  }
  checkValue(definition.output.schema, `defineTool(${definition.name}).output.schema`, false);
  if (typeof definition.output.render !== 'function') {
    throw new Error(`工具 ${definition.name} 需要 output.render`);
  }
  return definition;
}

export default { defineTool };
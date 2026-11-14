// 从 shipped cordis 预设生成「格式匠」预设的 bundle patch。
// 用法：node scripts/gen-preset.mjs <app.asar 路径 | cordis.patch.yml 路径> <输出目录>
// 预设是完整清单、没有继承，所以 DSH 升级后 cordis 预设变了，要重跑这个脚本。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** app.asar 里 packaged 的 cordis 预设。 */
const IN_ASAR = '/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml'

/**
 * 从 app.asar 读一个文件。
 *
 * asar 头部：offset 4 是头部 pickle 的总长（含对齐填充），JSON 起于 offset 16、
 * 长度在 offset 12，内容基准是 8 + 头部总长。用 8 + JSON 长度会早 11 字节读进
 * 上一个文件的尾巴，这里必须用 offset 4 的那个值。
 */
function readFromAsar(asarPath, innerPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const contentBase = 8 + head.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 16)
    const index = JSON.parse(headerBuf.toString('utf8'))
    let node = index
    for (const part of innerPath.split('/').filter(Boolean)) {
      node = node?.files?.[part]
      if (!node) throw new Error(`app.asar 里没有 ${innerPath}`)
    }
    if (node.files) throw new Error(`${innerPath} 是目录，不是文件`)
    const buf = Buffer.alloc(node.size)
    fs.readSync(fd, buf, 0, node.size, contentBase + Number(node.offset))
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const [src, outDir] = process.argv.slice(2)
if (!src || !outDir) {
  console.error('usage: node scripts/gen-preset.mjs <app.asar | cordis.patch.yml> <outDir>')
  process.exit(2)
}

const raw = src.toLowerCase().endsWith('.asar') ? readFromAsar(src, IN_ASAR) : fs.readFileSync(src, 'utf8')

const lines = raw.split(/\r?\n/)

// 1) Loader 行 id：preset-cordis → preset-formatjiang
const rowIndex = lines.findIndex((line) => /^\s*-\s+id:\s+preset-cordis\s*$/.test(line))
if (rowIndex < 0) throw new Error('源文件里没有 preset-cordis 这一行，shipped 预设的结构可能变了')
lines[rowIndex] = lines[rowIndex].replace('preset-cordis', 'preset-formatjiang')

// 2) config.id 与展示字段。源文件哪天补了自己的 name/description，这里就不再插一遍。
const configIdIndex = lines.findIndex((line) => /^\s+id:\s+cordis\s*$/.test(line))
if (configIdIndex < 0) throw new Error('源文件里没有 config.id: cordis，shipped 预设的结构可能变了')
lines[configIdIndex] = lines[configIdIndex].replace(/id:\s*cordis/, 'id: formatjiang')
let insertAt = configIdIndex + 1
if (!/^\s+name:/.test(lines[insertAt] || '')) lines.splice(insertAt++, 0, '        name: 格式匠')
if (!/^\s+description:/.test(lines[insertAt] || '')) {
  lines.splice(insertAt++, 0, '        description: 论文工作：套版、提交检查、资料与页码取证。')
}

// 3) order：换成自己的位置，别跟 cordis 抢同一个序位。仅动紧挨着的那一段。
const orderIndex = lines.findIndex((line, index) => index > configIdIndex && index <= configIdIndex + 8 && /^\s+order:/.test(line))
if (orderIndex >= 0) lines[orderIndex] = '        order: 5'

// 4) 去掉末尾空行，把桥接行补在 plugins 列表最后。
//
// 桥接挂的是官方 mcp 客户端（`references/mcp-bundle.md` 的写法），不是本插件：
// 预设是一份普通的 Cordis 组成，越少自有代码参与越不容易在装配期出岔子。
// 程序路径与安装 ID 只能写死在这里，所以生成时可以给，也可以从交接台里读。
function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function handoffTarget() {
  try {
    const file = path.join(os.tmpdir(), 'dsh-formatjiang-assistant', 'state.json')
    const shared = JSON.parse(fs.readFileSync(file, 'utf8'))
    return shared?.hostTarget ?? null
  } catch {
    return null
  }
}

const handoff = handoffTarget()
const command = flag('--command') || process.env.FORMATJIANG_EXE || handoff?.executable
const installationId = flag('--installation-id') || process.env.FORMATJIANG_INSTALLATION_ID || handoff?.installationId
if (!command || !installationId) {
  console.error([
    '拿不到格式匠的程序路径或安装 ID。三条来源按顺序试：',
    '  1) --command <path> --installation-id <ins_...>',
    '  2) 环境变量 FORMATJIANG_EXE / FORMATJIANG_INSTALLATION_ID',
    '  3) %TEMP%\\dsh-formatjiang-assistant\\state.json 里的 hostTarget（格式匠插件跑过一次就有）',
    '安装 ID 在格式匠的「客户端接入」里。',
  ].join('\n'))
  process.exit(2)
}

while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
lines.push(...[
  '          # 格式匠桥接：直接挂官方 mcp 客户端。工具只对选了这个预设的会话可见。',
  '          # 程序路径或安装 ID 变了，重跑 node scripts/gen-preset.mjs 重新生成这一行。',
  '          - id: formatjiang-bridge',
  "            name: '@deepseek-ai/dsh-mcp-client'",
  '            config:',
  '              transport: stdio',
  '              serverName: formatjiang',
  // YAML 单引号里反斜杠是字面量，不能再转义一次，否则预设拿到的就是双反斜杠。
  `              command: '${String(command).replaceAll("'", "''")}'`,
  `              args: [mcp, bridge, --installation-id, ${installationId}]`,
  '              failOnStartupError: false',
  '              startupTimeoutMs: 90000',
  '              toolCallTimeoutMs: 270000',
  // 格式匠没运行时桥接会一直重试：默认 10 次（约两分钟）就用完额度，
  // 用户过一会儿才打开应用，这份预设就再也没有工具了，只能重开会话。
  // 这里把上限拉大、退避封顶 15 秒，应用一起来最多十几秒就自动接上。
  '              reconnect:',
  '                enabled: true',
  '                initialDelayMs: 2000',
  '                maxDelayMs: 15000',
  '                maxAttempts: 5000',
])

fs.mkdirSync(outDir, { recursive: true })
const target = path.join(outDir, 'cordis.patch.yml')
fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
console.log(`wrote ${target} (${lines.length} lines)`)

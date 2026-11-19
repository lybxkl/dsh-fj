/**
 * 格式匠论文助手 · Host 半片（单文件、零构建）
 *
 * 职责只有四件事：
 *   1. 找到本机格式匠的可执行文件，并从格式匠自己的数据库里读出「DSH 这条安装」的公开 ID；
 *   2. 用 dsh-mcp-client 的 stdio 桥接把格式匠挂进当前 Host，断开时能重新挂；
 *   3. 把「通没通、为什么不通、下一步点哪」讲清楚，并把状态开给插件页读取；
 *   4. 把从收稿到交付的完整任务链、套版、提交检查与资料取证作为运行时技能交给模型按需加载。
 *
 * 边界：这里不代理任何格式匠业务工具，也不保存 token。token 由格式匠写在
 * 受保护的桥接描述里，桥接进程自己读；本插件只负责把它拉起来。
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { defineTool as defineToolRaw } from '@deepseek-ai/dsh-tools';

export const name = 'formatjiang-assistant';

/**
 * 只有 tools 是硬依赖。
 *
 * mcpManager 与 webServer 由宿主的不同 bundle 提供，谁先启动没有保证；
 * 把它们写成硬依赖时，服务没就绪就会让整个插件停在 pending——工具、技能、
 * 系统提示与面板路由一起不出现，界面上只表现成「插件页一直在读状态」。
 * 现在改成「等到了再装配」（见 apply 里的 whenReady）。
 */
export const inject = ['tools'];

const require = createRequire(import.meta.url);

/** 网关里的服务名，决定工具前缀 mcp__formatjiang__。 */
const SERVER_NAME = 'formatjiang';
const ROUTE_BASE = '/formatjiang/api';
const EXE_NAME = '格式匠.exe';
const STARTUP_TIMEOUT_MS = 90000;
const TOOL_CALL_TIMEOUT_MS = 270000;

/**
 * 桥接不归本插件挂时的说明。
 *
 * 预设作用域下，宿主这半边的插件仍然要在：插件页、/formatjiang 命令、技能与
 * 附件工具都靠它。只有桥接这一件事搬进了「格式匠」预设，所以要点明去哪儿找工具，
 * 不然用户只会看到「未挂载」。
 */
const MOUNT_SCOPE_HINT = {
  // 只陈述分工，不下「你没选预设」的结论：这句话会原样贴进工具结果，模型会照着它
  // 向用户解释，而「会话选了预设、桥接也连上了」与这句话字面上并不冲突。
  preset: '业务工具由「格式匠」预设里的官方 mcp 客户端提供，只对选了这个预设的会话可见；宿主工具（附件、会话身份）走独立的本机通道，不受它影响',
  off: '插件配置里关掉了桥接（mountScope: off），格式匠工具需要你在别处自己配 mcp 客户端',
};

/* ------------------------------------------------------------------ *
 * 两份实例之间的交接
 * ------------------------------------------------------------------ */

/**
 * 同一个插件在 profile 里可能有两份：宿主那一份（工具、面板、命令、技能）与预设那一份
 * （只挂桥接）。它们是两次 apply，内存不共享；而插件页、formatjiang_status 与 /formatjiang
 * 命令都归宿主那一份——预设里到底连上没有，宿主那一份自己看不到。
 *
 * 这里用一个小文件当交接台，两个方向各自有用：
 *   - presetBridge：预设那一份把桥接状态写出来，面板与状态工具才能说清那个会话里通没通；
 *   - hostTarget：用户手填了 executablePath / installationId 时，预设那一份照抄，
 *     不必在预设行里再填一遍（填漏了也还能发现）。
 *
 * 读写全部兜底：没有这个文件、权限不够、内容坏了，都只当「没有旁证」，不影响桥接本身。
 */
const SHARED_STATE_FILE = (() => {
  try {
    // 测试与多 profile 并行时要能把这份交接台挪走，不能默认写进用户真身那份。
    const override = String(process.env.FORMATJIANG_STATE_FILE || '').trim();
    if (override) return path.resolve(override);
    return path.join(os.tmpdir(), 'dsh-formatjiang-assistant', 'state.json');
  } catch {
    return '';
  }
})();

/** 交接信息只在最近这段时间里当成「现在」；更旧的只当历史，不当结论。 */
const SHARED_TTL_MS = 10 * 60 * 1000;
/** 预设那一份每隔这么久重写一次状态，保证长连接也不会让交接记录过期。 */
const PRESET_HEARTBEAT_MS = 4 * 60 * 1000;

let sharedCache = { at: 0, value: null };

function readSharedState() {
  if (!SHARED_STATE_FILE) return {};
  const now = Date.now();
  if (sharedCache.value && now - sharedCache.at < 2000) return sharedCache.value;
  let value = {};
  try {
    const raw = JSON.parse(fs.readFileSync(SHARED_STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) value = raw;
  } catch {
    /* 还没有这个文件是常态 */
  }
  sharedCache = { at: now, value };
  return value;
}

function writeSharedState(key, payload) {
  if (!SHARED_STATE_FILE || !key) return;
  try {
    const all = { ...readSharedState(), [key]: payload };
    fs.mkdirSync(path.dirname(SHARED_STATE_FILE), { recursive: true });
    fs.writeFileSync(SHARED_STATE_FILE, JSON.stringify(all), 'utf8');
    sharedCache = { at: Date.now(), value: all };
  } catch {
    /* 写不进去只是少一条旁证 */
  }
}

function freshShared(key) {
  const entry = readSharedState()[key];
  if (!entry || typeof entry !== 'object') return null;
  const at = Number(entry.at) || 0;
  if (!at || Date.now() - at > SHARED_TTL_MS) return null;
  return entry;
}

/**
 * 丢掉交接台的读取缓存。
 *
 * 只给测试用：用例会直接改那个文件模拟「预设那一份写了状态」，缓存不丢就测不出来。
 * 运行时没有调用点。
 */
export function __resetSharedCache() {
  sharedCache = { at: 0, value: null };
}

/**
 * 把同目录包的地址换成另一个包的地址。
 *
 * 宿主会改写模块解析（dsh-app-boot 的 profile-resolution）：从 profile 之外的插件里
 * import `@deepseek-ai/*`，只有解析层登记过、且能在某一级 node_modules 里找到声明的位置
 * 才会被路由到安装目录，否则抛 `Cannot find package`。`dsh-tools` 够得着，
 * `dsh-mcp-client` 未必——但两个包同属一个安装目录，把路径里的包名那一段换掉，
 * 就能直接拿到同一份模块，不必依赖解析层的路由规则。
 *
 * @param {string} baseUrl 已经能解析的包地址（file URL）。
 * @param {string} fromName 原包名，如 `@deepseek-ai/dsh-tools`。
 * @param {string} toName 目标包名。
 * @returns {string} 目标地址；推不出来时返回空串。
 */
export function siblingModuleUrl(baseUrl, fromName, toName) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return '';
  const from = String(fromName).split('/').pop();
  const to = String(toName).split('/').pop();
  if (!from || !to || !baseUrl.includes(`/${from}/`)) return '';
  return baseUrl.replace(`/${from}/`, `/${to}/`);
}

/**
 * 桥接断开后的自动重连节奏。
 *
 * 宿主的 mcp 客户端自己会重试十次（约 150 秒）；那之后它把工具撤掉、进入 failed，
 * 就不再有别人替我们拉起桥接了。这里只接住这一段：failed 之后重挂一次，
 * 间隔从 15 秒起翻倍，最多 3 次。不做更密的轮询——桥接起不来通常是格式匠被关、
 * 正在更新或凭据失效，重挂太勤只会刷日志。
 */
const AUTO_RECONNECT_DELAYS_MS = [15000, 30000, 60000];
const AUTO_RECONNECT_MAX = 3;
const AUTO_RECONNECT_TICK_MS = 10000;
/** 用户完全退出格式匠时桥接会拒绝对话；这类错误不该被自动重连反复触发。 */
const USER_EXIT_PATTERN = /完全退出/;

/**
 * 端口存活探测与桥接旁证。
 *
 * `mcp_settings.json` 里的 `enabled` 是配置事实，不是「现在有人在听」；面板 8 秒问一次
 * 状态，所以这里缓 5 秒：够新，又不会每一轮都连一次端口。
 *
 * 桥接启动失败时宿主只转述 `SdkError: Connection closed`（子进程一退，stdout 就关了），
 * 真正的原因写在子进程自己的 stderr 里。需要时可以自己起一次同样的命令把那行捞回来，
 * 但它会起进程，所以最多 60 秒一次，并且只在网关确实在监听时做——那种情况下桥接不会
 * 替我们拉起格式匠，探测不会变成一次意外的启动。
 */
const GATEWAY_PROBE_TTL_MS = 5000;
const BRIDGE_PROBE_TTL_MS = 60 * 1000;
const BRIDGE_PROBE_TIMEOUT_MS = 2500;

/**
 * 打开格式匠之后等网关就绪的时间。
 *
 * 桌面程序启动要过几步：进程起来、打开数据库、再拉起 MCP 服务，冷启动十几秒很常见。
 * 调用方（模型）需要一个「现在到底就绪没有」的事实，否则只能回一句「等一会再试」。
 * 上限 25 秒；测试用 FORMATJIANG_OPEN_WAIT_MS 调小，避免每条用例都等满。
 */
const OPEN_WAIT_MS = Math.max(0, Number(process.env.FORMATJIANG_OPEN_WAIT_MS) || 25000);
const OPEN_WAIT_INTERVAL_MS = 600;

/**
 * 能力清单的缓存与上限。
 *
 * 面板每 8 秒问一次状态，清单没必要跟着刷：它只在连接成功或用户手动刷新时才变。
 * 单条描述与条目数都设上限，避免一条 /state 响应被几十个工具的说明撑爆。
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;
/** 读失败（多为旧版本没有清单接口）时隔久一点再试：每次尝试都会真的执行一次程序。 */
const CATALOG_ERROR_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 20000;
// 收件区单文件上限，与格式匠 MCP 文件交换的上限保持一致。
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

const CATALOG_ITEM_CAP = 200;
const CATALOG_DESC_LIMIT = 80;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1']);

/** 随插件注册的工作流技能名；模型用 skill 工具按名字加载它。 */
const SKILL_NAME = 'formatjiang-paper';

/** 插件版本，取自同目录的 package.json；读不到就留空，不编造。 */
const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '');
  } catch {
    return '';
  }
})();

/**
 * 随插件注册的工作流技能正文。
 *
 * 只写流程与判据，不复述工具清单——工具说明里已经有一份，写重了就会一边更新一边过时。
 * 这些流程共用同一条前提：先发现 ID 再动手，任何数字都要能在工具返回里找到出处。
 */
const SKILL_CONTENT = [
  '# 格式匠论文工作流',
  '',
  '本机格式匠通过 `mcp__formatjiang__*` 工具提供论文项目、受管版本、版式配置、提交检查、引文核对与本地资料。所有流程共用同一条前提：**先发现 ID 再动手**，任何数字都要能在工具返回里找到出处。',
  '',
  '## 连接异常',
  '',
  '格式匠有两条通道，先分清是哪一条出问题，别互相等：',
  '',
  '- **业务工具**（`mcp__formatjiang__*`）：由 MCP 连接提供。preset 模式下来自「格式匠」预设里的官方 mcp 客户端，本会话没选那个预设就没有它们；格式匠退出后它们会从工具表消失，重连回来后外部服务工具名还可能带新的随机后缀，以当前工具表为准。',
  '- **宿主工具**（`formatjiang_*`）：走独立的本机通道（`格式匠.exe mcp host`），只要程序与安装 ID 在、格式匠在运行就能用，不需要业务工具先出现。附件收件、会话绑定、成品取回都走这条。',
  '',
  '工具报连接错误或调用超时，先 `formatjiang_status`：它分别报桥接与宿主通道。格式匠没在运行就 `formatjiang_open`（会等端口就绪）；`formatjiang_connect` 只在 mountScope 是 host 时才有意义，preset 模式下它只会说「不用重连」。不要在断线状态下反复重试业务工具，也不要把连接失败说成论文本身的问题。',
  '',
  '用户要求的是「在格式匠里建论文 / 套版」而这条链路走不通时，停下来把阻塞点与下一步讲清楚并问用户；不要用手写脚本排版冒充格式匠的产物。',
  '',
  '## 一份新稿从对话走到成品',
  '',
  '这是最长的一条链，中途任何一步都可能中断，所以每步都留下可以用编号接着做的位置。',
  '',
  '1. `formatjiang_stage_attachment({ path })` 把用户交给你的文件复制进格式匠收件区，拿到 `file_id`；这一步走宿主通道，不依赖业务工具是否在表里，收件区也只接受这一步送进去的文件。',
  '2. 暂存工具已经通过宿主通道登记附件并返回 file_id，不要再调用 receive_file；它还会绑定本次真实聊天。',
  '3. `formatjiang_import_document({ file_id, as_new_paper, request_id })`：新建论文；或传 `paper_id`（可加 `parent_version_id`）往既有论文追加版本。两者必须二选一，都不给会直接报错，不会替你新建论文。返回 `version_id` 后再进下一步；不要跳过导入直接改原文件。',
  '4. `formatjiang_session({ action: "bind", paper_id, version_id })` 把本机绑定到这篇论文（绑定按本机共享，所有对话共用一份）；换会话或断线后用 `formatjiang_session({ action: "get" })` 取回，不要重新问用户是哪一篇。',
  '5. `read_document_outline` → `read_document_chunk` 读稿；`search_document` 在全文里找具体句子。读到的是受管版本的真实正文，不要凭篇名推测内容。',
  '6. `create_structure_plan` 生成待确认的段落分类计划，`get_structure_plan` 复核条目；条目有歧义时逐条问用户，用户确认后 `confirm_structure_plan({ plan_id, expected_plan_hash })` 落成已确认快照。计划过期或源文件变过会返回 `FJ_SOURCE_CHANGED`，此时重新 `create_structure_plan`，不要拿旧计划硬套。',
  '7. `list_layout_configs` 找模板 → `preview_layout_plan` 预览影响范围（可带 `scope_mode` 与 `scope_selected_types` 只套部分段落类型）→ 用户明确同意后 `apply_layout_as_branch`。每次预览都会签发新的 `confirmation_token`；重新预览后要换一个新的 `request_id`——同一个 `request_id` 配新令牌会被当成「另一个请求」拒绝（FJ_CONFLICT）。只有同一次预览内的网络重试才沿用原编号。',
  '8. 需要检查时 `start_diagnostic_run` 异步启动，然后**在对话里等到底**：反复调用 `get_diagnostic_status({ run_id, wait_seconds: 120 })`，只要它返回的 status 还是 running 就再调一次，直到 completed/partial/failed/cancelled 才用 `list_findings` 分页读问题。中途可以 `cancel_diagnostic_run`，失败项用 `retry_diagnostic_run`。检查可能要跑十几分钟，但「让用户自己去应用里看结果」不算完成这项工作。',
  '9. `preview_diagnostic_outputs` 先看会写入多少条，再决定 `generate_commented_docx`、`generate_revision_draft` 或 `export_diagnostic_report`。',
  '10. 取回成品：这些工具返回 `file_id`，用 `formatjiang_save_file({ file_id, path })` 保存。只有返回 saved=true、大小和摘要核验通过，才能告诉用户已保存；不把二进制塞进对话。',
  '',
  '## 套版（把学校模板套到受管版本上）',
  '',
  '1. `list_papers` 找到论文；用户说的篇名对不上时先问，不要猜。',
  '2. 用 `list_versions` 或论文详情确认要处理的版本；套版只作用于受管版本，不碰用户手里的原件。',
  '3. `list_layout_configs` 找模板；用户给的是学校或期刊名时，用 `list_layout_profiles` 对一下类别。',
  '4. 版本还没有已确认结构快照时，按上面第 6 步走 `create_structure_plan` → `confirm_structure_plan`；`recognize_structure` 只给识别结果，不保存快照。',
  '5. `preview_layout_plan({ version_id, layout_config_id })` 返回 `plan.verdict`、`plan.conflicts`、`plan.protected_facts`、`plan.paragraph_summary` 与短时 `confirmation_token`。',
  '6. 先讲结论再问用户：`verdict` 为 block 时不能套用（也没有令牌），说清阻断原因；warn 要把冲突逐条念出来；pass 也要说明影响多少段落、哪些内容受保护。',
  '7. 用户在当前对话里明确同意后，`apply_layout_as_branch({ confirmation_token, request_id })`：`request_id` 由一个稳定值生成，同一次操作的重试必须复用。它创建**分支版本**，不覆盖源文件、不切换当前版本。',
  '8. 回来只报结果：新版本号与被保护结论；保护结论为 review 时说「部分内容核验未完成」，不替用户宣布已经全部合格。',
  '',
  '## 提交检查（跑诊断并交代结果）',
  '',
  '1. `list_diagnostic_profiles` 选方案：学位论文、期刊、盲审、导师意见核对的方案不同；用户没说就用默认方案，并说明用的是哪一个。',
  '2. 长稿用 `start_diagnostic_run` 异步跑，短稿也可用 `run_paper_diagnostic` 同步等。两者都可能调用格式匠配置的远程模型，耗时以分钟计；超时就说超时，不要改写成「检查完成」。',
  '3. 异步启动后必须**守到出结果**：`get_diagnostic_status({ run_id, wait_seconds: 120 })` 会替你等最多 60 秒，返回的 status 还是 running 就再调一次；一直等到不是 running 才算检查结束。只看一次 running 就收工、让用户去格式匠里翻记录，都属于没做完。',
  '4. `list_findings({ run_id, severity, offset })` 分页读问题清单；`run.findings` 只是首批，完整清单要翻页。',
  '5. 结论只讲能落到证据上的：每条问题带 message、severity 与 evidence（来源、段落序号、原文摘录）。不要自己编页码、章节号或「通过多少条」——格式匠只给问题清单。',
  '6. `source_changed` 为 true 表示源文件在检查后又变过，报告不能当作当前文件的结论，要提醒用户重跑。',
  '',
  '## 引文与页码核对',
  '',
  '1. `preview_citation_check({ paper_id, draft_id, version_id })` 先清点：有多少处引用可核对、哪些还缺来源。缺来源的先补，不要拿去核对。',
  '2. `start_citation_check` 启动运行，然后 `get_citation_check_run({ run_id, wait_seconds: 120 })` 守到出结论（返回的 status 还是 running 就再调一次），再用 `list_citation_check_items` 逐条读结果、`get_citation_check_item` 看原文摘录、候选页码与页码映射。核对可能要跑几分钟，但「让用户自己去应用里看」不算做完。',
  '3. 缺来源时 `list_citation_source_candidates` 在资料库里找，选定后 `preflight_citation_source` 体检；关联与改页码由用户在桌面确认，不要在对话里替用户落笔。',
  '4. 页面对不上要如实说「写成第 X 页，原文在第 Y 页」并给出摘录；不要用「看起来像」判断。',
  '',
  '## 找格式与格式共坊',
  '',
  '1. 需要外部模板时 `search_forge_templates` 检索共坊；未配置服务会返回 `configured=false`，这不是故障，说明本机没配共坊地址即可。',
  '2. `get_forge_template` 看详情与当前公开版本。',
  '3. `check_forge_import` 核对能否导入：`already_imported_id` 大于 0 说明本机已有这一版；`requires_confirmation` 为真时必须先把 `notices` 逐条念给用户。',
  '4. 用户明确接受后才 `import_forge_template({ template_id, version_id, confirm_profile_warnings })`，导入后得到本地 `layout_config_id`。',
  '5. 「找格式」生成任务用 `prepare_layout_generation` → `submit_layout_sources` → `start_layout_generation`，随后 `get_layout_generation_status({ run_id, wait_seconds: 120 })` 守到它进入 awaiting_* 或终态（还在推进就再调一次），按返回的 next_step 回应或读结果；断线后用 `list_layout_generations` 找任务、`list_layout_generation_events({ after_event_id })` 补读事件、`guide_layout_draft_revision` 看下一步该改哪里。',
  '',
  '## 资料、知识库与投稿',
  '',
  '1. `list_knowledge_bases` → `search_knowledge_base` 找依据；跨库检索用 `search_knowledge_bases`，命中带库名。',
  '2. 建库 `create_knowledge_base`，通过 `formatjiang_use_attachments({ operation: "import_knowledge_base_files", arguments: { knowledge_base_id, file_ids, request_id } })` 导入——只接受本次聊天接收过的文件编号；导入是异步的，用 `get_rag_run({ run_id, wait_seconds: 120 })` 守到解析结束（还在跑就再调一次），`cancel_rag_run` 取消。',
  '3. 需要落到原文时用 `get_document_page_evidence` 或 `get_page_preview`，把页码与摘录一起给出。',
  '4. 投稿前 `inspect_blind_review({ version_id })` 看匿名残留；整理交付用 `build_submission_package`，返回里的 `missing` 与 `unresolved_requirements` 必须原样转述，它们是要作者自己核对的清单，不是「材料已齐全」的证明。包内每项材料带自己的 `file_id`，需要交给作者时用 `formatjiang_save_file` 逐项取回；包内绝对路径不会下发，也不要向用户索要。',
  '',
  '## 审稿意见与回复信',
  '',
  '1. `get_research_context` 读研究约定，`list_submission_requirements` 读该稿型的投稿要求；两者都是作者自己填的口径，不要替作者改写。',
  '2. `list_review_items` 逐条读审稿意见；作者问「这一段被提了什么」时按 `block_id` 过滤。意见正文要逐字保留，不要概括。',
  '3. `summarize_review_items` 给处理进度；待处理、待材料、待复核都算没做完，不能合成一个完成率。',
  '4. `export_response_letter` 生成回复信并登记成受管文件，用 `formatjiang_save_file` 取回；`unresolved` 大于 0 时如实说明还有意见没处理完。',
  '',
  '## 星轨（写作台的结构视图）',
  '',
  '1. `get_symphony_state` 读这份稿子的星轨状态与最近运行；`get_symphony_report` 按章节或全篇读论证审查覆盖。',
  '2. 覆盖数字要分开说：`determined` 是已有当前判断，`insufficient` 与 `blocked` 是判不了，不能写成「已通过」。报告里没有任何判断时直说。',
  '3. `get_symphony_source_evidence` 只读已登记的来源摘录与页图，不联网取新内容。',
  '',
  '## 论文工坊（工作流运行与产物）',
  '',
  '1. `list_workshop_runs` 按论文或版本列出跑过的工作流；`get_workshop_run` 读阶段、自检项、发现项与产物清单。',
  '2. `read_workshop_artifact({ run_id, artifact_key })` 按 key 读产物正文；返回里的 `truncated` 为真时说明只读到截断位置，不要说成完整内容。',
  '3. 失败运行先看阶段里的 `error` 与发现项，再决定要不要用户在桌面重跑；不要在对话里另起一次运行。',
  '',
  '## 断线与中断任务',
  '',
  '1. `list_interrupted_tasks({ version_id })` 盘点上次退出时没做完的资料解析、提交检查与引文核对。',
  '2. 资料导入被打断时把选择交给用户：`resume_import_recovery({ action: "resume" })` 或 `cancel`；提交检查用 `retry_diagnostic_run`，引文核对用 `start_citation_check` 重新发起。',
  '3. 版式生成任务用 `list_layout_generations` 找回，按事件游标续读，不要从头重开一个任务。',
  '',
  '## 边界',
  '',
  '- 写操作（`apply_layout_as_branch`、`save_layout_generation`、`install_skill_pack`、`import_document`、`confirm_structure_plan`、`reject_structure_plan`、`generate_commented_docx`、`generate_revision_draft`、`adopt_version`、`annotate_version`、`import_forge_template`、`create_knowledge_base`、`import_knowledge_base_files`、`cancel_rag_run`、`build_submission_package`、`resume_import_recovery`、`export_response_letter`）共十七项都受格式匠 safe-write 开关约束；开关关闭时它们不会出现，不要假设一定可用。',
  '- 不接触用户没有导入格式匠的文件，不把这些工具当通用文件系统或联网搜索。',
  '- 受限入口（只授权了某几篇论文的会话）里取文件、列工坊运行、按引用找资料都必须带 `paper_id`：这些能力的对象编号本身不足以判断归属，不带会被直接拒绝。',
  '- 结果里的本机路径、模型名与 token 一律不转述给用户；token 只用于当次调用。',
  '- 对话里的卡片由插件渲染，回答里不要复述卡片内容。',
].join('\n');

function okText(text) {
  return [{ type: 'text', text }];
}

function nestedId(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  for (const key of keys) {
    const found = value[key];
    if (found !== undefined && found !== null && found !== '') return found;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
    const found = nestedId(child, keys, depth + 1);
    if (found !== '') return found;
  }
  return '';
}

function researchCursor(start) {
  const seen = new Set();
  let dir = start;
  for (let i = 0; i < 4 && dir; i += 1) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const file = path.join(dir, '.workbench', 'cursor.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* 继续向上找研究项目 */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    executablePath: String(config.executablePath || '').trim(),
    installationId: String(config.installationId || '').trim(),
    dataDir: String(config.dataDir || '').trim(),
    startupTimeoutMs: number(config.startupTimeoutMs, STARTUP_TIMEOUT_MS),
    toolCallTimeoutMs: number(config.toolCallTimeoutMs, TOOL_CALL_TIMEOUT_MS),
    /** 默认开：桥接断开后自动重挂，用户显式写 false 才关。 */
    autoReconnect: config.autoReconnect !== false,
    /**
     * 桥接归谁挂。
     *
     * host（默认）= 本插件在宿主层挂，工具对每个会话都可见；installed 的 MCP 工具
     * 有 110 个、每轮约 17k token，不想让它常驻的人就把这里改成 preset。
     * preset = 宿主这半边不挂，桥接由「格式匠」预设里那一份（bridgeOnly）负责，
     * 只有选了这个预设的会话才看得见格式匠工具。
     * off = 都不挂，用户自己在别处配 mcp 客户端。
     */
    mountScope: config.mountScope === 'preset' ? 'preset' : config.mountScope === 'off' ? 'off' : 'host',
    /** 只干桥接这一件事（预设作用域里的那一份）：不注册工具、提示、技能、命令与面板。 */
    bridgeOnly: config.bridgeOnly === true,
  };
}

/* ------------------------------------------------------------------ *
 * 发现：程序、数据目录、安装 ID
 * ------------------------------------------------------------------ */

/** 格式匠的数据目录候选：环境变量优先，其次是它默认放在用户主目录下的位置。 */
function dataDirCandidates(config) {
  const out = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const resolved = path.resolve(text);
    if (!out.includes(resolved)) out.push(resolved);
  };
  push(config.dataDir);
  push(process.env.FORMATJIANG_DATA_DIR);
  try {
    push(path.join(os.homedir(), 'formatjiang-data'));
  } catch {
    /* 拿不到主目录就只剩显式配置 */
  }
  return out;
}

/** 可执行文件候选：显式配置优先，然后按常见安装位置逐个试。 */
function executableCandidates(config) {
  const out = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const resolved = path.resolve(text);
    if (!out.includes(resolved)) out.push(resolved);
  };
  push(config.executablePath);
  push(process.env.FORMATJIANG_HOME && path.join(process.env.FORMATJIANG_HOME, EXE_NAME));
  const home = (() => {
    try {
      return os.homedir();
    } catch {
      return '';
    }
  })();
  if (home) push(path.join(home, 'Desktop', 'formatjiang', EXE_NAME));
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'Programs', 'formatjiang', EXE_NAME));
  if (process.env.ProgramFiles) push(path.join(process.env.ProgramFiles, 'formatjiang', EXE_NAME));
  if (process.env['ProgramFiles(x86)']) push(path.join(process.env['ProgramFiles(x86)'], 'formatjiang', EXE_NAME));
  return out;
}

function resolveExecutable(config) {
  const candidates = executableCandidates(config);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return { path: candidate, candidates };
    } catch {
      /* 下一个 */
    }
  }
  return { path: '', candidates };
}

/**
 * 读格式匠的 mcp_settings.json，只为汇报端口与开关；读不到不影响挂载。
 *
 * 插件页每 8 秒问一次状态，配置又变得很慢，所以结果留 2 秒：既不会读到旧状态，
 * 也不会让连点刷新把同一份文件重复读一遍。文件不存在时也走缓存，避免每次都 stat。
 */
const settingsCache = { key: '', at: 0, value: null };
function readMcpSettings(dataDir) {
  if (!dataDir) return null;
  const now = Date.now();
  if (settingsCache.key === dataDir && now - settingsCache.at < 2000) return settingsCache.value;
  let value = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp_settings.json'), 'utf8'));
    value = {
      enabled: raw?.enabled !== false,
      port: Number(raw?.port) || 0,
      safeWrite: raw?.safe_write_enabled === true,
    };
  } catch {
    value = null;
  }
  settingsCache.key = dataDir;
  settingsCache.at = now;
  settingsCache.value = value;
  return value;
}
/**
 * 从格式匠数据库里挑一条可用于 DSH 的本机安装。
 *
 * 只读打开，只取公开 ID 与类型；token 与桥接描述都在格式匠的受保护存储里，
 * 本插件不读、不复制、不缓存。优先级：客户端类型已是 dsh 的最新一条，
 * 其次是最新的可用 stdio 安装（通用 stdio 桥接与 DSH 共用同一条通道）。
 */
function discoverInstallation(dataDir) {
  if (!dataDir) return { id: '', kind: '', error: '未找到格式匠数据目录' };
  const dbPath = path.join(dataDir, 'db', 'docx-cli.db');
  if (!fs.existsSync(dbPath)) return { id: '', kind: '', error: `没有找到格式匠数据库：${dbPath}` };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT public_id, client_kind FROM mcp_gateway_installations "
          + "WHERE transport = 'stdio' AND status <> 'revoked' "
          + "ORDER BY CASE WHEN client_kind = 'dsh' THEN 0 WHEN client_kind = 'generic_stdio' THEN 1 ELSE 2 END, id DESC LIMIT 1",
      )
      .get();
    if (!row) {
      return {
        id: '',
        kind: '',
        error: '格式匠里还没有可用的本机安装：在格式匠的 设置 → MCP → 「连接外部助手」里选「其他本机客户端（stdio 桥接）」并应用，完成后回到这里调用 formatjiang_connect',
      };
    }
    return { id: String(row.public_id || ''), kind: String(row.client_kind || ''), error: '' };
  } catch (error) {
    return { id: '', kind: '', error: `读取格式匠数据库失败：${String(error?.message || error)}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 宿主装配
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  // logger 是宿主挂在上下文上的对象，但「直接取属性」这条路在别的服务上会抛
  // `cannot get property ... without inject`；日志出口不值得让整条装配冒这个险。
  const logger = (() => {
    try {
      return ctx.logger ?? ctx.get?.('logger') ?? null;
    } catch {
      try {
        return ctx.get?.('logger') ?? null;
      } catch {
        return null;
      }
    }
  })();
  // mcpManager 服务可能在装配完成之后才有；这里先声明，取用走 mcpManager()。
  // 必须声明在 state 之前：预设那一条在装配早期就会问「宿主是不是已经在挂桥接」，
  // 声明太晚会撞上暂时性死区（访问未初始化 let 直接抛错）。
  let mcpManagerService = null;
  /** 预设那一份加载到的 mcp-client 模块：只加载一次，两条 import 路径共用。 */
  let mcpClientModule = null;
  const state = {
    disposeServer: null,
    /** 预设作用域那一份的 mcp-client 句柄与状态单元（见 mountScopedBridge）。 */
    scopedHandle: null,
    scopedStatus: null,
    scopedLoading: false,
    /** 预设那份的状态订阅与「已经被卸载」标记：异步挂载回来时据此决定还能不能动手。 */
    scopedUnsub: null,
    scopedDisposed: false,
    presetHeartbeat: null,
    /** 预设那一份已重挂次数、挂起的重挂定时器、正在探端口的标记（见 schedulePresetRemount）。 */
    presetRemounts: 0,
    presetRemountTimer: null,
    presetProbing: false,
    /** 上次把目标交给预设那一份的时间（一分钟节流）。 */
    handoffAt: 0,
    /** 预设那一份要用的 mcp-client 模块能不能加载：{ ok, error, at }，见 refreshMcpClientCheck。 */
    mcpClientCheck: null,
    mcpClientChecking: false,
    lastMcpClientError: '',
    /** 上一次成功取到 mcp-client 走的是哪条路（宿主加载器 / import / 安装目录）。 */
    mcpClientVia: '',
    mountError: '',
    lastMountAt: 0,
    mounting: false,
    lastOpenError: '',
    /** 自动重连：本轮已重挂次数、上次重挂时间、定时器句柄。 */
    autoRemounts: 0,
    lastAutoRemountAt: 0,
    autoTimer: null,
    /** 正在探测网关端口，避免同一时刻发起多次探测。 */
    probing: false,
    /** 能力清单缓存：{ key, at, error, value }；value 为 null 表示这次没读到。 */
    catalog: null,
    catalogPending: null,
    catalogBusy: false,
    /** 用户手动断开后置真：守护定时器不再自动重挂，直到下一次显式连接。 */
    paused: false,
    /**
     * 装配期失败。存在的意义是「一次也不许静默」：以前任何一条工具定义写错、
     * 任何一个服务没就绪，插件就整条不装配，界面上只剩一句永远读不完的状态。
     * 现在失败进这里，由 /state 与 formatjiang_status 原文报出来。
     */
    faults: [],
    /** 面板接口是否登记成功：插件页读不到状态时，这是第一个要看的判据。 */
    panel: null,
    /** 网关端口是否真的在监听：null 表示还没探过。配置里的「已开启」不代表进程在听。 */
    gateway: { listening: null, at: 0 },
    /** 桥接启动失败的旁证：最近一次探测时间、子进程自己写的原因、是否正在探。 */
    probeAt: 0,
    probeReason: '',
    probeBusy: false,
    /**
     * 正在进行的「打开格式匠」。
     *
     * 两个会话同时问「格式匠怎么没数据」时，两次调用都会去 spawn 一次；桌面程序
     * 未必有单实例保护，结果就是开两个窗口、两份初始化。这里让后到的那次直接等
     * 同一个 Promise，只启动一次。
     */
    opening: null,
    target: { executable: '', installationId: '', installationKind: '', dataDir: '', error: '' },
  };

  /** 记一条装配失败：只记录，不抛出，后面的工具与页面仍然继续装。 */
  function recordFault(label, error) {
    const message = String(error?.message || error);
    state.faults.push({ label, message, at: new Date().toISOString() });
    if (state.faults.length > 10) state.faults.shift();
    try {
      logger?.error?.(`[formatjiang] ${label} 装配失败：${message}`);
    } catch {
      /* 日志出口自己坏了不影响装配 */
    }
  }

  /**
   * 工具定义的安全包装。
   *
   * 宿主会对参数与输出 schema 做严格校验（例如 object 必须显式写 additionalProperties），
   * 校验失败是同步抛错。以前这个抛错会掀掉整条装配链：后面的工具、系统提示、技能、
   * 面板路由、桥接全部不执行。现在单条失败只记一笔，其余照常。
   */
  function defineTool(options) {
    try {
      return defineToolRaw(options);
    } catch (error) {
      recordFault(`工具 ${options?.name || '未命名'}`, error);
      return null;
    }
  }

  /** 一条装配各自兜底；label 会出现在失败记录里，便于定位是哪一段没装上。 */
  function safeEffect(run, label) {
    try {
      return ctx.effect(() => {
        try {
          return run();
        } catch (error) {
          recordFault(label, error);
          return () => {};
        }
      }, label);
    } catch (error) {
      recordFault(label, error);
      return () => {};
    }
  }

  /**
   * 等服务就绪后再装配。
   *
   * 宿主提供 ctx.inject：服务出现才执行，服务重启会自动重跑，卸载时回收。
   * 没有这个能力的老宿主只装配一次，缺服务时留下可读记录，不再静默放弃。
   */
  function whenReady(name, run, label, onError) {
    const fail = (error) => {
      recordFault(label, error);
      try {
        onError?.(error);
      } catch {
        /* 失败回调自己出错不影响别的装配 */
      }
    };
    if (typeof ctx.inject === 'function') {
      try {
        return ctx.inject([name], (scope) => {
          try {
            return run(scope);
          } catch (error) {
            fail(error);
            return () => {};
          }
        });
      } catch (error) {
        fail(error);
        return () => {};
      }
    }
    return safeEffect(() => run(ctx), label);
  }

  /* ---------------------- 预设作用域的那一份 ---------------------- */

  /**
   * 预设里的这一份只做桥接。
   *
   * mcpManager 是在它自己的上下文里挂 mcp-client 实例的（dsh-mcp-manager
   * src/index.ts:502 的 `this.ownerContext.plugin(McpClient, ...)`），注册出来的工具
   * 属于宿主作用域，每个会话都看得见。要在预设作用域里挂，只能自己 ctx.plugin 一个
   * mcp-client：它的工具就落在当前作用域上，只有选了这个预设的会话能看见。
   *
   * 模块走动态 import：宿主那一份根本不加载它；万一 profile 里没有这个包，
   * 也只会在预设这一份留下一条可读的失败记录，不会把整个插件带崩。
   */
  async function loadMcpClient({ quiet = false } = {}) {
    try {
      if (mcpClientModule) return mcpClientModule;
      const mod = await importMcpClientModule();
      const client = mod?.Config && mod?.connectionStatusOf ? mod : mod?.default;
      if (!client?.Config || typeof client?.apply !== 'function') {
        throw new Error('模块里没有可用的 mcp-client 插件');
      }
      mcpClientModule = client;
      return client;
    } catch (error) {
      // 探路（只问「能不能加载」）不记装配失败：那是查询，不是装配现场。
      // 但两种路径都要把原文留下：预设那边的失败记录要能直接看出是哪一步不行。
      state.lastMcpClientError = String(error?.message || error);
      if (!quiet) recordFault('MCP 客户端模块', error);
      return null;
    }
  }

  /**
   * 取 mcp-client 模块，三条路依次试。
   *
   * 一、宿主的插件加载器（cordis-plugin-loader lib/index.js:343
   *     `this.ctx.loader.internal.import(name, this.ctx.baseUrl, {})`）。profile 里
   *     `name:` 那一行插件名就是这么解析的，parent 是 profile 配置的地址，宿主的解析层
   *     认得，能路由到安装目录里的包。
   * 二、直接 import。少数宿主没有 loader 服务，或者 loader 没有 internal。
   * 三、按安装目录拼地址（见 siblingModuleUrl）：用能解析的 dsh-tools 推出同目录的
   *     mcp-client 地址。这条不依赖解析层的路由规则。
   *
   * 三条都失败时把三边的原因一起抛出，失败记录里能直接看到断在哪一步。
   */
  async function importMcpClientModule() {
    const reasons = [];
    const viaLoader = loaderModuleImporter();
    if (viaLoader) {
      try {
        const mod = await viaLoader();
        state.mcpClientVia = '宿主加载器';
        return mod;
      } catch (error) {
        reasons.push(`经宿主加载器：${String(error?.message || error)}`);
      }
    }
    try {
      const mod = await import('@deepseek-ai/dsh-mcp-client');
      state.mcpClientVia = 'import';
      return mod;
    } catch (error) {
      reasons.push(`直接 import：${String(error?.message || error)}`);
    }
    const base = mcpClientBaseUrl();
    const sibling = base
      ? siblingModuleUrl(base, '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client')
      : '';
    if (sibling) {
      try {
        const mod = await import(sibling);
        state.mcpClientVia = '安装目录';
        return mod;
      } catch (error) {
        reasons.push(`按安装目录 import：${String(error?.message || error)}`);
      }
    } else if (base) {
      reasons.push('按安装目录 import：同目录包的地址里没有包名那一段');
    } else {
      reasons.push('按安装目录 import：拿不到同目录包的地址');
    }
    throw new Error(reasons.join('；'));
  }

  /**
   * 用宿主的加载器 import 一个包名。
   *
   * 拿不到 loader 服务或 baseUrl 时返回 null（不是错误）：那只是这条路走不通，
   * 后面还有两条。真正抛错发生在调用方那一层。
   */
  function loaderModuleImporter() {
    const loader = safeService('loader');
    const internal = loader && typeof loader === 'object' ? loader.internal : null;
    if (!internal || typeof internal.import !== 'function') return null;
    // baseUrl 是 profile 那份配置的地址：插件的 ctx 一般继承得到，取不到就问加载器自己。
    const base = [ctx.baseUrl, loader?.ctx?.baseUrl]
      .find((value) => typeof value === 'string' && value !== '');
    if (base === undefined) return null;
    return () => internal.import('@deepseek-ai/dsh-mcp-client', base, {});
  }

  /**
   * dsh-tools 解析出来的地址。
   *
   * 这个包的静态 import 是插件自己就在用的（defineTool 来自它），所以它一定解析得动；
   * 拿它当「安装目录长什么样」的样本。取不到就返回空串，不影响主路径。
   */
  function mcpClientBaseUrl() {
    try {
      if (typeof import.meta.resolve !== 'function') return '';
      return String(import.meta.resolve('@deepseek-ai/dsh-tools') || '');
    } catch {
      return '';
    }
  }

  /**
   * 预设那一份要用的 mcp 客户端能不能加载。
   *
   * 宿主那一份用不到它（走 mcpManager），所以只在预设作用域相关时才试。试出来的是
   * 「模块能不能 import」，不是「服务器连不连得上」——前者是装配问题，看这里最快。
   * 结果留 60 秒：每次快照都 import 一次没有意义，Node 的模块缓存也不该被当成探测。
   */
  function refreshMcpClientCheck() {
    if (state.mcpClientChecking) return;
    const last = state.mcpClientCheck;
    if (last && Date.now() - last.at < 60000) return;
    state.mcpClientChecking = true;
    void (async () => {
      try {
        const client = await loadMcpClient({ quiet: true });
        state.mcpClientCheck = client
          ? { ok: true, via: state.mcpClientVia, error: '', at: Date.now() }
          : { ok: false, via: '', error: state.lastMcpClientError || '加载失败', at: Date.now() };
      } finally {
        state.mcpClientChecking = false;
      }
    })();
  }

  /**
   * 把预设这一份的桥接状态写到交接台。
   *
   * 宿主那一份的面板、formatjiang_status 与 /formatjiang 命令都读它——不写的话，
   * 用户在那个会话里连没连上，插件页永远答「由预设提供」，等于没有观测。
   */
  function publishPresetBridge(status, extra = {}) {
    const value = {
      state: status?.state || extra.state || 'connecting',
      toolCount: Number(status?.toolCount) || 0,
      lastError: String(status?.lastError || extra.lastError || ''),
      at: Date.now(),
    };
    writeSharedState('presetBridge', value);
    return value;
  }

  /** 预设作用域里挂桥接：本作用域的 mcp-client 实例，工具随预设可见。 */
  async function mountScopedBridge({ restart = false } = {}) {
    if (state.scopedDisposed) return;
    if (state.scopedLoading) return;
    if (state.scopedHandle && !restart) return;
    if (state.scopedHandle && restart) disposeScopedBridge();
    if (typeof ctx.plugin !== 'function') {
      recordFault('预设桥接', new Error('当前宿主没有 ctx.plugin，无法在预设作用域里挂桥接'));
      publishPresetBridge(null, { state: 'failed', lastError: '当前宿主没有 ctx.plugin' });
      return;
    }
    // 宿主那一份也在挂桥接（mountScope: host 没改回来）时，两边会用同一个服务名各挂一份，
    // 同一个会话里就会出现两套同名工具。这里直接让预设这一份停下，别去制造那个现场。
    // 先问 mcpManager（真话，不怕过期），再退回交接台上那条记录（宿主自己还没轮到装配时）。
    const hostOwnsBridge = (() => {
      try {
        const manager = mcpManager();
        return Boolean(manager?.list?.().some((item) => item?.name === SERVER_NAME));
      } catch {
        return false;
      }
    })();
    const hostBridge = freshShared('hostBridge');
    if (hostOwnsBridge || hostBridge?.mounted === true) {
      const message = '宿主那半边已经在挂桥接（mountScope 还是 host），预设这一份不重复挂；要按预设加载就把插件配置改成 mountScope: preset';
      recordFault('预设桥接', new Error(message));
      publishPresetBridge(null, { state: 'failed', lastError: message });
      return;
    }
    state.scopedLoading = true;
    try {
      const resolved = resolveTarget();
      let target = resolved;
      // 预设行一般只写 bridgeOnly；宿主那份如果手填了路径或安装 ID，这里照抄，
      // 免得出问题时要用户在两行里各填一遍（少填一处就变成「预设里连不上」）。
      if (target.error) {
        const hostTarget = freshShared('hostTarget');
        if (hostTarget?.executable && hostTarget?.installationId) {
          target = {
            ...target,
            executable: String(hostTarget.executable),
            installationId: String(hostTarget.installationId),
            dataDir: String(hostTarget.dataDir || target.dataDir || ''),
            installationKind: 'host-config',
            error: '',
          };
          state.target = target;
        }
      }
      if (target.error) {
        state.mountError = target.error;
        publishPresetBridge(null, { state: 'failed', lastError: target.error });
        return;
      }
      publishPresetBridge(null, { state: 'connecting' });
      const client = await loadMcpClient();
      if (!client) {
        publishPresetBridge(null, { state: 'failed', lastError: state.lastMcpClientError || 'MCP 客户端模块加载失败' });
        return;
      }
      // 等模块的这段时间里插件可能已经被卸载：这时不能再往作用域里挂东西。
      if (state.scopedDisposed) return;
      const options = client.Config({
        transport: 'stdio',
        serverName: SERVER_NAME,
        command: target.executable,
        args: ['mcp', 'bridge', '--installation-id', target.installationId],
        startupTimeoutMs: config.startupTimeoutMs,
        toolCallTimeoutMs: config.toolCallTimeoutMs,
        // 格式匠没开、正在装更新时连不上是常态：让会话照常可用，状态留在面板里。
        failOnStartupError: false,
      });
      const handle = ctx.plugin(client, options);
      state.scopedHandle = handle;
      state.lastMountAt = Date.now();
      state.mountError = '';
      void handle.await().then(() => {
        if (state.scopedHandle !== handle) return;
        const cell = client.connectionStatusOf(handle) ?? null;
        state.scopedStatus = cell;
        if (!cell) {
          publishPresetBridge(null, { state: 'failed', lastError: 'mcp 客户端没有给出连接状态' });
          return;
        }
        publishPresetBridge(cell.current());
        schedulePresetRemount(cell.current());
        state.scopedUnsub = cell.onChange((next) => {
          publishPresetBridge(next);
          schedulePresetRemount(next);
        });
        // 状态不变时不会有新记录，十分钟后宿主那边会当这份交接过期。每四分钟重写一次
        // 「现在还是这个状态」——几字节的文件，换来面板不会在长连接下突然失忆。
        state.presetHeartbeat = setInterval(() => {
          try {
            void publishPresetBridge(cell.current());
          } catch {
            /* 状态单元自己坏了就等下一条 onChange */
          }
        }, PRESET_HEARTBEAT_MS);
        try {
          state.presetHeartbeat.unref?.();
        } catch {
          /* 非 Node 环境没有 unref */
        }
      }).catch((error) => {
        if (state.scopedHandle !== handle) return;
        state.mountError = String(error?.message || error);
        recordFault('预设桥接', error);
        publishPresetBridge(null, { state: 'failed', lastError: state.mountError });
      });
    } catch (error) {
      state.mountError = String(error?.message || error);
      recordFault('预设桥接', error);
      publishPresetBridge(null, { state: 'failed', lastError: state.mountError });
    } finally {
      state.scopedLoading = false;
    }
  }

  /**
   * 卸载预设这一份：先断订阅、把交接台标成已关闭，再等桥接自己收干净。
   *
   * `final` 只给「插件真的被卸载」用：它把这份实例钉死，之后异步回来的挂载请求一律作废。
   * 重挂（restart）只清当前这一份连接，不能顺手钉死实例，否则重挂之后连加载都过不去。
   */
  function disposeScopedBridge({ final = false } = {}) {
    if (final) state.scopedDisposed = true;
    const handle = state.scopedHandle;
    state.scopedHandle = null;
    state.scopedStatus = null;
    try {
      state.scopedUnsub?.();
    } catch {
      /* 状态单元自己坏了不影响卸载 */
    }
    state.scopedUnsub = null;
    if (state.presetHeartbeat) {
      try {
        clearInterval(state.presetHeartbeat);
      } catch {
        /* 已经清过就算了 */
      }
      state.presetHeartbeat = null;
    }
    if (state.presetRemountTimer) {
      try {
        clearTimeout(state.presetRemountTimer);
      } catch {
        /* 已经清过就算了 */
      }
      state.presetRemountTimer = null;
    }
    if (!handle) return undefined;
    publishPresetBridge(null, { state: 'closed', lastError: state.mountError || '' });
    try {
      // 返回 promise，cordis 会等它收完再算卸载完成（管理器也是这么做的）。
      return handle.dispose();
    } catch (error) {
      logger?.warn?.(`[formatjiang] 卸载预设桥接失败：${String(error?.message || error)}`);
      return undefined;
    }
  }

  /**
   * 预设那一份连不上之后要不要重挂。
   *
   * 宿主那一份由 startSupervisor 每十秒看一次状态；预设这一份挂上桥接就装配完了，没有
   * 那个循环，所以接在状态回调上：进入 failed 按 15/30/60 秒重挂，最多 3 次。
   * 「用户把格式匠完全退出」这一类先探端口：开着才重挂，不替用户把程序拉起来。
   */
  function schedulePresetRemount(status) {
    if (!config.autoReconnect || state.scopedDisposed) return;
    const name = status?.state;
    if (name === 'connected') {
      state.presetRemounts = 0;
      return;
    }
    if (name !== 'failed' || state.presetRemountTimer) return;
    if (updateInProgress()) return;
    if (state.presetRemounts >= AUTO_RECONNECT_MAX) return;
    const message = String(status?.lastError || status?.reason || '');
    if (!USER_EXIT_PATTERN.test(message)) {
      queuePresetRemount('桥接断开');
      return;
    }
    if (state.presetProbing) return;
    state.presetProbing = true;
    gatewayListening()
      .then((alive) => {
        state.presetProbing = false;
        if (alive && !state.scopedDisposed) queuePresetRemount('格式匠已重新打开');
      })
      .catch(() => {
        state.presetProbing = false;
      });
  }

  /** 排一次重挂：延迟按次数递增，最多三次；同一时刻只留一个定时器。 */
  function queuePresetRemount(reason) {
    if (state.presetRemountTimer || state.scopedDisposed) return;
    const delay = AUTO_RECONNECT_DELAYS_MS[Math.min(state.presetRemounts, AUTO_RECONNECT_DELAYS_MS.length - 1)];
    state.presetRemounts += 1;
    state.presetRemountTimer = setTimeout(() => {
      state.presetRemountTimer = null;
      if (state.scopedDisposed) return;
      logger?.info?.(`[formatjiang] 预设桥接自动重挂第 ${state.presetRemounts} 次：${reason}`);
      void mountScopedBridge({ restart: true });
    }, delay);
    try {
      state.presetRemountTimer.unref?.();
    } catch {
      /* 非 Node 环境没有 unref */
    }
  }

  // 预设作用域的那一份到此为止：不注册工具、提示、技能、命令与面板。
  if (config.bridgeOnly) {
    safeEffect(() => {
      void mountScopedBridge();
      return () => disposeScopedBridge({ final: true });
    }, 'formatjiang: preset bridge');
    return;
  }

  /**
   * 读一个可选服务。
   *
   * Cordis 里直接 ctx.xxx 访问未 inject 的服务会抛
   * `cannot get property "xxx" without inject`；ctx.get 不追踪依赖，
   * 服务缺席返回 undefined。两条路都包一层：面板接口要能在服务没起来时照常答话。
   */
  function safeService(name) {
    // cordis 的正规读法是 ctx.reflect.get(name, strict=false)：不追踪依赖，缺席返回
    // undefined 而不抛。后面两条是兜底：不同版本的 Context 上挂的东西不一样。
    try {
      const value = ctx.reflect?.get?.(name, false);
      if (value !== undefined && value !== null) return value;
    } catch {
      /* 这个版本没有 reflect.get */
    }
    try {
      const value = ctx.get?.(name);
      if (value !== undefined) return value;
    } catch {
      /* 宿主还没有这个服务入口 */
    }
    return null;
  }

  /** mcpManager 服务可能还没就绪；所有取用点都走这里，缺席不抛。 */
  function mcpManager() {
    const manager = mcpManagerService ?? safeService('mcpManager');
    return manager && typeof manager === 'object' ? manager : null;
  }

  function resolveTarget() {
    const executable = resolveExecutable(config);
    const dataDir = dataDirCandidates(config).find((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    }) || '';
    const installation = config.installationId
      ? { id: config.installationId, kind: 'configured', error: '' }
      : discoverInstallation(dataDir);
    const target = {
      executable: executable.path,
      executableCandidates: executable.candidates,
      installationId: installation.id,
      installationKind: installation.kind,
      dataDir,
      error: '',
    };
    if (!target.executable) {
      target.error = `没有找到格式匠程序（${EXE_NAME}），可在插件配置里填写 executablePath`;
    } else if (!target.installationId) {
      target.error = installation.error || '没有找到可用的本机安装 ID';
    }
    state.target = target;
    return target;
  }

  /**
   * 把「程序在哪、安装 ID 是什么」写到交接台，供预设那一份使用。
   *
   * 只有桥接不归宿主时才做：宿主自己挂的时候预设那一份不会上场。
   * 一分钟最多解析一次——面板八秒问一次状态，而这条路径要读格式匠的数据库。
   * 内容没变也定期刷新时间戳，否则十分钟后预设那一份会以为这份交接过期了。
   */
  function handoffTarget() {
    const now = Date.now();
    if (state.handoffAt && now - state.handoffAt < 60000) return;
    state.handoffAt = now;
    let target;
    try {
      target = resolveTarget();
    } catch {
      return;
    }
    if (!target.executable || !target.installationId) return;
    const last = readSharedState().hostTarget;
    const same = last
      && last.executable === target.executable
      && last.installationId === target.installationId;
    if (same && now - (Number(last.at) || 0) < 60000) return;
    writeSharedState('hostTarget', {
      executable: target.executable,
      installationId: target.installationId,
      dataDir: target.dataDir || '',
      at: now,
    });
  }

  function unmount() {
    if (typeof state.disposeServer === 'function') {
      try {
        state.disposeServer();
      } catch (error) {
        logger?.warn?.(`[formatjiang] 卸载桥接失败：${String(error?.message || error)}`);
      }
    }
    state.disposeServer = null;
    // 交接台上跟着写一笔「宿主这边没挂」：预设那一份据此判断能不能上场。
    if (config.mountScope === 'host') writeSharedState('hostBridge', { mounted: false, at: Date.now() });
  }

  /**
   * 手动断开：卸掉桥接并停掉自动重连，方便调试「连不上」的一侧。
   *
   * 只影响本插件与桥接，不动格式匠本身；下一次显式连接（按钮、工具、命令）
   * 会把 paused 清掉并重新挂载。
   */
  function disconnect() {
    unmount();
    state.paused = true;
    state.mountError = '';
    state.autoRemounts = 0;
    state.lastAutoRemountAt = 0;
    return { ok: true, target: state.target };
  }

  /** 按当前配置挂载或重新挂载桥接；失败原因留在 state 里，由工具与插件页读出。 */
  function mount({ restart = false } = {}) {
    // 桥接已经交给预设：宿主这半边不再挂，否则工具会重新变成全局可见。
    if (config.mountScope !== 'host') {
      return { ok: false, error: MOUNT_SCOPE_HINT[config.mountScope] || MOUNT_SCOPE_HINT.preset, target: state.target };
    }
    // 重入保护：unmount 与 register 之间有清理动作，被连点或工具并发调用时
    // 会出现「先注销再注册」交错，这里直接拒绝第二次进入，而不是排队等待。
    if (state.mounting) {
      return { ok: false, busy: true, error: '正在重建连接，请稍候再试', target: state.target };
    }
    // 走到这里一定是有人在主动连：手动断开的状态到此为止。
    state.paused = false;
    state.mounting = true;
    try {
      const target = resolveTarget();
      if (target.error) {
        unmount();
        state.mountError = target.error;
        return { ok: false, error: target.error, target };
      }
      try {
        if (restart && state.disposeServer) unmount();
        if (!state.disposeServer) {
          const manager = mcpManager();
          if (!manager?.register) {
            state.mountError = 'MCP 客户端服务还没就绪，暂时挂不上桥接';
            return { ok: false, error: state.mountError, target };
          }
          state.disposeServer = manager.register(SERVER_NAME, {
            transport: 'stdio',
            command: target.executable,
            args: ['mcp', 'bridge', '--installation-id', target.installationId],
            startupTimeoutMs: config.startupTimeoutMs,
            toolCallTimeoutMs: config.toolCallTimeoutMs,
          });
          state.lastMountAt = Date.now();
          // 告诉预设那一份「宿主这边已经在挂了」，两份不要同时上（见 mountScopedBridge）。
          writeSharedState('hostBridge', { mounted: true, at: Date.now() });
        }
        state.mountError = '';
        return { ok: true, target };
      } catch (error) {
        const message = String(error?.message || error);
        state.disposeServer = null;
        state.mountError = message;
        logger?.warn?.(`[formatjiang] 挂载桥接失败：${message}`);
        return { ok: false, error: message, target };
      }
    } finally {
      state.mounting = false;
    }
  }

  /**
   * 桥接断开后的兜底重连。
   *
   * 只在宿主已经放弃（status.state === 'failed'，十次重试用完、工具被撤掉）时动手：
   * connecting / reconnecting 阶段宿主自己还在试，插一手只会两套退避打架。
   * 三种情况不重挂——用户完全退出格式匠、还没到退避时间、本轮次数用尽。
   * 每轮间隔 15/30/60 秒，连上即清零；恢复后若再次断开，重新从 15 秒开始。
   */
  /**
   * 安装更新期间，安装目录里会有 update-in-progress.marker（与 Go 侧桥接同名同位置）。
   * 这时的断开是预期的：桥接被主动要求退出、重连也会被拒绝。判断出来就别去重挂，
   * 免得更新那一两分钟里反复拉起桥接进程。
   */
  function updateInProgress() {
    const executable = state.target?.executable;
    if (!executable) return false;
    try {
      return fs.existsSync(path.join(path.dirname(executable), 'update-in-progress.marker'));
    } catch {
      return false;
    }
  }

  /**
   * 宿主通道（`格式匠.exe mcp host`）的前置条件。
   *
   * 它和桥接是两条独立的路，不能拿桥接状态当它的门禁：
   *   - 桥接把 110 个业务工具注册进工具表；preset 模式下这件事归预设里的官方 mcp 客户端，
   *     宿主这一份看不到它的连接状态（只有旧的 bridgeOnly 配置会写交接记录）。
   *   - 宿主通道按需起一个一次性子进程，用聊天身份把附件收件、会话绑定送进格式匠；
   *     它只需要「程序 + 安装 ID + 格式匠在运行」，与工具表里有没有 mcp__formatjiang__* 无关。
   *
   * 这里只看配置层的事实（程序、安装 ID、有没有手动断开、是不是正在装更新），不看端口：
   * 端口是异步探的，刚 formatjiang_open 完那一两秒它还可能是旧值，拿它当门禁会把本来
   * 能用的调用挡掉——那正是「stage_attachment 一直说还没连上」的根因。应用没起来时由
   * 子进程原话说明，调用方在错误里补一句「先 formatjiang_open」。
   */
  function hostChannel() {
    const target = state.target;
    if (state.paused) return { ok: false, reason: '插件已手动断开，先调用 formatjiang_connect 恢复' };
    if (updateInProgress()) return { ok: false, reason: '格式匠正在安装更新，装完再试' };
    if (!target?.executable) {
      return { ok: false, reason: target?.error || `没有找到格式匠程序（${EXE_NAME}），可在插件配置里填写 executablePath` };
    }
    if (!target?.installationId) {
      return { ok: false, reason: target?.error || '没有找到可用的本机安装 ID：在格式匠 设置 → MCP →「连接外部助手」里应用一次' };
    }
    return { ok: true, reason: '' };
  }

  /**
   * 格式匠的网关端口是否在监听。
   *
   * 「用户完全退出」这条错误会一直留在宿主的状态里，直到下一次连接成功为止；
   * 用户手动把格式匠打开之后，如果只按错误文本判断，就再也不会自动接上。
   * 端口探一下最直接：它同时排除了「应用没开」和「MCP 服务没开」两种情况。
   */
  function gatewayListening() {
    const settings = readMcpSettings(state.target?.dataDir);
    const port = Number(settings?.port) || 0;
    // 读不到端口不等于没在运行：数据目录还没解析出来、或格式匠还没写过配置时，
    // 这里没有任何可探测的目标，答案是「不知道」（null），不是 false。把未知说成
    // 「没在运行」会误导用户和模型去重启一个其实开着的应用。
    if (!port) return Promise.resolve(null);
    return probePort(port);
  }

  /** 连一下指定端口：只回答「现在有没有人在听」，不读配置、不带业务语义。 */
  function probePort(port) {
    if (!port) return Promise.resolve(false);
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* 已经关掉 */
        }
        resolve(value);
      };
      socket.setTimeout(600, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  }

  /**
   * 等网关端口真的在听。
   *
   * 配置只读一次：等待期间文件不会变，没必要每轮都去 stat 一遍。
   * 返回 true 表示「现在就能连」，false 表示等到超时也没等到——调用方要照实说，
   * 不能把「已经请求打开」讲成「已经就绪」。
   */
  async function waitForGateway(port, timeoutMs) {
    if (!port) return false;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (await probePort(port)) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(OPEN_WAIT_INTERVAL_MS, left)));
    }
  }

  /**
   * 后台刷新「端口到底在不在听」。
   *
   * 状态快照是同步的、探测是异步的：这里只把结果放进 state，本次快照先用上一次的值，
   * 界面最多旧一轮轮询。先记时间再探测，避免面板的轮询和自己叠成并发连接。
   */
  function refreshGateway() {
    if (Date.now() - state.gateway.at < GATEWAY_PROBE_TTL_MS) return;
    state.gateway.at = Date.now();
    gatewayListening()
      .then((alive) => {
        state.gateway.listening = alive;
      })
      .catch(() => {
        state.gateway.listening = null;
      });
  }

  /** 取 stderr 的第一行有内容的话：后面几行是调用栈，界面上放不下也用不上。 */
  function firstLine(text) {
    const line = String(text || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);
    return line ? line.replace(/^formatjiang mcp bridge:\s*/, '') : '';
  }

  /**
   * 自己起一次桥接，把子进程的 stderr 捞回来。
   *
   * 宿主只转述 `SdkError: Connection closed`——子进程一退 stdout 就关，真正的原因
   * （安装描述读不到、端口变了、网关拒绝）只写在它自己的 stderr 里，而桌面端没有
   * 控制台，那一行从来没被人看见。这里用同样的命令起一次，两秒半内退出就说明是启动
   * 阶段失败，直接取那行当旁证；没退出的说明它自己能连上网关，同样是一条有用的结论。
   *
   * 调用点已经保证「网关在监听」，所以这次探测不会触发桥接替用户拉起格式匠。
   */
  function probeBridgeOnce() {
    const executable = state.target?.executable;
    const installationId = state.target?.installationId;
    if (!executable || !installationId || state.probeBusy) return;
    if (Date.now() - state.probeAt < BRIDGE_PROBE_TTL_MS) return;
    // 程序不在时探测只会拿到一句 spawn 失败，没有诊断价值。
    try {
      if (!fs.existsSync(executable)) return;
    } catch {
      return;
    }
    state.probeAt = Date.now();
    state.probeBusy = true;
    let child = null;
    let settled = false;
    let stderr = '';
    let timer = null;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      state.probeBusy = false;
      state.probeReason = String(reason || '').trim().slice(0, 300);
      if (timer) clearTimeout(timer);
      try {
        if (child && !child.killed) child.kill();
      } catch {
        /* 已经退出 */
      }
    };
    timer = setTimeout(() => finish(''), BRIDGE_PROBE_TIMEOUT_MS);
    try {
      timer.unref?.();
    } catch {
      /* 非 Node 环境没有 unref */
    }
    try {
      child = spawn(executable, ['mcp', 'bridge', '--installation-id', installationId], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      finish(String(error?.message || error));
      return;
    }
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => finish(String(error?.message || error)));
    // 等 close 而不是 exit：exit 可能早于 stderr 读完，那样会拿到一手空字符串。
    child.once('close', () => finish(firstLine(stderr)));
  }

  /** 按退避重挂一次；返回是否真的动手（退避未到或次数用尽时为 false）。 */
  function attemptRemount(reason) {
    if (state.autoRemounts >= AUTO_RECONNECT_MAX) return false;
    const delay = AUTO_RECONNECT_DELAYS_MS[Math.min(state.autoRemounts, AUTO_RECONNECT_DELAYS_MS.length - 1)];
    if (Date.now() - state.lastAutoRemountAt < delay) return false;
    const previous = { attempts: state.autoRemounts, at: state.lastAutoRemountAt };
    state.autoRemounts += 1;
    state.lastAutoRemountAt = Date.now();
    const result = mount({ restart: true });
    // 手动重连刚好抢先一步时 mount 会返回 busy：把这一格还回去，等下一轮再来，
    // 否则一次「撞车」就白吃掉一次自动重连机会。
    if (result?.busy) {
      state.autoRemounts = previous.attempts;
      state.lastAutoRemountAt = previous.at;
      return false;
    }
    logger?.info?.(`[formatjiang] 自动重连第 ${state.autoRemounts}/${AUTO_RECONNECT_MAX} 次：${reason}`);
    return true;
  }

  /* ---------------------------- 能力清单 ---------------------------- */

  /** 清单与「哪一份安装」绑定：换程序或换安装都要重读。 */
  function catalogKey() {
    const executable = state.target?.executable || '';
    const installationId = state.target?.installationId || '';
    return executable && installationId ? `${executable}|${installationId}` : '';
  }

  /**
   * 只保留展示需要的字段并封顶。
   *
   * 格式匠的 `mcp describe` 会带回完整清单；插件页只显示名字与一行说明，
   * 原样塞进每 8 秒一次的 /state 既浪费带宽也浪费渲染。
   */
  function summarizeCatalog(raw) {
    const clip = (text, limit) => {
      const value = String(text ?? '').trim();
      return value.length > limit ? value.slice(0, limit) + '…' : value;
    };
    const slice = (items) => (Array.isArray(items) ? items.slice(0, CATALOG_ITEM_CAP) : []);
    return {
      server: { name: String(raw?.server?.name || ''), version: String(raw?.server?.version || '') },
      protocolVersion: String(raw?.protocolVersion || ''),
      tools: slice(raw?.tools).map((tool) => ({
        name: String(tool?.name || ''),
        description: clip(tool?.description, CATALOG_DESC_LIMIT),
      })),
      resources: slice(raw?.resources).map((item) => ({
        uri: String(item?.uri || ''),
        name: clip(item?.name, 60),
      })),
      resourceTemplates: slice(raw?.resourceTemplates).map((item) => ({
        uriTemplate: String(item?.uriTemplate || ''),
        name: clip(item?.name, 60),
      })),
      prompts: slice(raw?.prompts).map((item) => ({
        name: String(item?.name || ''),
        description: clip(item?.description, CATALOG_DESC_LIMIT),
      })),
      truncated: Boolean(raw?.truncated),
      durationMs: Number(raw?.durationMs) || 0,
    };
  }

  /**
   * 读一次能力清单。
   *
   * 走 `格式匠.exe mcp describe`：它和桥接读同一份安装描述、用同一套回环校验，
   * 但只连一次、问完就关，不占住网关会话。旧版本没有这个子命令时会把
   * stderr 原文留在 error 里，面板据此提示升级，而不是假装「没有资源」。
   */
  // 聊天身份只取执行上下文，不能由模型参数指定。安装凭据留在格式匠进程内。
  function callHost(exec, name, args = {}, saveTo = '') {
    const chat = exec?.agent?.session?.header?.id;
    if (typeof chat !== 'string' || !chat.trim()) return Promise.reject(new Error('宿主没有提供真实聊天标识，请从对话内调用'));
    if (exec?.signal?.aborted) return Promise.reject(new Error('本次操作已取消'));
    const snap = snapshot();
    // 走的是宿主通道（一次性 mcp host 子进程），不经过桥接：snap.ok 表示「业务工具那条
    // 桥接连上了」，在 preset 模式下宿主这一份永远看不到它，用它当门禁会把附件与会话
    // 操作全部挡死。这里只确认「起得起进程」，连不上由子进程自己的原话交代。
    const channel = hostChannel();
    if (!channel.ok) return Promise.reject(new Error(`格式匠宿主通道不可用：${channel.reason}`));
    return new Promise((resolve, reject) => {
      const child = execFile(snap.formatjiang.executable,
        ['mcp', 'host', '--installation-id', snap.formatjiang.installationId, '--chat-id', chat],
        { windowsHide: true, timeout: 302000, maxBuffer: 2 * 1024 * 1024, signal: exec?.signal },
        (error, stdout, stderr) => {
          if (error) {
            if (error.name === 'AbortError') {
              return reject(new Error('本次操作已取消；已开始的业务请查询原任务，不要换编号重发'));
            }
            // 应用没起时子进程只会丢一句连接失败；补一句用户能照做的下一步。
            const message = String(stderr || '').trim() || String(error.message || error);
            const port = Number(snap.formatjiang.port) || 0;
            const hint = state.gateway.listening === false
              ? `（格式匠现在没在运行${port ? `，端口 ${port} 没监听` : ''}：先调用 formatjiang_open）`
              : '';
            return reject(new Error(`${message}${hint}`));
          }
          try {
            const value = JSON.parse(String(stdout).trim());
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            if (name === 'save_file') {
              if (value.saved !== true || value.file_id !== args?.file_id || typeof value.path !== 'string'
                || path.resolve(value.path) !== path.resolve(saveTo) || !Number.isSafeInteger(value.byte_size) || value.byte_size < 0
                || !/^[a-f0-9]{64}$/i.test(value.sha256 || '')) throw new Error();
            } else if (value.status !== 'ok' || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new Error();
            resolve(value);
          }
          catch { reject(new Error('格式匠返回的宿主操作结果无效，请升级后重试')); }
        });
      child?.stdin?.on('error', reject);
      child?.stdin?.end(JSON.stringify({ name, arguments: args, save_to: saveTo }));
    });
  }

  function readCatalog({ force = false } = {}) {
    const key = catalogKey();
    if (!key) return Promise.resolve(null);
    const now = Date.now();
    const cached = state.catalog;
    if (!force && cached && cached.key === key) {
      const ttl = cached.error ? CATALOG_ERROR_TTL_MS : CATALOG_TTL_MS;
      if (now - cached.at < ttl) return Promise.resolve(cached);
    }
    // 单飞：一次只问一个。用显式布尔而不是「Promise 是否存在」，
    // 因为 execFile 在某些环境里可能同步回调，赋值的先后顺序会骗过 Promise 判断。
    if (state.catalogBusy && state.catalogPending) return state.catalogPending;
    state.catalogBusy = true;
    state.catalogPending = new Promise((resolve) => {
      const done = (entry) => {
        state.catalogBusy = false;
        state.catalogPending = null;
        state.catalog = entry;
        resolve(entry);
      };
      execFile(
        state.target.executable,
        ['mcp', 'describe', '--installation-id', state.target.installationId],
        { timeout: CATALOG_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const message = error.killed
              ? '格式匠没有在 20 秒内返回清单（旧版本会忽略这个请求），升级后再试'
              : (String(stderr || '').trim() || String(error?.message || error));
            done({ key, at: Date.now(), error: message, value: null });
            return;
          }
          try {
            // 正常只有一行 JSON；容错取最后一行非空输出。
            const line = String(stdout).split('\n').map((item) => item.trim()).filter(Boolean).pop() || '{}';
            const parsed = JSON.parse(line);
            if (!Array.isArray(parsed?.tools)) {
              // 旧版本没有 describe 子命令，会把这次调用当成启动 GUI，stdout 为空。
              // 这种情况不能显示成「0 个工具」，得说清楚是版本问题。
              done({ key, at: Date.now(), error: '本机格式匠版本较旧，没有清单接口；升级到这里会列出工具、资源与提示词', value: null });
              return;
            }
            done({ key, at: Date.now(), error: '', value: summarizeCatalog(parsed) });
          } catch {
            done({ key, at: Date.now(), error: '格式匠返回的清单不是合法 JSON', value: null });
          }
        },
      );
    });
    return state.catalogPending;
  }

  function supervisorTick() {
    // 手动断开就彻底安静：不重挂、不读清单，等用户显式连回来。
    if (state.paused) return;
    if (state.mounting || !config.autoReconnect) return;
    let status = null;
    try {
      status = serverView()?.status ?? null;
    } catch {
      return;
    }
    if (status?.state === 'connected') {
      state.autoRemounts = 0;
      // 连上之后才问清单：这时格式匠一定在运行，不会再触发一次拉起。
      const key = catalogKey();
      const cached = state.catalog;
      const ttl = cached && cached.error ? CATALOG_ERROR_TTL_MS : CATALOG_TTL_MS;
      if (key && (!cached || cached.key !== key || Date.now() - cached.at >= ttl)) void readCatalog();
      return;
    }
    if (status?.state !== 'failed') return;
    // 正在装更新：桥接是被要求退出的，这时候重挂只会打断安装。
    if (updateInProgress()) return;
    if (state.autoRemounts >= AUTO_RECONNECT_MAX) return;
    const message = String(status?.lastError || status?.reason || '');
    if (!USER_EXIT_PATTERN.test(message)) {
      attemptRemount('桥接断开');
      return;
    }
    // 用户退出过：先看格式匠是不是被手动打开了，开了就接上，没开就不要自作主张拉起。
    if (state.probing) return;
    state.probing = true;
    gatewayListening()
      .then((alive) => {
        state.probing = false;
        if (alive) attemptRemount('格式匠已重新打开');
      })
      .catch(() => {
        state.probing = false;
      });
  }

  function startSupervisor() {
    if (state.autoTimer || !config.autoReconnect) return;
    state.autoTimer = setInterval(supervisorTick, AUTO_RECONNECT_TICK_MS);
    // 定时器不该单独吊住宿主进程退出；宿主没有 unref 时忽略。
    try {
      state.autoTimer.unref?.();
    } catch {
      /* 非 Node 环境没有 unref */
    }
  }

  function stopSupervisor() {
    if (!state.autoTimer) return;
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }

  /**
   * 用户手动动过之后重新记一轮。
   *
   * 自动重连的三次上限是给「没人管」的情况用的；用户点了重连或打开了格式匠，
   * 说明情况变了，下一轮应当从头开始，否则按钮按下去也只这一次有效。
   */
  function resetAutoReconnect() {
    state.autoRemounts = 0;
    state.lastAutoRemountAt = 0;
  }

  /**
   * 拉起格式匠桌面程序。
   *
   * spawn 的失败（程序不见了、没有执行权限、被杀软拦下）是以 'error' 事件异步送达的，
   * try/catch 捕不到；没有任何监听时它会被当成未捕获异常，把整个宿主带崩。
   * 所以这里必挂监听，把失败原因记进 state，由下一次状态查询报出来。
   * 成功时也不等待进程：格式匠自己会起窗口，这里只负责把进程放出去。
   *
   * 环境变量告诉格式匠「这次不是你点的」：它只把窗口放进任务栏，不抢焦点，
   * 免得模型一调工具就把应用弹到最前面，挡住用户正在看的对话。
   */
  function launchDesktop(executable) {
    if (!executable) return { ok: false, error: '没有找到格式匠程序' };
    let child;
    try {
      child = spawn(executable, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, FORMATJIANG_LAUNCH_BACKGROUND: '1' },
      });
    } catch (error) {
      const message = String(error?.message || error);
      state.lastOpenError = message;
      return { ok: false, error: message };
    }
    child.once?.('error', (error) => {
      const message = String(error?.message || error);
      state.lastOpenError = message;
      logger?.warn?.(`[formatjiang] 打开格式匠失败：${message}`);
    });
    try {
      child.unref?.();
    } catch {
      /* 已经退出时 unref 会抛，忽略即可 */
    }
    state.lastOpenError = '';
    return { ok: true };
  }

  function serverView() {
    const manager = mcpManager();
    if (!manager?.list) return null;
    try {
      const list = manager.list();
      return list.find((item) => item.name === SERVER_NAME) ?? null;
    } catch (error) {
      return { name: SERVER_NAME, configured: false, status: { state: 'failed', reason: 'load', lastError: String(error?.message || error) } };
    }
  }

  /**
   * 把状态翻译成一句话。
   *
   * presetBridge 是预设那一份写到交接台上的状态：桥接不归宿主这一份时，
   * 这里仍要能答「那个会话里现在通没通」，否则面板只能永远说「由预设提供」。
   */
  function describe(status, presetBridge = null) {
    if (!status) {
      if (config.mountScope === 'off') {
        // off 是「用户自己在别处配」：这里没有「由预设提供」这回事，别把两种配置混成一句话。
        // detail 留空：状态行与命令会单独写 MOUNT_SCOPE_HINT.off，避免同一句在括号里再套一层。
        return { tone: 'idle', label: '桥接已关闭', detail: '' };
      }
      if (config.mountScope !== 'host') {
        if (presetBridge) return describePresetBridge(presetBridge);
        // 预设模式没有「已连接」这个本地事实：宿主这一份永远是 unmounted。
        // 唯一能区分的是格式匠在不在跑，所以把它写进 label，避免被读成「这个会话没选预设」。
        const listening = state.gateway.listening;
        return {
          tone: listening === false ? 'warn' : 'idle',
          label: listening === false ? '由预设提供（格式匠没运行）' : '由预设提供',
          detail: MOUNT_SCOPE_HINT[config.mountScope] || MOUNT_SCOPE_HINT.preset,
        };
      }
      const detail = state.mountError || (mcpManager() ? '桥接没有注册成功' : '等待 MCP 客户端服务就绪');
      return { tone: 'error', label: '未挂载', detail };
    }
    const stateName = status.state;
    if (stateName === 'connected') {
      return { tone: 'ok', label: '已连接', detail: `${status.toolCount} 个工具可用` };
    }
    if (stateName === 'connecting') {
      return { tone: 'idle', label: '连接中', detail: `第 ${status.attempt} 次尝试` };
    }
    if (stateName === 'reconnecting') {
      return {
        tone: 'warn',
        label: '重新连接中',
        detail: `第 ${status.attempt}/${status.maxAttempts} 次，${describeRetry(status.nextRetryAtMs)}。${status.lastError || ''}`,
      };
    }
    if (stateName === 'failed') {
      return { tone: 'error', label: '需要修复', detail: status.lastError || status.reason || '连接已放弃' };
    }
    if (stateName === 'waiting-credentials') {
      return { tone: 'warn', label: '等待凭据', detail: status.lastError || '' };
    }
    return { tone: 'idle', label: '已断开', detail: status.result?.cleanupError || '' };
  }

  /**
   * 预设那一份写回来的状态：只陈述事实，并带上「多久以前」。
   *
   * 这些 detail 会被拼进 `格式匠：<状态>（<detail>）` 那一行，所以本身不再套括号，
   * 改用逗号分句——嵌套括号在一行里读着别扭。
   */
  function describePresetBridge(presetBridge) {
    const age = describeAge(presetBridge.at);
    const stateName = presetBridge.state;
    if (stateName === 'connected') {
      return { tone: 'ok', label: '已连接', detail: `「格式匠」预设里 ${presetBridge.toolCount} 个工具可用，${age}` };
    }
    if (stateName === 'failed') {
      return { tone: 'error', label: '预设里连不上', detail: `${age}：${presetBridge.lastError || '连接已放弃'}` };
    }
    if (stateName === 'closed') {
      return { tone: 'idle', label: '预设桥接已关闭', detail: `「格式匠」预设那一份已经卸载，${age}` };
    }
    return { tone: 'idle', label: '预设里连接中', detail: `「格式匠」预设那一份正在连，${age}` };
  }

  /** 交接台上的时间戳 → 「刚刚 / N 分钟前」，超过一分钟不再说「刚刚」。 */
  function describeAge(at) {
    const seconds = Math.max(0, Math.round((Date.now() - Number(at || 0)) / 1000));
    if (seconds < 60) return '刚刚';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    return `${Math.round(minutes / 60)} 小时前`;
  }

  function describeRetry(nextRetryAtMs) {
    const remain = Number(nextRetryAtMs) - Date.now();
    if (!Number.isFinite(remain) || remain <= 0) return '即将重试';
    return `${Math.max(1, Math.round(remain / 1000))} 秒后重试`;
  }

  function snapshot() {
    // 桥接不归宿主这一份时，先把「程序在哪、安装 ID 是什么」交给预设那一份（顺带解析目标）。
    if (config.mountScope !== 'host') handoffTarget();
    // host 模式下 mount() 是唯一解析目标的地方：mcpManager 一直没就绪时它没跑过，
    // 宿主工具不该因为「没解析过」而报「没找到程序」——它们本来就不经过桥接。
    // 这里补一次解析；失败会把原因写进 target.error，不会每次快照都重开数据库。
    // 放在 handoffTarget 之后：preset 模式下它已经解析过，不能同一次快照读两遍数据库。
    if (!state.target.executable && !state.target.error && !state.target.installationId) {
      try {
        resolveTarget();
      } catch {
        /* 解析失败就照实显示未找到，下一次 mount/connect 再试 */
      }
    }
    const target = state.target;
    const settings = readMcpSettings(target.dataDir);
    const view = serverView();
    const status = view?.status ?? null;
    // 预设那一份写回来的状态（十分钟内才算「现在」）。宿主自己挂的时候不用看。
    // 随附的「格式匠」预设挂的是官方 mcp 客户端，插件不再往里塞自己，所以这条记录
    // 通常没有；`closed` 是旧那一份卸载时留下的墓碑，不能当成现在还在用的状态。
    const presetRecord = config.mountScope === 'host' ? null : freshShared('presetBridge');
    const presetBridge = presetRecord && presetRecord.state !== 'closed' ? presetRecord : null;
    const description = state.paused
      ? { tone: 'idle', label: '已断开', detail: '手动断开，点「重新连接」恢复' }
      : describe(status, presetBridge);
    const updating = updateInProgress();
    // 顺手刷新「端口在不在听」：配置里的「已开启」和「现在有人在听」是两件事，
    // 面板把两件事混成一句打勾，用户就会在格式匠根本没运行时看到「已经就绪」。
    refreshGateway();
    // 宿主已经放弃、网关又在听：这时自己起一次桥接是安全的，能捞到子进程写的原因。
    if (status?.state === 'failed' && state.gateway.listening === true) probeBridgeOnce();
    const hints = [];
    // 桥接不在宿主这一层时，顺手确认预设那一份要用的模块能不能加载。
    if (config.mountScope !== 'host') refreshMcpClientCheck();
    if (target.error) hints.push(target.error);
    if (state.mountError && state.mountError !== target.error) hints.push(state.mountError);
    if (presetBridge?.state === 'failed') {
      hints.push(`「格式匠」预设里的桥接连不上：${presetBridge.lastError || '没有给出原因'}（${describeAge(presetBridge.at)}）；先调用 formatjiang_open 启动格式匠，起来后桥接会自己重连。`);
    }
    if (state.lastOpenError) hints.push(`上次打开格式匠失败：${state.lastOpenError}`);
    if (settings && settings.enabled === false) hints.push('格式匠里的 MCP 服务已停用，桥接会连接失败');
    if (config.autoReconnect && state.autoRemounts >= AUTO_RECONNECT_MAX && status?.state === 'failed' && !updating) {
      hints.push('自动重连已经试过 3 次，仍然连不上；处理完格式匠那边的问题后点「重新连接」');
    }
    if (updating) hints.push('格式匠正在安装更新，装完会自动重连，不需要手动处理');
    // 「配置说已开启」但端口没人听：这是最常见的一种「一直连不上」，说清楚是哪一步断了。
    if (state.gateway.listening === false && !state.paused && !updating) {
      const port = settings?.port ? `端口 ${settings.port}` : '本机端口';
      hints.push(status?.state === 'failed'
        ? `${port} 没有监听：桥接进程起来就退出了（宿主只看到「Connection closed」）。先调用 formatjiang_open 启动格式匠，它会等到端口就绪再返回`
        : `${port} 没有监听：格式匠没在运行。先调用 formatjiang_open 启动它（会等到端口就绪），起来后桥接自动重连`);
    }
    // 桥接子进程自己说的话，比宿主那句 Connection closed 有用得多。
    if (state.probeAt) {
      hints.push(state.probeReason
        ? `桥接启动失败的原因：${state.probeReason}`
        : '桥接单独启动没有报错，说明它自己能连上网关；宿主这一次启动失败，点「重新连接」再试一次');
    }
    // 装配失败必须能被读到：插件页读不到状态时，这里往往就是原因。
    if (state.faults.length) {
      const last = state.faults[state.faults.length - 1];
      hints.push(`插件有 ${state.faults.length} 处装配失败，最近一处是「${last.label}」：${last.message}`);
    }
    if (state.panel && state.panel.ok === false) hints.push(`插件页接口没有挂上：${state.panel.error}`);
    if (state.mcpClientCheck && state.mcpClientCheck.ok === false) {
      hints.push(`预设那一份要用的 mcp 客户端加载不了：${state.mcpClientCheck.error}`);
    }
    // 两条通道分开报：ok 只说「桥接连上了没有」，hostChannel 说「宿主通道能不能起来」。
    // usable 表示「这套接入没有配置层面的故障」，给命令与状态工具的成败判断用：宿主自己
    // 挂的时候 ok 就是唯一判据；preset 模式下桥接归预设里的官方 mcp 客户端、宿主看不到
    // 它的状态，没有旧的交接记录时，只要宿主通道可用就说明机器已经接好了——不能把 ok
    // 永远钉在 false 上，否则插件页、/formatjiang 命令与状态工具会把一套配置正确、正在
    // 工作的环境画成待修。应用在不在运行由「运行状态」那一行单独说，免得这里多一个
    // 异步端口探测的结果，让同一份配置在两次调用里给出不同结论。
    const host = hostChannel();
    const bridgeOk = status?.state === 'connected' || presetBridge?.state === 'connected';
    const usable = Boolean(
      bridgeOk || (config.mountScope !== 'host' && !presetBridge && host.ok),
    );
    return {
      ok: bridgeOk,
      usable,
      hostChannel: host,
      paused: state.paused,
      /** 桥接归谁挂：host = 本插件在宿主层挂；preset = 交给「格式匠」预设。 */
      mountScope: config.mountScope,
      /** 预设那一份写到交接台上的状态；null 表示最近没有那个会话的记录。 */
      presetBridge,
      tone: description.tone,
      label: description.label,
      detail: description.detail,
      server: {
        name: SERVER_NAME,
        state: status?.state ?? 'unmounted',
        toolCount: status?.toolCount ?? 0,
        lastError: status?.lastError ?? state.mountError ?? '',
        nextRetryAtMs: status?.nextRetryAtMs ?? 0,
        attempt: status?.attempt ?? 0,
        maxAttempts: status?.maxAttempts ?? 0,
      },
      formatjiang: {
        executable: target.executable,
        installationId: target.installationId,
        installationKind: target.installationKind,
        dataDir: target.dataDir,
        mcpEnabled: settings ? settings.enabled : null,
        port: settings?.port ?? 0,
        /** 端口是否真的在监听：null = 还没探到。与上面的 mcpEnabled 是两个不同的事实。 */
        listening: state.gateway.listening,
        safeWrite: settings ? settings.safeWrite : null,
        updating,
      },
      hints,
      /** 插件页接口的挂载结果：读不到状态时先看它，再看 faults。 */
      panel: state.panel,
      /** 装配期失败原文，最多 5 条。 */
      faults: state.faults.slice(-5),
      /** 桥接子进程自己说过的失败原因（插件抓的旁证）；reason 为空表示它其实能起来。 */
      probe: { at: state.probeAt, reason: state.probeReason },
      /** 预设那一份要用的 mcp 客户端能否加载：null 表示还没查过。 */
      mcpClient: state.mcpClientCheck,
      /** 宿主服务的就绪情况：两个键都可能为 false，那是「还没起来」，不是故障。 */
      services: { mcpManager: Boolean(mcpManager()), webServer: Boolean(safeService('webServer')) },
      /** 自动重连的当前进度：面板据此说明「还要不要等」以及「是不是已经放弃了」。 */
      auto: (() => {
        const enabled = Boolean(config.autoReconnect);
        const attempts = state.autoRemounts;
        const exhausted = enabled && attempts >= AUTO_RECONNECT_MAX;
        const delay = AUTO_RECONNECT_DELAYS_MS[Math.min(attempts, AUTO_RECONNECT_DELAYS_MS.length - 1)];
        return {
          enabled,
          attempts,
          max: AUTO_RECONNECT_MAX,
          exhausted,
          nextAtMs: enabled && attempts > 0 && !exhausted ? state.lastAutoRemountAt + delay : 0,
        };
      })(),
      /**
       * 连上之后拿到的能力清单。
       *
       * null 表示还没读过；error 非空表示这次读失败（旧版本没有 describe 子命令、
       * 网关拒绝、超时等），面板要如实说明，不能把「没读到」画成「没有资源」。
       */
      catalog: (() => {
        const item = state.catalog;
        if (!item) return null;
        const ageMs = Date.now() - item.at;
        return {
          fetchedAt: new Date(item.at).toISOString(),
          ageMs,
          stale: ageMs > CATALOG_TTL_MS,
          error: item.error || '',
          data: item.value,
        };
      })(),
      pluginVersion: PLUGIN_VERSION,
      bridge: { transport: 'stdio', skill: SKILL_NAME },
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * 拼一段可以直接复制给他人排查的接入信息。
   *
   * 只含状态、路径与错误原文：token 与桥接描述一律不进来，它们由格式匠的受保护存储保管。
   */
  function diagnosticsText(snap) {
    const lines = [
      `格式匠论文助手 ${snap.pluginVersion || '版本未知'}`,
      `接入状态：${snap.label}${snap.detail ? `（${snap.detail}）` : ''}`,
      snap.mountScope === 'host'
        ? `桥接：${snap.bridge.transport} / ${snap.server.state} / 工具 ${snap.server.toolCount} 个`
        : `宿主这一份不挂桥接（${snap.server.state}）：业务工具由「格式匠」预设提供，连上后才会出现在工具表里`,
      `挂载位置：${snap.mountScope === 'host' ? '宿主（每个会话都可见）' : '「格式匠」预设（只有选它的会话可见）'}`,
      // 两条通道分开写：宿主工具不经过桥接，「桥接没连上」不能用来描述它。
      hostChannelText(snap),
      ...(snap.presetBridge
        ? [`预设桥接：${snap.presetBridge.state} · 工具 ${snap.presetBridge.toolCount} 个（${describeAge(snap.presetBridge.at)}）${snap.presetBridge.lastError ? ` · ${snap.presetBridge.lastError}` : ''}`]
        : []),
      `程序：${snap.formatjiang.executable || '未找到'}`,
      `安装：${snap.formatjiang.installationId || '未找到'}（${snap.formatjiang.installationKind || '未识别'}）`,
      `数据目录：${snap.formatjiang.dataDir || '未找到'}`,
    ];
    if (snap.formatjiang.mcpEnabled === false) {
      lines.push('格式匠 MCP 服务：已停用');
    } else if (snap.formatjiang.port) {
      // 「已开启」是配置，监听是事实，两句话分开写，免得一句打勾把人带偏。
      const listening = snap.formatjiang.listening;
      const suffix = listening === true ? '（正在监听）' : listening === false ? '（当前没有监听）' : '';
      lines.push(`格式匠 MCP 服务：端口 ${snap.formatjiang.port}${suffix}`);
    }
    if (snap.formatjiang.safeWrite !== null && snap.formatjiang.safeWrite !== undefined) {
      lines.push(`写入工具：${snap.formatjiang.safeWrite ? '已开启（每次需要确认）' : '未开启'}`);
    }
    if (snap.server.attempt) {
      lines.push(`重连进度：第 ${snap.server.attempt}/${snap.server.maxAttempts || '?'} 次`);
    }
    if (snap.server.lastError) lines.push(`最近错误：${snap.server.lastError}`);
    // 预设模式下「宿主这一份 unmounted」不是结论，下一步该做什么才是。
    if (snap.mountScope !== 'host') {
      lines.push(snap.formatjiang.listening === false
        ? '下一步：格式匠没在运行，先调用 formatjiang_open 启动它（会等到端口就绪）'
        : '下一步：业务工具由「格式匠」预设里的 mcp 客户端加载；应用已在运行而工具表里没有它们时，先确认本会话选的是「格式匠」预设。宿主工具（附件、会话）不受影响，可以直接用');
    }
    if (snap.mcpClient) {
      lines.push(`预设桥接模块：${snap.mcpClient.ok ? '可用' : `加载失败（${snap.mcpClient.error}）`}`);
    }
    if (snap.probe?.reason) lines.push(`桥接启动失败：${snap.probe.reason}`);
    for (const hint of snap.hints) lines.push(`待处理：${hint}`);
    lines.push(`采集时间：${snap.updatedAt}`);
    return lines.join('\n');
  }

  /**
   * preset 模式下「重连」的说明。
   *
   * 这种配置里桥接归预设里的官方 mcp 客户端，宿主这一份没有可重建的连接。以前这里
   * 直接返回「重连失败：桥接由预设提供…」，模型会把它当成待修的故障反复重试，最后
   * 向用户宣布「会话没选预设」。现在把两条通道的事实与下一步一次说清：这不是故障。
   */
  function presetScopeNote() {
    // 预设模式下没有可断开的连接：`paused` 是「桥接被用户手动断开」的标记，
    // 它只对桥接说话，不能顺手把宿主通道一起停掉。显式「连接」动作到这里就结束。
    state.paused = false;
    const snap = snapshot();
    const host = snap.hostChannel;
    const lines = [
      '不用重连：桥接由「格式匠」预设里的官方 mcp 客户端负责，宿主这一份不挂桥接，也没有可重建的连接。',
      // 宿主通道「配置齐了」与「现在能用」要分开说：应用没在跑时不能写成「现在就能用」。
      !host.ok
        ? `宿主通道：不可用（${host.reason}）。`
        : snap.formatjiang.listening === false
          ? '宿主通道：配置齐全，但格式匠没在运行，起来后就能用。'
          : '宿主通道：可用——附件收件与会话绑定现在就能用，不依赖业务工具是否加载。',
    ];
    if (snap.formatjiang.listening === false) {
      lines.push('格式匠现在没在运行：先调用 formatjiang_open，起来后业务工具会按预设里的重连设置自己回来。');
    } else {
      lines.push('业务工具没出现在工具表里时，先确认本会话选的是「格式匠」预设；应用没开就先 formatjiang_open。改过插件配置后要重启 DSH 才生效。');
    }
    // 「不用重连」不等于整条接入可用：应用没在跑时这条调用不能报成功，
    // 否则模型会以为已经可以干活，跳过 formatjiang_open。
    const ready = host.ok && snap.formatjiang.listening !== false;
    return { ...snap, ok: ready, text: lines.join('\n') };
  }

  /**
   * mountScope: off 时「连接」的说明。
   *
   * 这种配置是用户在插件里主动选的：桥接两边都不挂，宿主这一份既没有可连的桥接，
   * 也没有可重建的连接。别把它说成「桥接由预设提供」（那是 preset 模式的事实）。
   */
  function offScopeNote() {
    const snap = snapshot();
    const host = snap.hostChannel;
    const lines = [
      '桥接在插件配置里关着（mountScope: off）：这里没有可连接的桥接，格式匠工具需要在别处自己配 mcp 客户端。',
      !host.ok
        ? `宿主通道：不可用（${host.reason}）。`
        : snap.formatjiang.listening === false
          ? '宿主通道：配置齐全，但格式匠没在运行，起来后就能用。'
          : '宿主通道：可用——附件收件与会话绑定不经过桥接，随时能用。',
      '要改回由宿主或「格式匠」预设挂桥接，改插件配置的 mountScope 后重启 DSH。',
    ];
    // 这条动作本来就没有可执行的对象，不能报成功，否则模型会以为桥接已经重建。
    return { ...snap, ok: false, text: lines.join('\n') };
  }

  /** 「连接」在非 host 模式下的说明：preset 与 off 是两种不同的配置，不能共用一句话。 */
  function connectScopeNote() {
    return config.mountScope === 'off' ? offScopeNote() : presetScopeNote();
  }

  /** 「断开」在非 host 模式下的说明：这里没有可断开的桥接，原因随配置不同。 */
  function disconnectScopeText() {
    return config.mountScope === 'off'
      ? '插件配置里关掉了桥接（mountScope: off），没有可断开的连接。'
      : '桥接挂在「格式匠」预设上，宿主这里没有可断开的连接；要停就在那个会话里不再使用格式匠工具。';
  }

  /**
   * 宿主通道那一行话。
   *
   * 「配置齐了」与「现在能用」是两件事：前者看程序与安装 ID，后者还要格式匠在运行。
   * 两条都说明白，模型才不会把「应用没开」当成「会话没选预设」。
   */
  function hostChannelText(snap) {
    if (!snap.hostChannel?.ok) return `宿主通道：不可用（${snap.hostChannel?.reason || '原因未知'}）`;
    if (snap.formatjiang.listening === false) {
      return '宿主通道：暂时不可用——格式匠没在运行，先调用 formatjiang_open';
    }
    return snap.formatjiang.listening === true
      ? '宿主通道：可用（附件收件、会话绑定走这条，不依赖业务工具）'
      : '宿主通道：可用（附件收件、会话绑定走这条；本机端口状态还没探到）';
  }

  /* ---------------------------- 工具 ---------------------------- */

  function register(definition) {
    // 定义阶段失败时 defineTool 返回 null：跳过而不是让 register 自己再抛一次。
    if (!definition) return () => {};
    try {
      const dispose = ctx.tools.register(definition);
      return typeof dispose === 'function' ? dispose : () => {};
    } catch (error) {
      logger?.error?.(`[formatjiang] 注册工具 ${definition?.name || '未命名'} 失败：${String(error?.message || error)}`);
      return () => {};
    }
  }

  safeEffect(() => {
    const disposers = [];

    disposers.push(register(defineTool({
      name: 'formatjiang_status',
      description:
        '查看本机格式匠的接入状态：桥接与宿主通道各自通没通、工具数量、最近错误、程序与安装 ID 是否找到。'
        + '用户问「格式匠连上了吗」「为什么格式匠的工具用不了」时先调它，不要盲目重试业务工具。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已读取格式匠状态') },
      async execute(_args, exec) {
        const snap = snapshot();
        // 预设模式下没有交接记录时，detail 就是下面那行「桥接：…」的同一句话；别复述两遍。
        const headDetail = snap.mountScope !== 'host' && !snap.presetBridge ? '' : snap.detail;
        const lines = [`格式匠：${snap.label}${headDetail ? `（${headDetail}）` : ''}`];
        if (snap.mountScope && snap.mountScope !== 'host') {
          const bridge = snap.presetBridge;
          lines.push(bridge
            ? `预设桥接：${bridge.state}${bridge.toolCount ? ` · ${bridge.toolCount} 个工具` : ''}（${describeAge(bridge.at)}）${bridge.lastError ? ` · ${bridge.lastError}` : ''}`
            : `桥接：${MOUNT_SCOPE_HINT[snap.mountScope] || MOUNT_SCOPE_HINT.preset}`);
          // 宿主这一份看不到预设里那份官方客户端的连接状态，但「应用在不在跑」是事实：
          // 把它单独说清，不要再让模型从「unmounted」推出「会话没选预设」。
          const port = snap.formatjiang.port || '未知';
          if (snap.formatjiang.listening === false) {
            lines.push(`运行状态：格式匠没在运行（端口 ${port} 没监听）——先调用 formatjiang_open；起来后业务工具会按预设里的重连设置自己回来`);
          } else if (snap.formatjiang.listening === true) {
            lines.push(`运行状态：格式匠已在运行（端口 ${port} 在听）`);
          }
        }
        // 两条通道分开报：桥接归桥接，宿主工具归宿主通道，谁断了就说谁。
        lines.push(hostChannelText(snap));
        const registered = snap.presetBridge?.toolCount || snap.server.toolCount || 0;
        const cwd = exec?.agent?.session?.cwd || exec?.agent?.session?.workingDirectory || exec?.cwd || '';
        const cursor = cwd ? researchCursor(cwd) : null;
        if (cursor?.stageId && cursor.stageId !== 'publish') {
          lines.push(`已注册 ${registered} 个业务工具。研究任务卡还在「${cursor.stageId}」，本阶段不要调用它们。`);
        } else if (cursor?.stageId === 'publish') {
          lines.push(`已注册 ${registered} 个业务工具。本阶段可见交接与套版：formatjiang_receive_manuscript、preview_layout_plan、apply_layout_as_branch。`);
        } else {
          lines.push(`已注册 ${registered} 个业务工具。编号以工具文本为准；应用没运行时先 formatjiang_open。`);
        }
        if (snap.server.toolCount) lines.push(`工具：${snap.server.toolCount} 个，前缀 mcp__${SERVER_NAME}__`);
        if (snap.formatjiang.executable) lines.push(`程序：${snap.formatjiang.executable}`);
        if (snap.formatjiang.installationId) {
          lines.push(`安装：${snap.formatjiang.installationId}（${snap.formatjiang.installationKind || '本机客户端'}）`);
        }
        for (const hint of snap.hints) lines.push(`待处理：${hint}`);
        // 装配失败与插件页接口单独列出：它们不是「连接问题」，而是插件自己没装好。
        for (const fault of snap.faults || []) lines.push(`装配失败：${fault.label} — ${fault.message}`);
        if (snap.panel?.ok === false) lines.push(`插件页接口：未挂载（${snap.panel.error}）`);
        // ok 在这里表示「这套接入现在算不算正常」：宿主自己挂时看桥接；preset 模式下
        // 桥接不在宿主这一份，宿主通道可用就说明机器已经接好了（见 snapshot().usable）。
        return { ...snap, ok: snap.usable, text: lines.join('\n') };
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_connect',
      description:
        '重新发现并重连本机格式匠：填好程序路径或安装 ID 以后、或桥接放弃重试以后用它。'
        + '它只重建连接，不改变论文、版本或版式配置；mountScope 是 preset 时桥接不归宿主，它只说明为什么不用重连。',
      parameters: {
        restart: { type: 'boolean', description: '已经有连接时是否强制重建一次（默认 true；传 false 复用现有连接）' },
      },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已重新连接格式匠') },
      async execute(args) {
        // 预设模式下这条没有可重建的连接：桥接归预设里的官方 mcp 客户端。以前这里
        // 返回「重连失败：桥接由预设提供…」，模型把它当成待修故障反复重试；现在直接
        // 说明分工与下一步，宿主通道可用时 ok 为真。
        if (config.mountScope !== 'host') return connectScopeNote();
        // 这个工具就是「重新连接」：默认重建（桥接可能已经放弃重试），
        // 只有显式传 restart:false 才复用现有连接。
        resetAutoReconnect();
        const result = mount({ restart: args?.restart !== false });
        if (!result.ok) {
          return { ok: false, text: `重连失败：${result.error}`, ...snapshot() };
        }
        const snap = snapshot();
        return { ...snap, ok: true, text: `已挂载桥接，当前状态：${snap.label}（${snap.detail || '等待首次连接'}）` };
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_disconnect',
      description:
        '主动断开本机格式匠的桥接，并停掉插件的自动重连，直到下一次显式连接。'
        + '用于调试「连不上」的一侧：断开后所有 mcp__formatjiang__ 工具都会不可用。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已断开格式匠连接') },
      async execute() {
        if (config.mountScope !== 'host') {
          return {
            ok: false,
            text: disconnectScopeText(),
            ...snapshot(),
          };
        }
        resetAutoReconnect();
        disconnect();
        const snap = snapshot();
        // ok 表示这次动作成功；连接状态看 label / server.state，不要混用。
        return { ...snap, ok: true, text: '已断开格式匠连接；需要恢复时调用 formatjiang_connect' };
      },
    })));

    /**
     * 启动格式匠并等端口就绪。
     *
     * 同一时刻只跑一次：两个会话同时问「怎么没数据」时，后到的调用复用同一次启动，
     * 不会 spawn 出第二个窗口。只解析程序与数据目录——打开应用不需要安装 ID，
     * 也就不必为此打开一次 77MB 的数据库。
     */
    async function openFormatjiang() {
      if (state.opening) return state.opening;
      state.opening = (async () => {
        // 只解析程序与数据目录：打开应用不需要安装 ID，也就不必为此打开一次 77MB 的数据库。
        const executable = resolveExecutable(config);
        if (!executable.path) {
          return { ok: false, text: `没有找到格式匠程序（${EXE_NAME}），可在插件配置里填写 executablePath` };
        }
        const dataDir = dataDirCandidates(config).find((dir) => {
          try {
            return fs.statSync(dir).isDirectory();
          } catch {
            return false;
          }
        }) || '';
        const launched = launchDesktop(executable.path);
        if (!launched.ok) {
          return { ok: false, text: `打开格式匠失败：${launched.error}` };
        }
        // 端口以格式匠自己的配置为准：它可能改过端口，插件不猜。
        const port = Number(readMcpSettings(dataDir)?.port) || 0;
        const ready = await waitForGateway(port, OPEN_WAIT_MS);
        // 把刚测到的事实写进状态，紧接着的 formatjiang_status 就不会再报旧值。
        state.gateway.listening = ready;
        state.gateway.at = Date.now();
        if (ready) {
          const follow = config.mountScope === 'preset'
            ? '宿主工具（附件收件、会话绑定）现在就能用；预设里的桥接会自动接上（最多十几秒），连上之后 mcp__formatjiang__* 业务工具才会注册进工具表——可能要等下一个回合。本回合还看不到就再调一次 formatjiang_status，不要据此断定会话没选预设。'
            : config.mountScope === 'off'
              // 配置里关掉了桥接：打开应用不会让业务工具自己出现，别让模型以为再等一会就有。
              ? '宿主工具（附件收件、会话绑定）现在就能用；桥接在插件配置里关着（mountScope: off），业务工具不会自己出现，需要在别处配 mcp 客户端。'
              : '接着调用 formatjiang_connect 建连（开着自动重连时它也会自己连上）。';
          return {
            ok: true,
            text: `已启动格式匠，端口 ${port} 已经在听（${executable.path}）。窗口只在任务栏、没有抢焦点，用户不必切过去看它也能用工具。${follow}`,
          };
        }
        const portText = port > 0 ? `端口 ${port} 在 ${Math.round(OPEN_WAIT_MS / 1000)} 秒内没有就绪` : '没读到格式匠的端口配置';
        return {
          ok: false,
          text: `已请求打开格式匠（${executable.path}），但${portText}。冷启动可能更慢，稍后再用 formatjiang_status 看一次；如果窗口一直没出现，让用户手动打开格式匠。`,
        };
      })();
      try {
        return await state.opening;
      } finally {
        state.opening = null;
      }
    }

    disposers.push(register(defineTool({
      name: 'formatjiang_open',
      description:
        '打开本机格式匠桌面应用，并等它的 MCP 端口就绪。格式匠没运行时桥接连不上、业务工具也用不了；'
        + '这个工具会启动它并回报「现在到底就绪没有」，就绪后桥接会自动重连。只读本地程序路径，不改论文数据。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已请求打开格式匠') },
      async execute() {
        return openFormatjiang();
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_diagnostics',
      description:
        '生成一段格式匠接入诊断信息（版本、程序与安装路径、桥接状态、最近错误），可直接复制给他人排查。'
        + '用户说「为什么连不上」「帮我导一份诊断」时用它；它只读，不含任何令牌。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已生成格式匠诊断信息') },
      async execute() {
        const snap = snapshot();
        const text = diagnosticsText(snap);
        return { ...snap, ok: snap.usable, text };
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_catalog',
      description:
        '列出本机格式匠网关当前暴露的能力：工具、固定资源、资源模板与提示词（名字与一行说明）。'
        + '用户问「连上了能用哪些东西」「有哪些资源」时用它；只读，读一次会缓存在插件里。',
      parameters: {
        refresh: { type: 'boolean', description: '忽略缓存，重新向格式匠问一次（默认 false）' },
      },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已读取格式匠能力清单') },
      async execute(args) {
        const entry = await readCatalog({ force: args?.refresh === true });
        if (!entry) return { ok: false, text: '没有可用的本机安装，先按插件页的三步接入' };
        if (entry.error) return { ok: false, text: `读取能力清单失败：${entry.error}` };
        const data = entry.value;
        const lines = [
          `工具 ${data.tools.length} 个`,
          `固定资源 ${data.resources.length} 个`,
          `资源模板 ${data.resourceTemplates.length} 个`,
          `提示词 ${data.prompts.length} 个`,
        ];
        if (data.server.name || data.server.version) {
          lines.push(`服务：${data.server.name || '未命名'}${data.server.version ? ' ' + data.server.version : ''}`);
        }
        if (data.tools.length) lines.push(`工具名：${data.tools.map((tool) => tool.name).join('、')}`);
        return { ok: true, text: lines.join('\n'), ...snapshot() };
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_stage_attachment',
      description:
        '把用户这次交给你的一个本机文件复制进格式匠的收件区，通过可信宿主通道取得 file_id。'
        + '用户说「把这份稿子导进格式匠」「用这个 PDF 当资料」时，先用它接收附件，取得 file_id。'
        + '只复制单个普通文件、不超过 200 MB；不改原文件、不移动它。',
      parameters: {
        path: { type: 'string', description: '用户交给你的文件在本机的绝对路径' },
        file_name: { type: 'string', description: '可选：收件区里用的文件名，默认沿用原文件名' },
        paper_id: { type: 'number', description: '可选：目标论文编号；受限连接必须指定已授权论文' },
      },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已把文件放进格式匠收件区') },
      async execute(args, exec) {
        if (!exec?.agent?.session?.header?.id) return { ok: false, text: '宿主没有提供真实聊天标识，请从对话内调用' };
        if (exec?.signal?.aborted) return { ok: false, text: '本次操作已取消' };
        const sourcePath = String(args?.path || '').trim();
        if (!sourcePath) return { ok: false, text: '需要给出文件的绝对路径' };
        if (!path.isAbsolute(sourcePath)) return { ok: false, text: '需要给出文件的绝对路径' };
        const fileName = String(args?.file_name || '').trim() || path.basename(sourcePath);
        // 文件名只能是单个名称，拒绝目录跳转、Windows 流和设备名，避免复制覆盖收件区外文件。
        if (fileName === '.' || fileName === '..' || /[\\/:<>"|?*\x00-\x1f]/.test(fileName)
          || /[. ]$/.test(fileName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) {
          return { ok: false, text: '文件名无效，请只填写文件名，不要包含路径' };
        }
        const snap = snapshot();
        // 附件走宿主身份通道；预设业务桥接的观测状态不能拦住这条独立通道。
        const channel = hostChannel();
        if (!channel.ok) return { ok: false, text: `格式匠宿主通道不可用：${channel.reason}`, ...snap };
        // 收件区在格式匠的数据目录下：没有目录就不能拼相对路径，否则会在当前工作目录里
        // 造出一棵 mcp-files/inbox，而且那份文件格式匠永远看不到。
        if (!snap.formatjiang.dataDir) {
          return { ok: false, text: '找不到格式匠数据目录，文件放不进收件区；可在插件配置里填写 dataDir', ...snap };
        }
        let info;
        try {
          info = await fs.promises.stat(sourcePath);
        } catch {
          return { ok: false, text: `找不到这个文件：${sourcePath}` };
        }
        if (!info.isFile()) return { ok: false, text: '只能暂存普通文件，不能是目录' };
        if (info.size > MAX_ATTACHMENT_BYTES) {
          return { ok: false, text: `文件超过 ${MAX_ATTACHMENT_BYTES >> 20} MB，格式匠的收件区接不住` };
        }
        const inboxRoot = path.resolve(snap.formatjiang.dataDir, 'mcp-files', 'inbox');
        const stagingDir = path.join(inboxRoot, `stg-${randomUUID()}`);
        const discardStaging = async () => {
          // 只回收本次创建的绝对子目录，不触碰用户原件或服务端已搬入的受管副本。
          if (path.dirname(stagingDir) !== inboxRoot || !path.basename(stagingDir).startsWith('stg-')) return;
          try { await fs.promises.rm(stagingDir, { recursive: true, force: true }); }
          catch { logger?.warn?.('[formatjiang] 本次临时附件未能回收'); }
        };
        try {
          await fs.promises.mkdir(stagingDir, { recursive: true });
          await fs.promises.copyFile(sourcePath, path.join(stagingDir, fileName), fs.constants.COPYFILE_EXCL);
        } catch (error) {
          await discardStaging();
          return { ok: false, text: `复制到收件区失败：${error?.message || error}` };
        }
        const stagedPath = path.join(stagingDir, fileName);
        try {
          const result = await callHost(exec, 'receive_file', { source_path: stagedPath, file_name: fileName, paper_id: args?.paper_id });
          const fileId = nestedId(result, ['file_id', 'fileId']);
          return { ok: true, ...result, file_id: fileId, text: `已接收附件。file_id=${fileId || '（宿主没有返回 file_id）'}` };
        } catch (error) {
          return { ok: false, text: `附件接收失败：${error.message}` };
        } finally {
          await discardStaging();
        }
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_session',
      description: '读取、绑定或解除本次真实聊天的当前论文，不需要填写聊天编号。',
      parameters: { action: { type: 'string', enum: ['get', 'bind', 'unbind'] }, paper_id: { type: 'number' }, version_id: { type: 'number' }, draft_id: { type: 'number' }, note: { type: 'string' } },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '会话操作完成') },
      async execute(args, exec) {
        const names = { get: 'get_session_binding', bind: 'bind_session', unbind: 'unbind_session' };
        const name = names[args?.action || 'get'];
        if (!name) return { ok: false, text: '会话操作无效' };
        const { action, ...input } = args || {};
        try { return { ok: true, ...await callHost(exec, name, name === 'bind_session' ? input : {}) }; }
        catch (error) { return { ok: false, text: error.message }; }
      },
    })));
    disposers.push(register(defineTool({
      name: 'formatjiang_import_document',
      description: '将本次聊天接收的附件导入格式匠。request_id 必须稳定，重试沿用原编号。',
      parameters: { file_id: { type: 'string', required: true }, request_id: { type: 'string', required: true }, as_new_paper: { type: 'boolean' }, paper_id: { type: 'number' }, paper_name: { type: 'string' }, doc_type: { type: 'string' }, parent_version_id: { type: 'number' }, set_current: { type: 'boolean' }, remark: { type: 'string' } },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '稿件导入完成') },
      async execute(args, exec) {
        try {
          const result = await callHost(exec, 'import_document', args);
          const paperId = nestedId(result, ['paper_id', 'paperId']);
          const versionId = nestedId(result, ['version_id', 'versionId']);
          return { ok: true, ...result, paper_id: paperId, version_id: versionId, text: `已导入。paper_id=${paperId || '（没有返回）'} version_id=${versionId || '（没有返回）'}` };
        }
        catch (error) { return { ok: false, text: error.message }; }
      },
    })));
    disposers.push(register(defineTool({
      name: 'formatjiang_receive_manuscript',
      description: '把工作台文稿送进格式匠：复制进收件区、导入为新论文并绑定。一次返回 file_id、paper_id、version_id，并写明覆盖了哪一次旧绑定。',
      parameters: { path: { type: 'string', required: true, description: '文稿的绝对路径，应是项目里的 output/manuscript.docx' } },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '文稿交接结果') },
      async execute(args, exec) {
        if (!exec?.agent?.session?.header?.id) return { ok: false, text: '宿主没有提供真实聊天标识，请从对话内调用' };
        const sourcePath = String(args?.path || '').trim();
        if (!path.isAbsolute(sourcePath)) return { ok: false, text: '需要文稿的绝对路径' };
        const channel = hostChannel();
        if (!channel.ok) return { ok: false, text: `格式匠宿主通道不可用：${channel.reason}` };
        const snap = snapshot();
        if (!snap.formatjiang.dataDir) return { ok: false, text: '找不到格式匠数据目录，文件放不进收件区' };
        let info;
        try { info = await fs.promises.stat(sourcePath); } catch { return { ok: false, text: `找不到这个文件：${sourcePath}` }; }
        if (!info.isFile()) return { ok: false, text: '只能交接普通文件' };
        if (info.size > MAX_ATTACHMENT_BYTES) return { ok: false, text: `文件超过 ${MAX_ATTACHMENT_BYTES >> 20} MB，格式匠的收件区接不住` };
        let previous = null;
        try { previous = await callHost(exec, 'get_session_binding', {}); } catch { previous = null; }
        const previousId = nestedId(previous, ['paper_id', 'paperId']);
        const fileName = path.basename(sourcePath);
        const inboxRoot = path.resolve(snap.formatjiang.dataDir, 'mcp-files', 'inbox');
        const stagingDir = path.join(inboxRoot, `stg-${randomUUID()}`);
        try {
          await fs.promises.mkdir(stagingDir, { recursive: true });
          await fs.promises.copyFile(sourcePath, path.join(stagingDir, fileName), fs.constants.COPYFILE_EXCL);
          const received = await callHost(exec, 'receive_file', { source_path: path.join(stagingDir, fileName), file_name: fileName });
          const fileId = nestedId(received, ['file_id', 'fileId']);
          if (!fileId) return { ok: false, text: '收件成功但宿主没有返回 file_id', received };
          const requestId = `research-${createHash('sha256').update(await fs.promises.readFile(sourcePath)).digest('hex').slice(0, 24)}`;
          const imported = await callHost(exec, 'import_document', { file_id: fileId, request_id: requestId, as_new_paper: true, set_current: true, doc_type: 'thesis', paper_name: path.basename(fileName, path.extname(fileName)) });
          const paperId = nestedId(imported, ['paper_id', 'paperId']);
          const versionId = nestedId(imported, ['version_id', 'versionId']);
          if (!paperId || !versionId) return { ok: false, text: `已收件 file_id=${fileId}，但导入没有同时返回 paper_id 和 version_id`, file_id: fileId, imported };
          let bound = null;
          try { bound = await callHost(exec, 'bind_session', { paper_id: Number(paperId), version_id: Number(versionId) }); }
          catch (error) { return { ok: false, text: `编号已取得，但绑定失败：${error.message}。file_id=${fileId} paper_id=${paperId} version_id=${versionId}`, file_id: fileId, paper_id: paperId, version_id: versionId }; }
          const replaced = previousId ? `覆盖了原先绑定的论文 ${previousId}。` : '之前没有绑定其他论文。';
          let recorded = '';
          try {
            let dir = path.dirname(sourcePath);
            for (let depth = 0; depth < 6; depth += 1) {
              if (fs.existsSync(path.join(dir, '.workbench'))) {
                const relative = path.relative(dir, sourcePath).replace(/\\/g, '/');
                if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                  const sha256 = createHash('sha256').update(await fs.promises.readFile(sourcePath)).digest('hex');
                  const handoff = {
                    schema: 'dsa.handoff/1',
                    file_id: String(fileId),
                    paper_id: paperId,
                    version_id: versionId,
                    manuscript: relative,
                    manuscriptSha256: sha256,
                    previousBinding: previousId || null,
                    at: new Date().toISOString(),
                  };
                  const target = path.join(dir, 'output', 'handoff.json');
                  await fs.promises.mkdir(path.dirname(target), { recursive: true });
                  await fs.promises.writeFile(target, `${JSON.stringify(handoff, null, 2)}\n`);
                  recorded = '交付编号已写入 output/handoff.json。';
                }
                break;
              }
              const parent = path.dirname(dir);
              if (parent === dir) break;
              dir = parent;
            }
          } catch { recorded = ''; }
          const follow = recorded || '请再调用 data_analysis_record_handoff 记下这三个编号。';
          return { ok: true, file_id: fileId, paper_id: paperId, version_id: versionId, previous_paper_id: previousId || '', bound, text: `交接完成。file_id=${fileId} paper_id=${paperId} version_id=${versionId}。${replaced}${follow}下一步只预览套版，预览后停止本回合，不要调用 apply_layout_as_branch。` };
        } catch (error) {
          return { ok: false, text: `文稿交接失败：${error.message}` };
        } finally {
          if (path.dirname(stagingDir) === inboxRoot && path.basename(stagingDir).startsWith('stg-')) {
            try { await fs.promises.rm(stagingDir, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响已登记的附件 */ }
          }
        }
      },
    })));
    disposers.push(register(defineTool({
      name: 'formatjiang_use_attachments',
      description: '在本次真实聊天中使用已接收的附件：导入知识库或整理投稿包。参数与同名格式匠工具相同，request_id 必须稳定。',
      // 参数 schema 里的 object 必须显式声明 additionalProperties：宿主的编译器会直接拒绝，
      // 而这个拒绝发生在装配期——一条工具写错会把整个插件的工具、技能与面板路由一起带走。
      parameters: { operation: { type: 'string', required: true, enum: ['import_knowledge_base_files', 'build_submission_package'] }, arguments: { type: 'object', required: true, additionalProperties: true } },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '附件操作完成') },
      async execute(args, exec) {
        if (!['import_knowledge_base_files', 'build_submission_package'].includes(args?.operation)) return { ok: false, text: '附件操作无效' };
        try { return { ok: true, ...await callHost(exec, args.operation, args.arguments) }; }
        catch (error) { return { ok: false, text: error.message }; }
      },
    })));
    disposers.push(register(defineTool({
      name: 'formatjiang_save_file',
      description: '将格式匠的 file_id 保存为本机文件，支持大文件。校验完整大小和摘要后才返回成功，不覆盖已有文件。',
      parameters: { file_id: { type: 'string', required: true }, path: { type: 'string', required: true, description: '保存位置的绝对路径' } },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || (value?.saved ? `已保存：${value.path}` : '文件未保存')) },
      async execute(args, exec) {
        if (!path.isAbsolute(String(args?.path || ''))) return { ok: false, text: '保存位置必须是绝对路径' };
        try { return { ok: true, ...await callHost(exec, 'save_file', { file_id: args.file_id }, args.path) }; }
        catch (error) { return { ok: false, text: error.message }; }
      },
    })));

    return () => {
      disposers.forEach((dispose) => dispose());
    };
  }, 'formatjiang: tools');

  /* ---------------------------- 提示词 ---------------------------- */

  safeEffect(() => {
    const systemPrompt = ctx.get?.('systemPrompt');
    if (!systemPrompt?.section) return () => {};
    const lines = [
      '## 格式匠（本机论文工具）',
      '',
      '用户装了「格式匠论文助手」。它把本机格式匠的论文项目、版式配置、提交检查与知识库接成本机 MCP 工具，工具名前缀是 `mcp__formatjiang__`。',
      '- **两条通道，别互相等**：业务工具 `mcp__formatjiang__*` 由连接提供（preset 模式下来自「格式匠」预设里的官方 mcp 客户端）；宿主工具（`formatjiang_status/open/session/stage_attachment/import_document/use_attachments/save_file`）走独立的本机通道，只要程序与安装 ID 在、格式匠在运行就能用，不需要业务工具先出现在工具表里。附件收件、会话绑定、成品取回都走宿主通道。',
      '- 连接状态不明、或业务工具报连接错误时，先调用 `formatjiang_status`（它分别报桥接与宿主通道）；格式匠没运行就调用 `formatjiang_open`。`formatjiang_connect` 只在 mountScope 是 host 且确实要重建连接时用，preset 模式下它会明确告诉你「不用重连」。不要在断线状态下反复重试业务工具。',
      '- 用户要求「在格式匠里建论文 / 套版」而这条链路走不通时：停下来把阻塞点与下一步（`formatjiang_open`、确认会话选了「格式匠」预设、或在格式匠界面里手动导入）说清楚并问用户；不要用 python-docx 等脚本模仿版式冒充格式匠的产物，也不要把宿主工具报的错误说成「本会话没选预设」。',
      '- 研究任务卡还没到交付阶段时，不要调用 mcp__formatjiang__*。交付阶段只做三件事：formatjiang_receive_manuscript 取回 file_id、paper_id、version_id；preview_layout_plan 预览；用户在当前对话明确同意后才 apply_layout_as_branch。预览之后停止本回合。',
      '- 应用没在运行时先 formatjiang_open。formatjiang_status 会写已注册的业务工具数量，以及本阶段该用哪些。',
      '- file_id、paper_id、version_id 以工具文本里的编号为准，不要从目录名反推。',
      '- 要做套版、提交检查或资料取证这类完整流程，并且任务卡已经进入交付或用户本来就在处理格式匠里的论文时，再用 `skill` 工具加载 `' + SKILL_NAME + '`。',
      '- 插件会在对话里渲染套版方案卡与提交检查卡；卡片已经展示出来的内容不要在回答里重复复述。',
    ];
    // 桥接在预设上时，这个会话很可能根本看不到业务工具：先把这句话摆前面，
    // 否则模型会照常去找 mcp__formatjiang__*，然后一遍遍报「工具不存在」。
    if (config.mountScope !== 'host') {
      lines.splice(3, 0,
        '- **格式匠的业务工具只在「格式匠」预设的会话里加载**：本会话工具表里没有 `mcp__formatjiang__*` 时，先 `formatjiang_open` 确认应用在运行；应用开着、等过一个回合仍然没有，才是本会话没选这个预设。宿主工具（附件、会话身份）不依赖它们，照常可用。下面这些流程描述适用于那种会话。',
      );
    }
    // 字段名必须是 text：宿主按 PromptSection 契约读取 section.text，
    // 缺失时 renderPrompt 会在 text.length 上抛 TypeError，表现为「一发消息就报错」。
    return systemPrompt.section({
      name: 'formatjiang:assistant',
      order: 8500,
      interpolate: false,
      text: lines.join('\n'),
    });
  }, 'formatjiang: prompt');

  /* ---------------------------- 技能 ---------------------------- */

  /**
   * 工作流以运行时技能注册：模型只在需要时用 skill 工具加载正文，
   * 不把三条流程常驻在每轮系统提示词里。
   */
  safeEffect(() => {
    const skills = ctx.get?.('skills');
    if (!skills?.register) return () => {};
    try {
      const dispose = skills.register({
        name: SKILL_NAME,
        description: '用本机格式匠处理论文：套版（预览、确认、创建分支）、提交检查（跑诊断、读问题）、资料与页码取证。附件导入知识库和投稿打包用 formatjiang_use_attachments，宿主注入聊天身份。',
        whenToUse: '用户要给论文套用学校或期刊模板、做提交前检查、核对参考文献页码，或从本机资料里找依据时。',
        // source 是宿主的必填字段（SkillSummary.source），缺了会在加载技能时被判为非法定义。
        source: 'runtime',
        content: SKILL_CONTENT,
      });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    } catch (error) {
      logger?.warn?.(`[formatjiang] 注册技能失败：${String(error?.message || error)}`);
      return () => {};
    }
  }, 'formatjiang: skill');

  /* ---------------------------- 命令 ---------------------------- */

  safeEffect(() => {
    const commands = ctx.get?.('commands');
    if (!commands?.register) return () => {};
    return commands.register({
      name: 'formatjiang',
      description: '查看格式匠接入状态；`重连` 重建桥接，`断开` 主动断开并暂停自动重连，`诊断` 生成可复制的诊断信息',
      input: { hint: '留空查看状态，或输入 重连 / 断开 / 诊断' },
      handler: (invocation) => {
        const raw = String(invocation?.rawInput || '').trim();
        const keyword = raw.toLowerCase();
        if (keyword === '诊断' || keyword === 'doctor' || keyword === 'diag') {
          const snap = snapshot();
          return { kind: snap.usable ? 'success' : 'error', text: diagnosticsText(snap) };
        }
        if (keyword === '重连' || keyword === 'connect' || keyword === 'reconnect') {
          // 预设模式下这条命令没有可重建的连接：照实说明，别让一句「重连失败」把人带偏。
          if (config.mountScope !== 'host') {
            const note = connectScopeNote();
            return { kind: note.ok ? 'success' : 'error', text: note.text };
          }
          resetAutoReconnect();
          const result = mount({ restart: true });
          const snap = snapshot();
          if (!result.ok) return { kind: 'error', text: `重连失败：${result.error}` };
          return { kind: 'success', text: `已重建连接：${snap.label}${snap.detail ? `（${snap.detail}）` : ''}` };
        }
        if (keyword === '断开' || keyword === '断连' || keyword === 'disconnect') {
          if (config.mountScope !== 'host') {
            return { kind: 'error', text: disconnectScopeText() };
          }
          resetAutoReconnect();
          disconnect();
          return { kind: 'success', text: '已断开格式匠连接，自动重连暂停；输入「格式匠 重连」恢复。' };
        }
        const snap = snapshot();
        const lines = [`格式匠：${snap.label}`];
        // 预设模式下没有交接记录时，detail 就是下面那行分工说明；同一句不要打两遍。
        if (snap.detail && (snap.mountScope === 'host' || snap.presetBridge)) lines.push(snap.detail);
        if (snap.mountScope !== 'host' && !snap.presetBridge) {
          lines.push(MOUNT_SCOPE_HINT[snap.mountScope] || MOUNT_SCOPE_HINT.preset);
        }
        // 宿主工具与桥接是两条路：把这条单独报出来，免得「未挂载」被读成整个插件坏了。
        lines.push(hostChannelText(snap));
        if (snap.server.toolCount) lines.push(`工具 ${snap.server.toolCount} 个`);
        for (const hint of snap.hints) lines.push(`待处理：${hint}`);
        lines.push('输入 `/formatjiang 诊断` 可生成可复制的接入信息。');
        return { kind: snap.usable ? 'success' : 'error', text: lines.join('\n') };
      },
    });
  }, 'formatjiang: command');

  /* ---------------------------- 面板通道 ---------------------------- */

  whenReady('webServer', (scope) => {
    const webServer = scope.webServer ?? scope.get?.('webServer');
    if (!webServer?.register) throw new Error('宿主的 webServer 服务不可用，插件页读不到状态');
    let selfOrigin = null;
    try {
      selfOrigin = webServer.getOrigin?.() ?? null;
    } catch {
      selfOrigin = null;
    }

    const json = (res, status, payload) => {
      // 连接可能已经被对端断掉（超时或体积被拒后我们会主动收连接），
      // 写失败只记一条警告，不让它变成未处理的异常。
      try {
        if (res.writableEnded) return;
        const body = JSON.stringify(payload);
        res.statusCode = status;
        res.setHeader?.('content-type', 'application/json; charset=utf-8');
        res.setHeader?.('cache-control', 'no-store');
        res.end(body);
      } catch (error) {
        logger?.warn?.(`[formatjiang] 写面板响应失败：${String(error?.message || error)}`);
      }
    };

    /**
     * 读 JSON 请求体。
     *
     * 两道上限：64KB 体积、15 秒读完全程。没有超时的话，一个只发 Content-Length
     * 却不发内容的连接会让 Promise 永远悬着、socket 一直不释放。只解析一次，
     * 解析完就不再收数据。
     */
    const readBody = (req) => new Promise((resolve, reject) => {
      let size = 0;
      let settled = false;
      let timer = null;
      const chunks = [];
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      timer = setTimeout(() => {
        settle(reject, Object.assign(new Error('读取请求体超时'), { status: 408 }));
      }, 15000);
      req.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > 64 * 1024) {
          settle(reject, Object.assign(new Error('请求体过大'), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        if (!chunks.length) return settle(resolve, {});
        try {
          settle(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          settle(reject, Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
        }
      });
      req.on('error', (error) => settle(reject, error));
    });

    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE_BASE,
      handler: async (req, res) => {
        const host = String(req.headers?.host || '').toLowerCase();
        const remote = String(req.socket?.remoteAddress || '');
        const remoteLoopback = /^(::1|::ffff:127\.|127\.)/.test(remote) || remote === '';
        if (host ? !LOOPBACK.has(host.split(':')[0]) : !remoteLoopback) {
          return json(res, 403, { ok: false, error: '仅允许本机访问' });
        }
        const origin = req.headers?.origin;
        if (origin && selfOrigin) {
          try {
            const allowed = new URL(selfOrigin);
            const actual = new URL(String(origin));
            if (actual.host !== allowed.host) return json(res, 403, { ok: false, error: '跨源请求被拒绝' });
          } catch {
            return json(res, 403, { ok: false, error: '来源无法解析' });
          }
        }
        const url = new URL(String(req.url || '/'), 'http://localhost');
        const action = url.pathname.slice(ROUTE_BASE.length) || '/state';
        try {
          if (action === '/state' && req.method === 'GET') {
            return json(res, 200, { ok: true, state: snapshot() });
          }
          if (action === '/diagnostics' && req.method === 'GET') {
            const snap = snapshot();
            return json(res, 200, { ok: true, text: diagnosticsText(snap), state: snap });
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
          const body = await readBody(req);
          if (action === '/catalog') {
            const entry = await readCatalog({ force: true });
            if (!entry) return json(res, 400, { ok: false, error: '没有可用的本机安装', state: snapshot() });
            return json(res, entry.error ? 424 : 200, {
              ok: !entry.error,
              error: entry.error || '',
              state: snapshot(),
            });
          }
          if (action === '/disconnect') {
            // 预设模式没有可断开的连接：别把 paused 置上，否则插件页会显示一个
            // 按不回来的「已断开」，宿主通道也会被一起挡住。
            if (config.mountScope !== 'host') {
              return json(res, 200, { ok: true, note: disconnectScopeText(), state: snapshot() });
            }
            resetAutoReconnect();
            disconnect();
            return json(res, 200, { ok: true, state: snapshot() });
          }
          if (action === '/connect') {
            // 预设模式下这条没有可重建的连接：回说明，而不是一句「重连失败」。
            if (config.mountScope !== 'host') {
              const note = connectScopeNote();
              return json(res, note.ok ? 200 : 400, {
                ok: note.ok,
                error: note.ok ? '' : note.text,
                note: note.text,
                state: snapshot(),
              });
            }
            resetAutoReconnect();
            const result = mount({ restart: body?.restart !== false });
            if (result.busy) return json(res, 429, { ok: false, error: result.error, state: snapshot() });
            return json(res, result.ok ? 200 : 400, { ok: result.ok, error: result.error || '', state: snapshot() });
          }
          if (action === '/open') {
            resetAutoReconnect();
            const executable = resolveExecutable(config);
            if (!executable.path) return json(res, 400, { ok: false, error: `没有找到格式匠程序（${EXE_NAME}）`, state: snapshot() });
            const launched = launchDesktop(executable.path);
            if (!launched.ok) return json(res, 400, { ok: false, error: launched.error, state: snapshot() });
            return json(res, 200, { ok: true, state: snapshot() });
          }
          return json(res, 404, { ok: false, error: `未知操作 ${action}` });
        } catch (error) {
          const status = Number(error?.status) || 500;
          const replied = json(res, status, { ok: false, error: String(error?.message || error) });
          // 体积超限或超时：响应已经写回去，这边把连接收掉，不再等对端发完。
          if (status === 413 || status === 408) req.destroy?.();
          return replied;
        }
      },
    });
    state.panel = { ok: true, origin: selfOrigin || '', at: new Date().toISOString(), error: '' };
    return dispose;
  }, 'formatjiang: panel route', (error) => {
    state.panel = { ok: false, origin: '', at: new Date().toISOString(), error: String(error?.message || error) };
  });

  /* ---------------------------- 启动 ---------------------------- */

  // mcpManager 就绪后再挂桥接：它比插件晚启动时，以前会静默不挂；
  // 服务重启时 ctx.inject 会带着新服务重跑这段，桥接跟着重建。
  // mountScope 不是 host 时不挂：桥接要么在「格式匠」预设里，要么用户自己在别处配。
  if (config.mountScope === 'host') {
    whenReady('mcpManager', (scope) => {
      // inject 回调里这个服务才可安全取用；记下来给面板与状态工具复用。
      mcpManagerService = scope.mcpManager ?? safeService('mcpManager');
      mount();
      startSupervisor();
      return () => {
        mcpManagerService = null;
        stopSupervisor();
        unmount();
      };
    }, 'formatjiang: bridge');
  } else {
    // 上一轮可能还是 host 在挂：这里当场把交接台上的「宿主在挂」清掉，
    // 否则预设那一份会以为有人占着位置，十分钟内都不肯上场。
    writeSharedState('hostBridge', { mounted: false, at: Date.now() });
  }
}

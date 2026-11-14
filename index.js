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
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'formatjiang-assistant';

/** tools 与 mcpManager 是硬依赖；commands、systemPrompt、webServer 缺了只降级，不阻止挂载。 */
export const inject = ['tools', 'mcpManager'];

const require = createRequire(import.meta.url);

/** 网关里的服务名，决定工具前缀 mcp__formatjiang__。 */
const SERVER_NAME = 'formatjiang';
const ROUTE_BASE = '/formatjiang/api';
const EXE_NAME = '格式匠.exe';
const STARTUP_TIMEOUT_MS = 90000;
const TOOL_CALL_TIMEOUT_MS = 270000;

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
  '工具报连接错误或调用超时，先 `formatjiang_status`；需要重建连接用 `formatjiang_connect`；格式匠没有运行时先用 `formatjiang_open` 打开它，等窗口出现再重连。不要在断线状态下反复重试业务工具，也不要把连接失败说成论文本身的问题。',
  '',
  '## 一份新稿从对话走到成品',
  '',
  '这是最长的一条链，中途任何一步都可能中断，所以每步都留下可以用编号接着做的位置。',
  '',
  '1. `formatjiang_stage_attachment({ path })` 把用户交给你的文件复制进格式匠收件区，拿到 `file_id`；收件区只接受这一步送进去的文件。',
  '2. 暂存工具已经通过宿主通道登记附件并返回 file_id，不要再调用 receive_file；它还会绑定本次真实聊天。',
  '3. `formatjiang_import_document({ file_id, as_new_paper, request_id })`：新建论文；或传 `paper_id`（可加 `parent_version_id`）往既有论文追加版本。两者必须二选一，都不给会直接报错，不会替你新建论文。返回 `version_id` 后再进下一步；不要跳过导入直接改原文件。',
  '4. `formatjiang_session({ action: "bind", paper_id, version_id })` 把当前对话绑到这篇论文；换会话或断线后用 `formatjiang_session({ action: "get" })` 取回，不要重新问用户是哪一篇。',
  '5. `read_document_outline` → `read_document_chunk` 读稿；`search_document` 在全文里找具体句子。读到的是受管版本的真实正文，不要凭篇名推测内容。',
  '6. `create_structure_plan` 生成待确认的段落分类计划，`get_structure_plan` 复核条目；条目有歧义时逐条问用户，用户确认后 `confirm_structure_plan({ plan_id, expected_plan_hash })` 落成已确认快照。计划过期或源文件变过会返回 `FJ_SOURCE_CHANGED`，此时重新 `create_structure_plan`，不要拿旧计划硬套。',
  '7. `list_layout_configs` 找模板 → `preview_layout_plan` 预览影响范围（可带 `scope_mode` 与 `scope_selected_types` 只套部分段落类型）→ 用户明确同意后 `apply_layout_as_branch`。',
  '8. 需要检查时 `start_diagnostic_run` 异步启动，`get_diagnostic_status` 轮询，`list_findings` 分页读问题；中途可以 `cancel_diagnostic_run`，失败项用 `retry_diagnostic_run`。',
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
  '3. `get_diagnostic_status` 看子任务执行记录：哪些跑完、哪些失败、失败原因是什么。失败项用 `retry_diagnostic_run` 补跑，不要靠重跑整篇掩盖失败。',
  '4. `list_findings({ run_id, severity, offset })` 分页读问题清单；`run.findings` 只是首批，完整清单要翻页。',
  '5. 结论只讲能落到证据上的：每条问题带 message、severity 与 evidence（来源、段落序号、原文摘录）。不要自己编页码、章节号或「通过多少条」——格式匠只给问题清单。',
  '6. `source_changed` 为 true 表示源文件在检查后又变过，报告不能当作当前文件的结论，要提醒用户重跑。',
  '',
  '## 引文与页码核对',
  '',
  '1. `preview_citation_check({ paper_id, draft_id, version_id })` 先清点：有多少处引用可核对、哪些还缺来源。缺来源的先补，不要拿去核对。',
  '2. `start_citation_check` 启动运行，`get_citation_check_run` 看进度，`list_citation_check_items` 逐条读结果，`get_citation_check_item` 看原文摘录、候选页码与页码映射。',
  '3. 缺来源时 `list_citation_source_candidates` 在资料库里找，选定后 `preflight_citation_source` 体检；关联与改页码由用户在桌面确认，不要在对话里替用户落笔。',
  '4. 页面对不上要如实说「写成第 X 页，原文在第 Y 页」并给出摘录；不要用「看起来像」判断。',
  '',
  '## 找格式与格式共坊',
  '',
  '1. 需要外部模板时 `search_forge_templates` 检索共坊；未配置服务会返回 `configured=false`，这不是故障，说明本机没配共坊地址即可。',
  '2. `get_forge_template` 看详情与当前公开版本。',
  '3. `check_forge_import` 核对能否导入：`already_imported_id` 大于 0 说明本机已有这一版；`requires_confirmation` 为真时必须先把 `notices` 逐条念给用户。',
  '4. 用户明确接受后才 `import_forge_template({ template_id, version_id, confirm_profile_warnings })`，导入后得到本地 `layout_config_id`。',
  '5. 「找格式」生成任务用 `prepare_layout_generation` → `submit_layout_sources` → `start_layout_generation`；断线后用 `list_layout_generations` 找任务、`list_layout_generation_events({ after_event_id })` 补读事件、`guide_layout_draft_revision` 看下一步该改哪里。',
  '',
  '## 资料、知识库与投稿',
  '',
  '1. `list_knowledge_bases` → `search_knowledge_base` 找依据；跨库检索用 `search_knowledge_bases`，命中带库名。',
  '2. 建库 `create_knowledge_base`，通过 `formatjiang_use_attachments({ operation: "import_knowledge_base_files", arguments: { knowledge_base_id, file_ids, request_id } })` 导入——只接受本次聊天接收过的文件编号；导入是异步的，用 `get_rag_run` 看进度，`cancel_rag_run` 取消。',
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
  const logger = ctx.logger ?? ctx.get?.('logger');
  const state = {
    disposeServer: null,
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
    target: { executable: '', installationId: '', installationKind: '', dataDir: '', error: '' },
  };

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

  function unmount() {
    if (typeof state.disposeServer === 'function') {
      try {
        state.disposeServer();
      } catch (error) {
        logger?.warn?.(`[formatjiang] 卸载桥接失败：${String(error?.message || error)}`);
      }
    }
    state.disposeServer = null;
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
          state.disposeServer = ctx.mcpManager.register(SERVER_NAME, {
            transport: 'stdio',
            command: target.executable,
            args: ['mcp', 'bridge', '--installation-id', target.installationId],
            startupTimeoutMs: config.startupTimeoutMs,
            toolCallTimeoutMs: config.toolCallTimeoutMs,
          });
          state.lastMountAt = Date.now();
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
   * 格式匠的网关端口是否在监听。
   *
   * 「用户完全退出」这条错误会一直留在宿主的状态里，直到下一次连接成功为止；
   * 用户手动把格式匠打开之后，如果只按错误文本判断，就再也不会自动接上。
   * 端口探一下最直接：它同时排除了「应用没开」和「MCP 服务没开」两种情况。
   */
  function gatewayListening() {
    const settings = readMcpSettings(state.target?.dataDir);
    const port = Number(settings?.port) || 0;
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
    if (!snap.ok) return Promise.reject(new Error('格式匠还没连上，请先恢复连接'));
    return new Promise((resolve, reject) => {
      const child = execFile(snap.formatjiang.executable,
        ['mcp', 'host', '--installation-id', snap.formatjiang.installationId, '--chat-id', chat],
        { windowsHide: true, timeout: 302000, maxBuffer: 2 * 1024 * 1024, signal: exec?.signal },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(error.name === 'AbortError' ? '本次操作已取消；已开始的业务请查询原任务，不要换编号重发' : (String(stderr || '').trim() || error.message)));
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
   */
  function launchDesktop(executable) {
    if (!executable) return { ok: false, error: '没有找到格式匠程序' };
    let child;
    try {
      child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: true });
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
    try {
      const list = ctx.mcpManager.list();
      return list.find((item) => item.name === SERVER_NAME) ?? null;
    } catch (error) {
      return { name: SERVER_NAME, configured: false, status: { state: 'failed', reason: 'load', lastError: String(error?.message || error) } };
    }
  }

  function describe(status) {
    if (!status) return { tone: 'error', label: '未挂载', detail: state.mountError || '桥接没有注册成功' };
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

  function describeRetry(nextRetryAtMs) {
    const remain = Number(nextRetryAtMs) - Date.now();
    if (!Number.isFinite(remain) || remain <= 0) return '即将重试';
    return `${Math.max(1, Math.round(remain / 1000))} 秒后重试`;
  }

  function snapshot() {
    const target = state.target;
    const settings = readMcpSettings(target.dataDir);
    const view = serverView();
    const status = view?.status ?? null;
    const description = state.paused
      ? { tone: 'idle', label: '已断开', detail: '手动断开，点「重新连接」恢复' }
      : describe(status);
    const updating = updateInProgress();
    const hints = [];
    if (target.error) hints.push(target.error);
    if (state.mountError && state.mountError !== target.error) hints.push(state.mountError);
    if (state.lastOpenError) hints.push(`上次打开格式匠失败：${state.lastOpenError}`);
    if (settings && settings.enabled === false) hints.push('格式匠里的 MCP 服务已停用，桥接会连接失败');
    if (config.autoReconnect && state.autoRemounts >= AUTO_RECONNECT_MAX && status?.state === 'failed' && !updating) {
      hints.push('自动重连已经试过 3 次，仍然连不上；处理完格式匠那边的问题后点「重新连接」');
    }
    if (updating) hints.push('格式匠正在安装更新，装完会自动重连，不需要手动处理');
    return {
      ok: status?.state === 'connected',
      paused: state.paused,
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
        safeWrite: settings ? settings.safeWrite : null,
        updating,
      },
      hints,
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
      `桥接：${snap.bridge.transport} / ${snap.server.state} / 工具 ${snap.server.toolCount} 个`,
      `程序：${snap.formatjiang.executable || '未找到'}`,
      `安装：${snap.formatjiang.installationId || '未找到'}（${snap.formatjiang.installationKind || '未识别'}）`,
      `数据目录：${snap.formatjiang.dataDir || '未找到'}`,
    ];
    if (snap.formatjiang.mcpEnabled === false) {
      lines.push('格式匠 MCP 服务：已停用');
    } else if (snap.formatjiang.port) {
      lines.push(`格式匠 MCP 服务：端口 ${snap.formatjiang.port}`);
    }
    if (snap.formatjiang.safeWrite !== null && snap.formatjiang.safeWrite !== undefined) {
      lines.push(`写入工具：${snap.formatjiang.safeWrite ? '已开启（每次需要确认）' : '未开启'}`);
    }
    if (snap.server.attempt) {
      lines.push(`重连进度：第 ${snap.server.attempt}/${snap.server.maxAttempts || '?'} 次`);
    }
    if (snap.server.lastError) lines.push(`最近错误：${snap.server.lastError}`);
    for (const hint of snap.hints) lines.push(`待处理：${hint}`);
    lines.push(`采集时间：${snap.updatedAt}`);
    return lines.join('\n');
  }

  /* ---------------------------- 工具 ---------------------------- */

  function register(definition) {
    try {
      const dispose = ctx.tools.register(definition);
      return typeof dispose === 'function' ? dispose : () => {};
    } catch (error) {
      logger?.error?.(`[formatjiang] 注册工具 ${definition.name} 失败：${String(error?.message || error)}`);
      return () => {};
    }
  }

  ctx.effect(() => {
    const disposers = [];

    disposers.push(register(defineTool({
      name: 'formatjiang_status',
      description:
        '查看本机格式匠的接入状态：桥接通没通、工具数量、最近错误、程序与安装 ID 是否找到。'
        + '用户问「格式匠连上了吗」「为什么格式匠的工具用不了」时先调它，不要盲目重试业务工具。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已读取格式匠状态') },
      async execute() {
        const snap = snapshot();
        const lines = [`格式匠：${snap.label}${snap.detail ? `（${snap.detail}）` : ''}`];
        if (snap.server.toolCount) lines.push(`工具：${snap.server.toolCount} 个，前缀 mcp__${SERVER_NAME}__`);
        if (snap.formatjiang.executable) lines.push(`程序：${snap.formatjiang.executable}`);
        if (snap.formatjiang.installationId) {
          lines.push(`安装：${snap.formatjiang.installationId}（${snap.formatjiang.installationKind || '本机客户端'}）`);
        }
        for (const hint of snap.hints) lines.push(`待处理：${hint}`);
        return { ok: snap.ok, text: lines.join('\n'), ...snap };
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_connect',
      description:
        '重新发现并重连本机格式匠：填好程序路径或安装 ID 以后、或桥接放弃重试以后用它。'
        + '它只重建连接，不改变论文、版本或版式配置。',
      parameters: {
        restart: { type: 'boolean', description: '已经有连接时是否强制重建一次（默认 true；传 false 复用现有连接）' },
      },
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已重新连接格式匠') },
      async execute(args) {
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
        resetAutoReconnect();
        disconnect();
        const snap = snapshot();
        // ok 表示这次动作成功；连接状态看 label / server.state，不要混用。
        return { ...snap, ok: true, text: '已断开格式匠连接；需要恢复时调用 formatjiang_connect' };
      },
    })));

    disposers.push(register(defineTool({
      name: 'formatjiang_open',
      description: '打开本机格式匠桌面应用。格式匠没运行时，桥接无法连接，先打开它再重试。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已请求打开格式匠') },
      async execute() {
        // 打开只需要可执行文件，不需要读格式匠数据库：少一次 77MB 库的打开。
        const executable = resolveExecutable(config);
        if (!executable.path) {
          return { ok: false, text: `没有找到格式匠程序（${EXE_NAME}），可在插件配置里填写 executablePath` };
        }
        const launched = launchDesktop(executable.path);
        if (!launched.ok) {
          return { ok: false, text: `打开格式匠失败：${launched.error}` };
        }
        return { ok: true, text: `已请求打开格式匠：${executable.path}。首次启动较慢，等窗口出现后再调用一次 formatjiang_connect。` };
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
        return { ok: snap.ok, text, ...snap };
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
        if (!snap.ok) return { ok: false, text: `格式匠还没连上：${snap.detail || '先按插件页接入'}`, ...snap };
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
          return { ok: true, text: '已接收附件，可用 formatjiang_import_document 导入。', ...result };
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
        try { return { ok: true, ...await callHost(exec, 'import_document', args) }; }
        catch (error) { return { ok: false, text: error.message }; }
      },
    })));
    disposers.push(register(defineTool({
      name: 'formatjiang_use_attachments',
      description: '在本次真实聊天中使用已接收的附件：导入知识库或整理投稿包。参数与同名格式匠工具相同，request_id 必须稳定。',
      parameters: { operation: { type: 'string', required: true, enum: ['import_knowledge_base_files', 'build_submission_package'] }, arguments: { type: 'object', required: true } },
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

  ctx.effect(() => {
    const systemPrompt = ctx.get?.('systemPrompt');
    if (!systemPrompt?.section) return () => {};
    const lines = [
      '## 格式匠（本机论文工具）',
      '',
      '用户装了「格式匠论文助手」。它把本机格式匠的论文项目、版式配置、提交检查与知识库接成本机 MCP 工具，工具名前缀是 `mcp__formatjiang__`。',
      '- 连接状态不明、或业务工具报连接错误时，先调用 `formatjiang_status`；需要重连就调用 `formatjiang_connect`；格式匠没运行就调用 `formatjiang_open`。不要在断线状态下反复重试业务工具。',
      '- 只用这些工具处理用户已经导入格式匠的论文、受管版本、版式配置、诊断与本地资料；不要把它当通用文件系统或互联网搜索。',
      '- 业务 ID 一律先用 `list_*` 发现，不要猜。',
      '- 写操作只有格式匠开启安全写后才出现，且都要先讲清影响再执行：套版的 `apply_layout_as_branch` 必须先 `preview_layout_plan` 并由用户在对话里明确同意；其余写操作（导入新稿、确认结构、生成批注稿或修订稿、切换当前版本、导入共坊版式、建库与导入资料、整理投稿包、续跑资料导入）同样只能对用户点名过的对象执行。',
      '- 提交检查：先用 `list_diagnostic_profiles` 选 profile，长稿用 `start_diagnostic_run` 异步跑、`get_diagnostic_status` 轮询，再用 `list_findings` 分页读问题；报告里的数字必须能在工具结果里找到出处。',
      '- 创建类操作需要稳定的 request_id，同次操作的重试沿用原编号，不得换编号绕过结果未知状态。附件到知识库或投稿包用 formatjiang_use_attachments；大文件必须调用 formatjiang_save_file 保存。\n- 新稿从对话走到成品：`formatjiang_stage_attachment` 把用户给的文件放进格式匠收件区 → 自动接收 → `formatjiang_import_document` 建论文或追加版本 → `create_structure_plan` / `confirm_structure_plan` 确认结构 → 预览并套版 → 检查 → 导出 → `formatjiang_save_file` 保存成品。`receive_file` 只接受收件区里的路径，不要直接把别的本机路径塞进去。中途断线用 `list_interrupted_tasks` 盘点、`formatjiang_session` 找回当前论文。',
      '- 引文页码核对走 `preview_citation_check` → `start_citation_check` → `list_citation_check_items` → `get_citation_check_item`；页面对不上就如实给出候选页码与摘录，不要用「看起来像」判断。',
      '- 投稿前用 `inspect_blind_review` 看匿名残留，用 `build_submission_package` 整理交付；返回里的 `missing` 与 `unresolved_requirements` 必须原样转述，它们不是「材料已齐全」的证明。',
      `- 要做套版、提交检查或资料取证这类完整流程时，先用 \`skill\` 工具加载 \`${SKILL_NAME}\`，按里面的步骤走。`,
      '- 插件会在对话里渲染套版方案卡与提交检查卡；卡片已经展示出来的内容不要在回答里重复复述。',
    ];
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
  ctx.effect(() => {
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

  ctx.effect(() => {
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
          return { kind: snap.ok ? 'success' : 'error', text: diagnosticsText(snap) };
        }
        if (keyword === '重连' || keyword === 'connect' || keyword === 'reconnect') {
          resetAutoReconnect();
          const result = mount({ restart: true });
          const snap = snapshot();
          if (!result.ok) return { kind: 'error', text: `重连失败：${result.error}` };
          return { kind: 'success', text: `已重建连接：${snap.label}${snap.detail ? `（${snap.detail}）` : ''}` };
        }
        if (keyword === '断开' || keyword === '断连' || keyword === 'disconnect') {
          resetAutoReconnect();
          disconnect();
          return { kind: 'success', text: '已断开格式匠连接，自动重连暂停；输入「格式匠 重连」恢复。' };
        }
        const snap = snapshot();
        const lines = [`格式匠：${snap.label}`];
        if (snap.detail) lines.push(snap.detail);
        if (snap.server.toolCount) lines.push(`工具 ${snap.server.toolCount} 个`);
        for (const hint of snap.hints) lines.push(`待处理：${hint}`);
        lines.push('输入 `/formatjiang 诊断` 可生成可复制的接入信息。');
        return { kind: snap.ok ? 'success' : 'error', text: lines.join('\n') };
      },
    });
  }, 'formatjiang: command');

  /* ---------------------------- 面板通道 ---------------------------- */

  ctx.effect(() => {
    const webServer = ctx.get?.('webServer');
    if (!webServer?.register) {
      logger?.warn?.('[formatjiang] 宿主没有 webServer 服务，插件页将无法读取状态');
      return () => {};
    }
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

    return webServer.register({
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
            resetAutoReconnect();
            disconnect();
            return json(res, 200, { ok: true, state: snapshot() });
          }
          if (action === '/connect') {
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
  }, 'formatjiang: panel route');

  /* ---------------------------- 启动 ---------------------------- */

  ctx.effect(() => {
    mount();
    startSupervisor();
    return () => {
      stopSupervisor();
      unmount();
    };
  }, 'formatjiang: bridge');
}

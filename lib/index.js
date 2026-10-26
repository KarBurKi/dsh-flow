/**
 * dsh-flow — 跨会话流程编排（Host 半，零依赖）
 *
 * 四个角色：统筹 / 预研 / 开发 / 测试。一条活的闭环：
 *   预研提需求 → 统筹建卡拆解 → 开发实现 / 测试独立验 → 统筹汇总 → 归档 → 回到起点
 *
 * 设计约束（与剧场插件无关，不 import 它，也不 import 任何核心包）：
 *   - 消息对象按 dsh-llm 的 createUserMessage 形状手工构造（role/content/source/id）
 *   - 工具按 dsh-tools 的 register(definition) 契约手写（parameters 用 JSON Schema）
 *   - 投递自己实现：agent.steer + 等 session/event 的 turn/end
 *
 * 状态流转：pending → processing → done。验收结论写在卡里的「## 验收」段，
 * 归档前核对文件 SHA-256，移动前后一致才算成。
 */
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "flow";
export const inject = ["tools"];

const HOME = os.homedir();
const PLUGIN_DIR = path.join(HOME, ".dsh", "plugins", "dsh-flow");
const CONFIG_FILE = path.join(PLUGIN_DIR, "config.json");
/** 全局会话状态表：所有会话共用一张，不归任何插件。flow 用它判断「现在谁在跑」。 */
const SESSION_STATUS_TABLE = path.join(HOME, ".dsh", "会话状态.md");
const DEFAULT_TIMEOUT_MS = 180000;
/** 同一张卡最多自动退回几次；超过就转人工裁定，不再自动回开发。 */
const MAX_REJECTS = 2;
const ROLES = ["统筹", "预研", "开发", "测试"];

/** 0.2.0 状态机 6 态：pending → processing → blocked → waiting_verify → waiting_final → done。
 *  blocked 是开发遇疑问回传统筹（flow_ask）时的暂停位；任一环「不通过」回到 processing。 */
const STATUS = {
  pending: "pending",
  processing: "processing",
  blocked: "blocked",
  waitingVerify: "waiting_verify",
  waitingFinal: "waiting_final",
  waitingHuman: "waiting_human",
  done: "done",
};

const DEFAULT_CONFIG = {
  // 留空 = 未配置；首次使用前用 config.json 指到自己的工作区（见 README「配置」）
  workspace: "",
  tasksDir: "【文档区】\\计划与任务",
  archiveDir: "【归档区】",
  roles: {},
};

// ---------- 小工具 ----------

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** 等价于 dsh-llm 的 createUserMessage({content, source})。 */
function userMessage(content, source) {
  const raw = JSON.parse(JSON.stringify({ content, source, role: "user", id: randomUUID() }));
  return deepFreeze(raw);
}

function textBlocks(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

function blocksToText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function sessionIdOf(session, event) {
  if (session && session.id) return String(session.id);
  const data = event && event.data;
  if (data && data.sessionId) return String(data.sessionId);
  return "";
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function ymd(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function yyyymm(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** 文件名里不要出现下划线、斜杠、冒号。 */
function sanitize(text, fallback = "NA") {
  const cleaned = String(text ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/_/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned || fallback;
}

function config() {
  const raw = readJson(CONFIG_FILE, {});
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const roles = base.roles && typeof base.roles === "object" && !Array.isArray(base.roles) ? base.roles : {};
  return { ...DEFAULT_CONFIG, ...base, roles: { ...roles } };
}

function saveConfig(patch) {
  const next = { ...config(), ...patch };
  writeJson(CONFIG_FILE, next);
  return next;
}

function tasksDir() {
  return path.join(config().workspace, config().tasksDir);
}

/**
 * 派活登记单：一行一条，落在 【文档区】\进度\派活登记.md。
 * 只追加（appendFileSync 单行追加不会写半截），是旁路——写不进去不能把主流程带崩。
 * 但失败**不再静默**：console.error + 落 _dispatch-error.log，否则「登记单没写」会查不出原因。
 */
function logDispatch(actor, card, status, summary) {
  let dir = "";
  let file = "";
  try {
    const base = config();
    if (!base.workspace) {
      throw new Error("config.workspace 为空，推断不出【文档区】的位置（检查 config.json）");
    }
    dir = path.join(path.dirname(tasksDir()), "进度");
    file = path.join(dir, "派活登记.md");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        "# 派活登记\n\n一行一条。谁、任务、状态、摘要；由 dsh-flow 的各工具自动追加，角色要更细的自己再补。\n\n| 时间 | 谁 | 任务 | 状态 | 摘要 |\n| --- | --- | --- | --- | --- |\n",
        "utf8",
      );
    }
    const cell = (v) =>
      String(v == null ? "" : v)
        .replace(/\|/g, "\\|")
        .replace(/\r?\n/g, " ");
    fs.appendFileSync(file, `| ${stamp()} | ${cell(actor)} | ${cell(card)} | ${cell(status)} | ${cell(summary)} |\n`, "utf8");
    return true;
  } catch (error) {
    const detail = error && error.stack ? error.stack : String(error);
    console.error(`[dsh-flow] 派活登记单写入失败：${detail}`);
    try {
      fs.appendFileSync(
        path.join(PLUGIN_DIR, "_dispatch-error.log"),
        `${new Date().toISOString()}  目标=${file || dir || "（未解析）"}\n${detail}\n\n`,
        "utf8",
      );
    } catch {
      // 连错误日志都写不了就只能靠 console
    }
    return false;
  }
}

/** 解析全局会话状态表（markdown 表格）。读不到或格式不对时返回空数组，不抛错。 */
function readSessionStatus() {
  let text = "";
  try {
    text = fs.readFileSync(SESSION_STATUS_TABLE, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((c) => c.trim());
    // ['', 会话id, 角色, 状态, 更新时间, ''] —— 表头与分隔线在这里被过滤掉
    if (cells.length < 6) continue;
    const id = cells[1];
    if (!/^session-/.test(id)) continue;
    rows.push({
      id,
      role: cells[2] || "（未填）",
      state: cells[3] || "",
      updated: cells[4] || "",
    });
  }
  return rows;
}

function archiveDir() {
  return path.join(config().workspace, config().archiveDir);
}

// ---------- 任务卡：YAML 头与正文 ----------

function parseCard(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { head: {}, body: text, hasHead: false };
  const head = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    head[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { head, body: text.slice(match[0].length), hasHead: true };
}

const HEAD_ORDER = ["from", "to", "to_session", "downstream", "type", "ticket", "status", "created"];

function renderHead(head) {
  const lines = ["---"];
  for (const key of HEAD_ORDER) {
    if (head[key] !== undefined && head[key] !== "") lines.push(`${key}: ${head[key]}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * 只在 YAML 头（第一对 `---` 之间）里做替换：把改头的事关进头里。
 *
 * 不这么干会出事：头里没有 `to_session` 而行文里贴了一段带 `to_session:` 的证据（开发就爱在回执里贴卡头原文），
 * 旧写法 `^to_session:.*$` 会先命中**正文**那一行——头没补上、正文被改写，卡头等于没记持有人。
 * 2026-10-26 16:00 这单就踩了：交卡后卡头仍无 `to_session`，被改的是回执代码块里那行引用。
 */
function inHead(text, fn) {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  if (!m) return "";
  return text.slice(0, m.index) + m[1] + fn(m[2]) + m[3] + text.slice(m.index + m[0].length);
}

/** 只改 YAML 头里的 status（正文里的同名字符串不动）。 */
function setStatus(text, status) {
  const { hasHead } = parseCard(text);
  if (!hasHead) throw new Error("这张卡没有 YAML 头，不敢改状态");
  const next = inHead(text, (inner) => inner.replace(/^(status:\s*).*$/m, `$1${status}`));
  if (!next) throw new Error("这张卡没有 YAML 头，不敢改状态");
  return next;
}

/** 派给某角色时默认的下一站。 */
function downstreamOf(role) {
  if (role === "开发") return "测试";
  if (role === "测试") return "统筹";
  if (role === "统筹") return "开发";
  return "";
}

/** 写 / 改 YAML 头里的单个字段（有就替换，没有就插在 status 后面）。只在头里动手，见 `inHead` 注释。 */
function upsertHead(text, key, value) {
  const { hasHead } = parseCard(text);
  if (!hasHead) throw new Error("这张卡没有 YAML 头，不敢写 " + key);
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  const next = inHead(text, (inner) => {
    if (re.test(inner)) return inner.replace(re, line);
    if (/^status:.*$/m.test(inner)) return inner.replace(/^(status:.*)$/m, `$1\n${line}`);
    return `${line}\n${inner}`;
  });
  if (!next) throw new Error("这张卡没有 YAML 头，不敢写 " + key);
  return next;
}

/**
 * 剔掉围栏代码块的内容（``` 或 ~~~）：卡正文里贴一段含「## 验收」的代码块，那不是卡结构。
 * 缩进代码块（4 空格）不用管——段头正则要求 `##` 紧跟行首，缩进后的 `## 验收` 本来就命不中。
 * 未闭合的围栏**不当代码块**：卡是流程文件，段头必须可靠；手误漏一个 ``` 不该让后面真段头集体消失。
 * 剔掉的行换成空行，行数不变。
 */
function stripFencedBlocks(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  let open = null;
  const ranges = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (!open) {
      if (m) open = { ch: m[1][0], len: m[1].length, start: i };
    } else if (m && m[1][0] === open.ch && m[1].length >= open.len) {
      ranges.push([open.start, i]);
      open = null;
    }
  }
  if (!ranges.length) return lines.join("\n");
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i += 1) lines[i] = "";
  }
  return lines.join("\n");
}

/** 段追加：收拾尾部空白，空一行起段。四个写卡的段都该走这里，别各写各的。 */
function appendSection(text, section) {
  return String(text == null ? "" : text).trimEnd() + "\n\n" + String(section).replace(/\s+$/, "") + "\n";
}

/**
 * 改卡（读-改-写）：写之前重读磁盘，把改动套在**最新内容**上，而不是投递前抓的那份旧文本。
 *
 * 为什么必须这样：这些工具都是「先投递、再写卡」，而投递最长要等 120s。这期间别人追加的段
 * （测试写「## 验收」、统筹写「## 终审驳回」、开发自己补回执）会被一句 writeFileSync 整段覆盖。
 * 2026-10-26 15:49 C3 那张卡的「## 交付记录」就是这么没的：写入方拿的是投递前的旧文本，
 * 落盘时把中间新加的段一起抹掉；卡上只剩一句引用在代码块里的同名标题，流程找不到真交付记录，
 * 终审驳回就按"取不到原开发"投给了别人。
 *
 * 写完再读一次核对；连着三轮都被抢，报错不硬写（宁可不交，也不悄悄吃掉别人的段）。
 */
function commitCard(file, mutate) {
  let next = "";
  for (let i = 0; i < 3; i += 1) {
    const latest = fs.readFileSync(file, "utf8");
    next = mutate(latest);
    fs.writeFileSync(file, next, "utf8");
    if (fs.readFileSync(file, "utf8") === next) return next;
  }
  throw new Error(`写卡失败：${path.basename(file)} 正被别的会话反复改动，稍后重试（原卡没被写坏）`);
}

/**
 * 交卡自检：交付记录必须作为一个**真段**落在卡上（不是被围栏代码块包住，也不是被并发写吞掉）。
 * 卡是正本；交付记录一丢，下游 `originalDeveloper` 就取不到原开发，终审驳回会乱投人
 * （2026-10-26 15:53 就是这么驳到 1 号身上的）。
 */
function assertDeliveredRecord(text, at) {
  if (!stripFencedBlocks(text).includes(`## 交付记录（${at}）`)) {
    throw new Error(
      `卡上找不到「## 交付记录（${at}）」真段——写入被并发改动顶掉了，卡里的状态可能已经改了，先人工核一眼这张卡再重交`,
    );
  }
}

/** 这张卡最后一段验收的结论：「通过」「不通过」，或空（还没验过）。
 *  只认**行首**的 `## 验收`——理由正文里写的同名字样不算段头（与 reworkCounts 同一套段切规则）。 */
function lastVerdict(text) {
  const clean = stripFencedBlocks(text);
  const re = /(?:^|\n)## 验收/g;
  let idx = -1;
  let m;
  while ((m = re.exec(clean)) !== null) idx = m.index;
  if (idx < 0) return "";
  const v = /结论：(\S+)/.exec(clean.slice(idx));
  return v ? v[1] : "";
}

/**
 * 单行字段（理由 / 备注 / 报告 / 派单附言）：换行并成空格，行内 `#` 打成全角。
 * 理由里写「## 验收」或「- 类型：执行书缺陷」，它就是一句话，不许变成段头或字段。
 */
function safeLine(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * 多行正文（疑问 / 决策）：保留换行，但行首的段头与关键字段标记失效，
 * 这样正文里贴一段「## 验收」或「- 提交人：…」不会变成真段头、真字段。
 */
function safeBlock(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/^([ \t]*)#/gm, "$1＃")
    .replace(/^([ \t]*)-(类型|驳回人|提交人|结论|报告|轮次|理由|备注)：/gm, "$1－$2：");
}

/** 两类退回各几轮：实现缺陷 = 验收不通过 + 驳回(实现缺陷/未指定)；执行书缺陷 = 驳回(执行书缺陷)。 */
function reworkCounts(text) {
  const clean = stripFencedBlocks(text);
  const verifySections = clean.match(/(?:^|\n)## 验收[\s\S]*?(?=\n## |$)/g) || [];
  const rejected = verifySections.filter((s) => /结论：不通过/.test(s)).length;
  const rejectSections = clean.match(/(?:^|\n)## 终审驳回[\s\S]*?(?=\n## |$)/g) || [];
  let impl = rejected;
  let spec = 0;
  for (const s of rejectSections) {
    const m = /^- 类型：(.+)$/m.exec(s);
    const t = m ? m[1].trim() : "";
    if (t === "执行书缺陷") spec += 1;
    else impl += 1;
  }
  return { impl, spec };
}

/** 数卡里判过几次「不通过」——合并账：测试退回 + 统筹驳回（实现缺陷类）算同一本。 */
function rejectCount(text) {
  return reworkCounts(text).impl;
}

/** 数卡里终审驳回了几次（只数段数，给对账用，不参与上限判定）。 */
function rejectFinalCount(text) {
  const sections = stripFencedBlocks(text).match(/(?:^|\n)## 终审驳回[\s\S]*?(?=\n## |$)/g) || [];
  return sections.length;
}

/**
 * 从最后一个「## 交付记录」段里取原开发的会话 id，并把「被当成提交人的统筹」记下来。
 * 统筹不是开发：卡头 to_session 在建卡时常写统筹，那条兜底不能把统筹当成交卡人
 * （2026-10-26 5 号探针 F 反例：手工建卡 + 卡头是统筹 + 交卡不传 session → 提交人记成统筹）。
 */
function originalDeveloperInfo(text, coordinatorIds = new Set()) {
  const sections = stripFencedBlocks(text).match(/(?:^|\n)## 交付记录[\s\S]*?(?=\n## |$)/g) || [];
  const skipped = [];
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const m = /^- 提交人：(\S+)\s*$/m.exec(sections[i]);
    if (!m || !m[1].startsWith("session")) continue;
    if (coordinatorIds.has(m[1])) {
      // 统筹登记 id 落在提交人位置上是错位，不是开发；跳过并留痕，不静默当原开发
      skipped.push(m[1]);
      continue;
    }
    return { dev: m[1], skipped };
  }
  return { dev: "", skipped };
}

/** 兼容旧签名：只要会话 id，取不到返回空串。 */
function originalDeveloper(text, coordinatorIds) {
  return originalDeveloperInfo(text, coordinatorIds).dev;
}

function resolveCard(ref) {
  if (!ref || typeof ref !== "string") throw new Error("要给卡片名或路径");
  const dir = tasksDir();
  const direct = path.isAbsolute(ref) ? ref : path.join(dir, ref);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    files = [];
  }
  const hits = files.filter((name) => name.includes(ref));
  if (hits.length === 1) return path.join(dir, hits[0]);
  if (hits.length > 1) throw new Error(`卡片名不唯一，请写全：${hits.join("、")}`);
  throw new Error(
    `找不到卡片「${ref}」（在 ${dir} 里没搜到）。如果这是测试建的一次性验证卡，可能已被删除；验流程请用 flow_verify({dryRun:true})。`,
  );
}

/** 投递正文统一包三重反引号：语音播报会跳过代码块。 */
function deliver(text) {
  return "```\n" + String(text).trim() + "\n```";
}

// ---------- 会话与投递 ----------

function agentOptions(ctx) {
  const model = ctx.get("agentDefaultModel");
  const selection = model && typeof model.currentSelection === "function" ? model.currentSelection() : {};
  const options = {};
  if (selection && selection.provider) options.provider = selection.provider;
  if (selection && selection.model) options.model = selection.model;
  return options;
}

async function resolveAgent(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (!agents) throw new Error("agents 服务不可用");
  const live = agents.get(sessionId);
  if (live) return live;

  const controller = ctx.get("sessionController");
  const api = controller && controller.agents;
  if (api && typeof api.resolveAgent === "function") {
    const found = await api.resolveAgent(sessionId);
    if (found && found.agent) return found.agent;
    throw new Error(`唤醒会话失败：${JSON.stringify(found && found.error)}`);
  }

  const resumed = await agents.resume({
    resumeSessionId: sessionId,
    agentOptions: agentOptions(ctx),
  });
  return resumed.agent;
}

// ---------- 插件主体 ----------

export function apply(ctx) {
  /** sessionId -> { resolve, reject, timer, buffer, sawStart } */
  const waiters = new Map();

  const finish = (sessionId, error) => {
    const waiter = waiters.get(sessionId);
    if (!waiter) return;
    waiters.delete(sessionId);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(waiter.buffer.join("\n\n").trim());
  };

  ctx.on("session/event", (session, event) => {
    try {
      if (!event) return;
      const sessionId = sessionIdOf(session, event);
      if (!sessionId) return;
      const waiter = waiters.get(sessionId);
      if (!waiter) return;

      if (event.type === "turn/start") {
        waiter.sawStart = true;
        return;
      }
      if (event.type === "assistant/message") {
        const data = event.data || {};
        const content = (data.message && data.message.content) || data.content;
        const text = blocksToText(content);
        if (text) waiter.buffer.push(text);
        return;
      }
      if (event.type === "turn/end") {
        // 只有自己这一手开过的回合才算数，避免被上一手的收尾提前唤醒
        if (waiter.sawStart) finish(sessionId, null);
      }
    } catch (error) {
      ctx.logger?.warn?.(`flow: session/event 处理失败：${String(error && error.message)}`);
    }
  });

  /**
   * 投一条消息给对方，等它这一回合演完，返回它说的话。
   * 超时只是「它没在时限内回话」，消息已经送到——调用方不要重发。
   */
  async function say(sessionId, text, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!sessionId) throw new Error("没有可投递的会话 id");
    const agent = await resolveAgent(ctx, sessionId);
    if (waiters.has(sessionId)) throw new Error(`会话 ${sessionId} 正在等待上一手返回`);

    let resolve;
    let reject;
    const reply = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      finish(sessionId, new Error(`等待 ${sessionId} 超时（${timeoutMs}ms），消息已送达，它在忙或没回`));
    }, timeoutMs);
    waiters.set(sessionId, { resolve, reject, timer, buffer: [], sawStart: false });

    try {
      agent.steer(userMessage(textBlocks(deliver(text)), { kind: "user" }));
    } catch (error) {
      // 投递失败：立刻清掉这一手的占位，不留半截状态
      waiters.delete(sessionId);
      clearTimeout(timer);
      throw error;
    }
    return await reply;
  }

  /** 某个角色登记的会话列表。config.roles 支持字符串（单实例）和数组（多实例）。 */
  function roleSessions(role) {
    const raw = config().roles[role];
    if (!raw) throw new Error(`还没登记「${role}」的会话，先 flow_roles set ${role} session-…`);
    const list = (Array.isArray(raw) ? raw : [raw]).map((s) => String(s).trim()).filter(Boolean);
    if (!list.length) throw new Error(`「${role}」登记的是空列表，先 flow_roles set ${role} session-…`);
    return list;
  }

  /** 单实例约定：取第一个。要挑人（找空闲）的地方用 roleSessions。 */
  function roleSession(role) {
    return roleSessions(role)[0];
  }

  /** 在途卡：状态 waiting_verify 且记了 to_session 的卡，按会话归堆。 */
  function busySessions() {
    const dir = tasksDir();
    const busy = new Set();
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
    } catch {
      return busy;
    }
    for (const name of names) {
      try {
        const { head } = parseCard(fs.readFileSync(path.join(dir, name), "utf8"));
        if (head.status === STATUS.waitingVerify && head.to_session) busy.add(head.to_session);
      } catch {
        // 单张卡读坏不影响挑人
      }
    }
    return busy;
  }

  /** 从某角色里挑空闲会话：名下无在途卡；多个空闲时取最久没接活的（轮转）。找不到返回 null。 */
  function pickFree(role) {
    const sessions = roleSessions(role);
    const busy = busySessions();
    const free = sessions.filter((s) => !busy.has(s));
    if (!free.length) return null;
    const last = config().lastAssigned || {};
    const stampOf = (s) => String(last[s] || "");
    free.sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : stampOf(a) > stampOf(b) ? 1 : 0));
    return free[0];
  }

  /** 记一笔「这个会话什么时候接过活」，给轮转挑人用。 */
  function touchAssigned(sessionId) {
    const lastAssigned = { ...(config().lastAssigned || {}), [sessionId]: new Date().toISOString() };
    saveConfig({ lastAssigned });
  }

  // ---------- 1. flow_roles ----------

  ctx.tools.register({
    name: "flow_roles",
    description:
      "登记 / 查看四个角色（统筹、预研、开发、测试）各自的会话 id。action=get 看现状；action=set 登记一个角色，多个实例用逗号分隔一次登记齐（如 session-a…,session-b…）。会话 id 要用完整 id 带 session- 前缀。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["get", "set"] },
        role: { type: "string", enum: ROLES },
        sessionId: {
          type: "string",
          description: "完整会话 id，如 session-abcdefgh-…；多实例用逗号分隔",
        },
      },
      required: ["action"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (args.action === "get") {
        const roles = config().roles;
        const lines = ROLES.map((role) => {
          const raw = roles[role];
          if (!raw || (Array.isArray(raw) && !raw.length)) return `${role}：（未登记）`;
          const list = Array.isArray(raw) ? raw : [raw];
          if (list.length === 1) return `${role}：${list[0]}`;
          return `${role}（${list.length} 个，按登记顺序挑人）：${list.join("、")}`;
        });
        return { roles, text: lines.join("\n") };
      }
      if (!ROLES.includes(args.role)) throw new Error(`role 只能是：${ROLES.join(" / ")}`);
      if (!args.sessionId) throw new Error("set 需要 sessionId");
      // 逗号 / 顿号 / 空白分隔多个会话 id，多实例角色一次登记齐
      const ids = String(args.sessionId)
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = ids.filter((id) => !id.startsWith("session-"));
      if (bad.length) {
        throw new Error(`sessionId 要带 session- 前缀，只传 uuid 会报 session/not-found：${bad.join("、")}`);
      }
      // 单个存字符串（向后兼容 0.1.x 的配置），多个存数组
      const value = ids.length === 1 ? ids[0] : ids;
      const roles = { ...config().roles, [args.role]: value };
      saveConfig({ roles });
      return {
        roles,
        text: `已登记 ${args.role} → ${ids.join("、")}（${ids.length} 个实例）`,
      };
    },
  });

  // ---------- 2. flow_start ----------

  ctx.tools.register({
    name: "flow_start",
    description:
      "建一张任务卡：写 YAML 头（from/to/type/ticket/status/created），status=pending，然后投给统筹。卡落在【文档区】\\计划与任务\\，文件名 任务卡_<主题>_<梗概>_<单号>_<YYYYMMDD>.md。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "任务主题，如「视频录制插件」" },
        summary: { type: "string", description: "梗概，≤12 字，可不填" },
        from: { type: "string", description: "发起角色，一般写「预研」" },
        to: { type: "string", description: "交给谁，默认「统筹」", default: "统筹" },
        ticket: { type: "string", description: "单号，可不填" },
        requirement: { type: "string", description: "要求正文（会写进卡的「## 要求」）" },
        criteria: { type: "string", description: "验收标准（会写进卡的「## 验收标准」）" },
        timeoutMs: { type: "integer", description: "投递给统筹的等待上限，默认 180000" },
      },
      required: ["title"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const cfg = config();
      const to = args.to || "统筹";
      const from = args.from || "预研";
      const ticket = args.ticket || "NA";
      const title = sanitize(args.title, "未命名");
      const summary = sanitize(args.summary || "", "NA");
      const now = new Date();
      const fileName = `任务卡_${title}_${summary}_${sanitize(ticket, "NA")}_${ymd(now)}.md`;

      const dir = tasksDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, fileName);
      if (fs.existsSync(file)) throw new Error(`卡片已存在：${file}`);

      const head = {
        from,
        to,
        type: "任务卡",
        ticket,
        status: "pending",
        created: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
      };
      const body = [
        `# 任务卡 · ${title}`,
        "",
        `**交给：${to}** ｜ 出单：${from} ｜ ${stamp(now)}`,
        "",
        "## 要求",
        "",
        args.requirement ? String(args.requirement) : "（待补）",
        "",
        "## 验收标准",
        "",
        args.criteria ? String(args.criteria) : "（待补）",
        "",
        "## 回执",
        "",
        "（执行方填写）",
        "",
      ].join("\n");
      fs.writeFileSync(file, renderHead(head) + "\n" + body, "utf8");

      const target = roleSession(to);
      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          target,
          `【${from}】新任务卡：${fileName}。请拆解并派单，看卡。`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        // 卡已经落地，投递失败照样把卡交出去——只是没叫醒人
        reply = String(error && error.message);
      }
      return { file, fileName, status: "pending", to, delivered, reply };
    },
  });

  // ---------- 3. flow_dispatch ----------

  ctx.tools.register({
    name: "flow_dispatch",
    description:
      "统筹派单：把卡派给开发或测试，卡状态改 processing 并记一笔派单，然后投给目标角色。卡已经 processing 时再派给另一个人也会记。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径（在途卡）" },
        to: { type: "string", enum: ["开发", "测试"], description: "派给谁（角色名，尽量配合 toSession 使用）" },
        toSession: { type: "string", description: "目标会话完整 id（session- 前缀）；传了它就用它，不再按角色名找" },
        downstream: {
          type: "string",
          description: "下游角色：本卡交出去后由谁接。不填就按 to 推导（开发→测试、测试→统筹）",
        },
        note: { type: "string", description: "派单附言" },
        timeoutMs: { type: "integer", description: "等待上限，默认 180000" },
      },
      required: ["card"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const file = resolveCard(args.card);
      let text = fs.readFileSync(file, "utf8");
      const { head, hasHead } = parseCard(text);
      if (!hasHead) throw new Error("这张卡没有 YAML 头");
      if (head.status === STATUS.done) throw new Error("这张卡已经 done，别再派单");

      const role = args.to || (args.toSession ? "（按 id 指定）" : undefined);
      if (!role && !args.toSession) throw new Error("要派给谁：to（角色名）和 toSession（会话 id）至少给一个");
      const target = args.toSession || roleSession(role);
      if (String(target).split("-")[0] !== "session") throw new Error("toSession 要用完整 id（session- 前缀）：" + target);

      // 卡头记持有人：派给谁就写谁。不写这一笔的后果是 flow_submit 的「提交人」取到
      // 建卡人（统筹），flow_reject 再从提交人里找原开发，驳回就投给统筹——2026-10-26
      // 13:26 那张卡被当成别人的，源头就是这里
      // 写卡走 commitCard：改之前先重读，别把别人这期间追加的段整段覆盖掉（0.3.5）
      const downstream = String(args.downstream || "").trim() || downstreamOf(role);
      text = commitCard(file, (latest) => {
        let t = upsertHead(latest, "to_session", target);
        if (head.status !== "processing") t = setStatus(t, "processing");
        // 下游标记：卡头 downstream 写清这一环之后谁接，flow_submit 按它找空闲下游
        if (downstream) t = upsertHead(t, "downstream", downstream);
        // 派单行也带上会话 id：卡头一处、正文一处，事后翻卡能看出这一单落到了谁手上
        return t.trimEnd() + `\n\n> 派单 → ${role} ${target}（${stamp()}）${args.note ? "：" + safeLine(args.note) : ""}\n`;
      });
      logDispatch(target, path.basename(file), "已派单", `派给 ${role}${args.note ? "：" + safeLine(args.note) : ""}`);

      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          target,
          `【统筹】派单：${path.basename(file)}，请认领（目标会话：${target}）。`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        reply = String(error && error.message);
      }
      return { file: path.basename(file), to: role, status: "processing", delivered, reply };
    },
  });

  // ---------- 4. flow_submit ----------

  ctx.tools.register({
    name: "flow_submit",
    description:
      "开发交卡：卡从 processing 改成 waiting_verify，追加「## 交付记录」，自动挑一个空闲测试投过去。没有空闲测试时卡停在 waiting_verify 并报「排队」。卡在 blocked 时不能交，先用 flow_answer 放行。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
        note: { type: "string", description: "交付备注，会写进卡里" },
        session: {
          type: "string",
          description: "交卡人的会话 id，可不填（默认取卡头 to_session；手工建的卡没有它，填这里就能在登记单里记上是谁交的）",
        },
        timeoutMs: { type: "integer", description: "投递等待上限，默认 180000" },
      },
      required: ["card"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const file = resolveCard(args.card);
      let text = fs.readFileSync(file, "utf8");
      const { head } = parseCard(text);
      if (head.status === STATUS.done) throw new Error("这张卡已经 done 了，别再交");
      if (head.status === STATUS.blocked) {
        throw new Error("这张卡在 blocked（等统筹答复疑问），先等 flow_answer 放行再交");
      }
      if (head.status !== STATUS.processing) {
        throw new Error(`只有 processing 的卡能交，当前是 ${head.status || "（无状态）"}`);
      }

      const tester = pickFree("测试");
      // 交卡人是调用方（args.session），卡头 to_session 只是兜底——手工建的卡没有它
      // 兜底不能把统筹算成交卡人：卡头在建卡时常写统筹，那不是「谁交的活」
      const coordinatorIds = new Set(roleSessions("统筹"));
      const submitterRaw = args.session || head.to_session || "";
      const submitterIsCoordinator = Boolean(submitterRaw) && coordinatorIds.has(submitterRaw);
      const submitter = submitterIsCoordinator ? "（未登记）" : submitterRaw || "（未登记）";

      // 交付记录整段只拼一次，两处都要写；时间戳只取一次，自检也认这一份
      const at = stamp();
      const deliverySection = [
        `## 交付记录（${at}）`,
        "",
        `- 提交人：${submitter}`,
        ...(submitterIsCoordinator
          ? [`- 提交人判定：${submitterRaw} 是统筹登记 id，不作交卡人，记（未登记）`]
          : []),
        `- 备注：${safeLine(args.note) || "（无）"}`,
      ].join("\n");

      if (!tester) {
        text = commitCard(file, (latest) => setStatus(appendSection(latest, deliverySection), STATUS.waitingVerify));
        assertDeliveredRecord(text, at);
        logDispatch(submitter, path.basename(file), "已交卡（排队）", args.note || "没有空闲测试，等统筹手动派");
        return {
          file: path.basename(file),
          status: STATUS.waitingVerify,
          queued: true,
          delivered: false,
          reply: "没有空闲测试（登记的测试手里都有在途卡），卡已排队，等统筹手动派",
        };
      }

      // 先投递，再按投递结果写卡头、记账——先记账后投递就是「假派活」
      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          tester,
          `【开发】交卡：${path.basename(file)}，请独立验收。${args.note ? "备注：" + String(args.note) : ""}`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        reply = String(error && error.message);
      }

      // 三档同 flow_verify：送到 / 超时（不确定）/ 明确失败；超时按「当它送到了」处理
      const notFound = /not-found|not\s*found|不存在/i.test(reply);
      const outcome = delivered ? "delivered" : notFound ? "failed" : "timeout";
      const settled = outcome !== "failed";
      // 送到或超时都算落到了人手上；明确失败才保持原持有人
      const holder = settled ? tester : head.to_session || "";
      // 套在最新内容上写：投递等的那几十秒里，卡可能已经被人动过
      text = commitCard(file, (latest) => {
        let t = appendSection(latest, deliverySection);
        t = setStatus(t, STATUS.waitingVerify);
        return holder ? upsertHead(t, "to_session", holder) : t;
      });
      assertDeliveredRecord(text, at);

      if (settled) {
        touchAssigned(tester);
        logDispatch(
          submitter,
          path.basename(file),
          outcome === "delivered" ? "已交卡" : "已交卡（投递超时，未确认）",
          safeLine(args.note) || "（无备注）",
        );
      } else {
        logDispatch(
          submitter,
          path.basename(file),
          "投递失败（未送达）",
          `本来要交给 ${tester}，没送到：${reply}`,
        );
      }

      return {
        file: path.basename(file),
        status: STATUS.waitingVerify,
        queued: false,
        to: tester,
        to_session: holder || "（空）",
        delivered,
        outcome,
        reply,
      };
    },
  });

  // ---------- 5. flow_ask ----------

  ctx.tools.register({
    name: "flow_ask",
    description:
      "开发遇需求对不上、不确定时不许猜：把疑问写进卡并投给统筹决策。卡 processing → blocked，追加「## 疑问」段。统筹用 flow_answer 放行。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
        question: { type: "string", description: "要问的疑问，写清哪里对不上" },
        timeoutMs: { type: "integer", description: "投递等待上限，默认 180000" },
      },
      required: ["card", "question"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const file = resolveCard(args.card);
      let text = fs.readFileSync(file, "utf8");
      const { head } = parseCard(text);
      if (head.status === STATUS.done) throw new Error("这张卡已经 done 了");
      if (head.status === STATUS.blocked) throw new Error("这张卡已经在 blocked 了，等统筹答复即可");

      const coordinator = roleSession("统筹");
      // 写卡走 commitCard（0.3.5）：疑问段是开发↔统筹之间唯一的留据口子，被别人一次整段覆盖就没了
      const at = stamp();
      text = commitCard(file, (latest) => {
        const t = appendSection(setStatus(latest, STATUS.blocked), `## 疑问（${at}）\n\n${safeBlock(args.question)}`);
        return upsertHead(t, "to_session", coordinator);
      });

      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          coordinator,
          `【开发】${path.basename(file)} 遇到疑问，卡已 blocked，请决策（用 flow_answer）。疑问：${safeLine(args.question)}`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        reply = String(error && error.message);
      }
      return { file: path.basename(file), status: STATUS.blocked, to: coordinator, delivered, reply };
    },
  });

  // ---------- 6. flow_answer ----------

  ctx.tools.register({
    name: "flow_answer",
    description:
      "统筹答复开发的疑问：卡 blocked → processing，追加「## 决策」段，投回原开发。决策留在卡里，供复跑与归档追溯。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
        answer: { type: "string", description: "决策内容" },
        toSession: { type: "string", description: "投给谁，默认投回卡上登记的开发" },
        timeoutMs: { type: "integer", description: "投递等待上限，默认 180000" },
      },
      required: ["card", "answer"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const file = resolveCard(args.card);
      let text = fs.readFileSync(file, "utf8");
      const { head } = parseCard(text);
      if (head.status !== STATUS.blocked) {
        throw new Error(`只有 blocked 的卡能答复，当前是 ${head.status || "（无状态）"}`);
      }

      const target = args.toSession || roleSession("开发");
      // 写卡走 commitCard（0.3.5）：决策段同理，丢了开发看不到答复，卡就卡在 blocked 那条时间线上
      const at = stamp();
      text = commitCard(file, (latest) => {
        const t = appendSection(setStatus(latest, STATUS.processing), `## 决策（${at}）\n\n${safeBlock(args.answer)}`);
        return upsertHead(t, "to_session", target);
      });

      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          target,
          `【统筹】${path.basename(file)} 疑问已答复，卡回 processing，请继续。决策：${safeLine(args.answer)}`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        reply = String(error && error.message);
      }
      return { file: path.basename(file), status: STATUS.processing, to: target, delivered, reply };
    },
  });

  // ---------- 7. flow_verify ----------

  ctx.tools.register({
    name: "flow_verify",
    description:
      "测试回执：把验收结论（通过 / 不通过 + 报告路径）追加到卡里，并按结论自动分流——通过：卡进 waiting_final 并投统筹终审；不通过：卡回 processing 并投空闲开发返工。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
        pass: { type: "boolean", description: "是否通过，默认 true" },
        report: { type: "string", description: "测试报告路径，可不填" },
        note: { type: "string", description: "结论备注" },
        dryRun: {
          type: "boolean",
          description: "只算不改：不改卡、不投递、不写登记单、不占分配时间。给测试验流程用，返回 wouldBeStatus / wouldDeliverTo / rejectsLeft",
        },
        timeoutMs: { type: "integer" },
      },
      required: ["card"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const file = resolveCard(args.card);
      let text = fs.readFileSync(file, "utf8");
      const { head } = parseCard(text);
      const pass = args.pass !== false;
      const dryRun = args.dryRun === true;
      if (head.status === STATUS.done) throw new Error("这张卡已经 done 了");
      if (head.status === STATUS.waitingHuman) {
        throw new Error("这张卡已连退超限转人工裁定，等统筹用 flow_dispatch 放行后才能再验");
      }
      if (head.status !== STATUS.waitingVerify && head.status !== STATUS.processing) {
        throw new Error(`只有 waiting_verify（或老的 processing）的卡能验，当前是 ${head.status || "（无状态）"}`);
      }

      // 同一张卡最多自动退回 MAX_REJECTS 次；本次判不通过是第几次
      const rejects = rejectCount(text);
      const round = pass ? 0 : rejects + 1;
      const tooMany = !pass && round > MAX_REJECTS;

      // 分岔：通过 → 等统筹终审；不通过 → 回开发返工；连退超限 → 转人工裁定
      let next;
      let target;
      if (pass) {
        next = STATUS.waitingFinal;
        target = roleSession("统筹");
      } else if (tooMany) {
        next = STATUS.waitingHuman;
        target = roleSession("统筹");
      } else {
        next = STATUS.processing;
        target = pickFree("开发") || roleSession("开发");
      }

      // dryRun：只算不改。不写卡、不投递、不记账、不占分配时间，lastAssigned 一个字都不动
      if (dryRun) {
        return {
          dryRun: true,
          file: path.basename(file),
          pass,
          round,
          tooMany,
          wouldBeStatus: next,
          wouldDeliverTo: target,
          rejectsLeft: Math.max(0, MAX_REJECTS - rejects),
          currentStatus: head.status || "（无状态）",
          holder: head.to_session || "（卡头没记持有人）",
        };
      }

      // 空行写死在数组里、不过 filter——filter 会把段内换行一起删掉，段就粘成一坨
      const section = [
        `## 验收（${stamp()}）`,
        "",
        `- 结论：${pass ? "通过" : "不通过"}`,
        `- 报告：${safeLine(args.report) || "（无）"}`,
        ...(args.note ? [`- 备注：${safeLine(args.note)}`] : []),
        ...(tooMany ? [`- 处置：已连退 ${round} 次，转人工裁定（不自动回开发）`] : []),
      ].join("\n");

      // 先投递，再按投递结果记账——先记账后投递就是「假派活」
      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          target,
          pass
            ? `【测试】${path.basename(file)} 验收通过，卡进 waiting_final，请终审后归档。报告：${args.report || "见卡"}`
            : tooMany
              ? `【测试】${path.basename(file)} 已连退 ${round} 次仍未通过，按规则转人工裁定，不再自动回开发。最后一次报告：${args.report || "见卡"}`
              : `【测试】${path.basename(file)} 验收不通过（第 ${round} 次），请重做。报告：${args.report || "见卡"}`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        reply = String(error && error.message);
      }

      // 超时 ≠ 没送到：theater_say 超时的消息通常已经送达，只是对方没在 timeoutMs 内回。
      // 所以分三档——送到 / 超时（不确定）/ 明确失败；超时按「当它送到了」处理
      // （漏记分配时间的伤害比多记一次大，指挥中心 2026-10-25 裁定）。
      const notFound = /not-found|not\s*found|不存在/i.test(reply);
      const outcome = delivered ? "delivered" : notFound ? "failed" : "timeout";
      const settled = outcome !== "failed";
      // 卡头上写谁：送到或超时都算落到了人手上；明确失败才回滚，别留指向死会话的指针
      const holder = settled ? target : head.to_session || "";
      // 写卡：套在最新内容上（投递等的那几十秒里可能有人追加了段），别覆盖别人的
      text = commitCard(file, (latest) => {
        let t = appendSection(latest, section);
        t = setStatus(t, next);
        if (holder) t = upsertHead(t, "to_session", holder);
        return t;
      });

      const label = pass
        ? "验收通过"
        : tooMany
          ? `验收不通过（第 ${round} 次，转人工）`
          : `验收不通过（第 ${round} 次）`;
      if (settled) {
        if (!pass && !tooMany) touchAssigned(target);
        logDispatch(
          head.to_session,
          path.basename(file),
          outcome === "delivered" ? label : `${label}（投递超时，未确认）`,
          args.note || args.report || "",
        );
      } else {
        // 明确失败（会话不存在这类）才不占分配时间、不记成「已打回」
        logDispatch(
          head.to_session,
          path.basename(file),
          "投递失败（未送达）",
          `本来要${label}给 ${target}，没送到：${reply}`,
        );
      }

      return {
        file: path.basename(file),
        pass,
        status: next,
        to: target,
        to_session: holder || "（空）",
        round,
        tooMany,
        delivered,
        outcome,
        reply,
      };
    },
  });

  // ---------- 4.5 flow_reject（统筹终审驳回） ----------

  ctx.tools.register({
    name: "flow_reject",
    description:
      "统筹终审驳回：只有 waiting_final 的卡能驳，退回 processing 投原开发，卡上追加「## 终审驳回」段。两类各 2 轮且账合并（测试退回计入同类型），同类型满 2 轮后第 3 次报错。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
        reason: { type: "string", description: "驳回理由，不许空——空理由的驳回，事后追责追不出来" },
        type: {
          type: "string",
          enum: ["实现缺陷", "执行书缺陷"],
          description: "驳回类型，计入模板 §8 那两类各 2 轮的账；不填算实现缺陷",
        },
        timeoutMs: { type: "integer" },
      },
      required: ["card", "reason"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      // 1. 取调用者：只有统筹能驳（需求点 1）
      const caller = exec && exec.agent && exec.agent.session && exec.agent.session.id;
      if (!caller) throw new Error("拿不到调用者会话 id，无法确认是统筹。这个工具只给统筹用。");
      const sessions = roleSessions("统筹");
      if (!sessions.includes(caller)) {
        throw new Error(`只有统筹能驳回，当前调用者是 ${caller}。统筹登记的是：${sessions.join("、")}`);
      }

      // 2. 读卡
      const file = resolveCard(args.card);
      let text = fs.readFileSync(file, "utf8");
      const { head } = parseCard(text);

      // 3. 理由不许空（required 挡不住空字符串）；自由文本先单行化，防结构注入
      const reason = safeLine(args.reason);
      if (!reason) throw new Error("驳回理由不许空——空理由的驳回，事后追责追不出来");

      // 4. 入口状态：只认 waiting_final，且必须在任何写文件之前（需求点 2）
      if (head.status !== STATUS.waitingFinal) {
        throw new Error(`只有 waiting_final 的卡能驳回，当前是 ${head.status || "（无状态）"}`);
      }

      // 5. 算轮次：按类型、合并账（需求点 5 + 统筹 2026-10-26 裁定）
      const counts = reworkCounts(text);
      const rejectType = args.type === "执行书缺陷" ? "执行书缺陷" : args.type === "实现缺陷" ? "实现缺陷" : "（未指定）"; // 卡上如实记；记账时「未指定」进 impl
      const used = rejectType === "执行书缺陷" ? counts.spec : counts.impl;
      const round = used + 1;
      if (round > MAX_REJECTS) {
        throw new Error(
          `这张卡「${rejectType}」类已退回 ${used} 轮，到上限 ${MAX_REJECTS} 轮，第 ${round} 次不再自动驳回。问题不在这一轮，请人工裁定。`,
        );
      }
      // 返回的账是「驳完之后的账」，跟 round 对齐（统筹 2026-10-26 14:15 裁定缺陷 3）
      const countsAfter = {
        impl: counts.impl + (rejectType === "执行书缺陷" ? 0 : 1),
        spec: counts.spec + (rejectType === "执行书缺陷" ? 1 : 0),
      };

      // 6. 找原开发：从最后几段「## 交付记录」的提交人里取；统筹登记 id 一律作废
      const devInfo = originalDeveloperInfo(text, new Set(roleSessions("统筹")));
      const dev = devInfo.dev;
      const target = dev || pickFree("开发") || roleSession("开发");
      if (devInfo.skipped.length) {
        // 报出来，别静默：卡上有过「提交人=统筹」，说明上游兜底又漏了一次
        console.error(
          `flow: 卡 ${path.basename(file)} 的交付记录里出现过统筹作提交人（${devInfo.skipped.join("、")}），已作废，改投 ${
            dev || "空闲开发"
          }`,
        );
      }

      // 7. 先投递，再写卡——顺序反了就是假派活
      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          target,
          `【统筹】终审驳回：${path.basename(file)} 复核没过（${rejectType}类第 ${round} 次），请重做。理由：${reason}`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        reply = String(error && error.message);
      }
      // 超时 ≠ 没送到（0.2.7 口径）：超时当送达，明确失败才不动卡
      const notFound = /not-found|not\s*found|不存在/i.test(reply);
      const outcome = delivered ? "delivered" : notFound ? "failed" : "timeout";
      if (outcome === "failed") throw new Error(`投递失败（未送达），卡一个字都没动：${reply}`);

      // 8. 写卡 + 记账（空行写死在数组里，段间补两个换行防粘连）
      const section = [
        `## 终审驳回（${stamp()}）`,
        "",
        `- 理由：${reason}`,
        `- 驳回人：${caller}`,
        `- 类型：${rejectType}`,
        `- 轮次：${rejectType}类第 ${round} 轮（上限 ${MAX_REJECTS} 轮；测试退回与驳回同一本账）`,
      ].join("\n");
      text = commitCard(file, (latest) => {
        let t = appendSection(latest, section);
        t = setStatus(t, STATUS.processing);
        return upsertHead(t, "to_session", target);
      });

      touchAssigned(target);
      logDispatch(
        caller,
        path.basename(file),
        outcome === "delivered" ? "已驳回" : "已驳回（投递超时，未确认）",
        reason,
      );

      return {
        file: path.basename(file),
        status: STATUS.processing,
        to: target,
        isOriginalDeveloper: Boolean(dev),
        // 交付记录里出现过统筹作提交人（上游兜底漏过）：作废了，投的是 dev 或空闲开发
        ignoredCoordinatorSubmitters: devInfo.skipped,
        round,
        rejectsLeft: Math.max(0, MAX_REJECTS - round),
        type: rejectType,
        counts: countsAfter,
        rejected: rejectFinalCount(text),
        reason,
        delivered,
        outcome,
        reply,
      };
    },
  });

  // ---------- 5. flow_close ----------

  ctx.tools.register({
    name: "flow_close",
    description:
      "归档：把卡状态改成 done，移到【归档区】\\<类型>\\<YYYY-MM>\\，移动前后核对 SHA-256。已经 done 的卡会报错。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
      },
      required: ["card"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const file = resolveCard(args.card);
      let text = fs.readFileSync(file, "utf8");
      const { head } = parseCard(text);
      if (head.status === STATUS.done) throw new Error(`这张卡已经是 done 了：${path.basename(file)}`);
      if (head.status !== STATUS.waitingFinal) {
        throw new Error(
          `只有 waiting_final 的卡能归档，当前是 ${head.status || "（无状态）"}；要等测试 flow_verify 通过推进到这一步`,
        );
      }
      if (lastVerdict(text) !== "通过") throw new Error("卡里没有「通过」的验收结论，不能归档");

      // 写卡走 commitCard（0.3.5）：改状态这一笔也可能踩掉别人刚追加的段
      text = commitCard(file, (latest) => setStatus(latest, STATUS.done));

      const type = sanitize(head.type || "任务卡", "任务卡");
      const destDir = path.join(archiveDir(), type, yyyymm());
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, path.basename(file));
      if (fs.existsSync(dest)) throw new Error(`归档目标已存在，不覆盖：${dest}`);

      const before = sha256(file);
      fs.renameSync(file, dest);
      const after = sha256(dest);
      if (before !== after) {
        throw new Error(`SHA 不一致（${before} ≠ ${after}），文件已移到 ${dest}，请人工核对`);
      }
      logDispatch(head.to_session, path.basename(file), "已归档", dest);
      return { file: path.basename(file), archivedTo: dest, status: "done", sha256: after };
    },
  });

  // ---------- 6. flow_run ----------

  ctx.tools.register({
    name: "flow_run",
    description:
      "一键推进：读一张卡按状态自动走下一步——pending 派给开发、processing 没验收就请测试验、有验收就关闭归档、done 就结束。中途失败停下报原因，返回走过的步骤。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
        maxSteps: { type: "integer", description: "最多推进几步，默认 4" },
        timeoutMs: { type: "integer", description: "每步投递的等待上限，默认 180000" },
      },
      required: ["card"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const maxSteps = Math.max(1, Math.min(8, Number(args.maxSteps) || 4));
      const timeoutMs = Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const steps = [];
      let stopped = "";

      for (let i = 0; i < maxSteps; i += 1) {
        const file = resolveCard(args.card);
        let text = fs.readFileSync(file, "utf8");
        const { head } = parseCard(text);
        const name = path.basename(file);

        if (head.status === STATUS.done) {
          steps.push({ step: "done", file: name });
          return { steps, stopped, card: args.card };
        }

        if (head.status === STATUS.blocked) {
          steps.push({ step: "blocked", file: name, hint: "等统筹 flow_answer 答复疑问" });
          return { steps, stopped, card: args.card };
        }

        if (head.status === STATUS.waitingVerify) {
          steps.push({ step: "wait-verify", file: name, hint: "测试在验（或排队中），等 flow_verify" });
          return { steps, stopped, card: args.card };
        }

        if (head.status === STATUS.waitingHuman) {
          steps.push({
            step: "wait-human",
            file: name,
            hint: "已连退超限转人工裁定，等统筹 flow_dispatch 放行（派单即转回 processing）",
          });
          return { steps, stopped, card: args.card };
        }

        if (head.status === STATUS.waitingFinal) {
          try {
            const out = await runClose(file);
            steps.push({ step: "close", file: name, archivedTo: out.archivedTo, sha256: out.sha256 });
          } catch (error) {
            stopped = `归档失败：${String(error && error.message)}`;
          }
          return { steps, stopped, card: args.card };
        }

        if (head.status === STATUS.pending) {
          try {
            const out = await runDispatch(file, "开发", "", timeoutMs);
            steps.push({ step: "dispatch", file: name, to: "开发", delivered: out.delivered, reply: out.reply });
            if (!out.delivered) stopped = `派单给开发没送到：${out.reply}`;
          } catch (error) {
            stopped = `派单失败：${String(error && error.message)}`;
          }
          if (stopped) break;
          continue;
        }

        // processing：只认最后一段验收的结论（不通过后开发重做，卡里会留两段验收）
        const verdict = lastVerdict(text);
        if (verdict === "通过") {
          // 老流程兼容：processing 但有通过结论，补成 waiting_final 再归档
          // 写卡走 commitCard（0.3.5）：同一把刀补到这第七处（grep 查不出的同形写法）
          text = commitCard(file, (latest) => setStatus(latest, STATUS.waitingFinal));
          steps.push({ step: "to-final", file: name, hint: "老卡补 waiting_final，下一步归档" });
          continue;
        }
        if (verdict === "不通过") {
          steps.push({ step: "rework", file: name, hint: "验收不通过，等开发重做后再验" });
          break;
        }

        // 还没验：请测试验
        try {
          const out = await runDispatch(file, "测试", "请独立验收", timeoutMs);
          steps.push({ step: "verify-request", file: name, to: "测试", delivered: out.delivered, reply: out.reply });
          if (!out.delivered) stopped = `请测试验收没送到：${out.reply}`;
        } catch (error) {
          stopped = `请测试验收失败：${String(error && error.message)}`;
        }
        if (stopped) break;
        steps.push({ step: "wait-verify", file: name, hint: "等测试调 flow_verify 写结论" });
        break;
      }

      return { steps, stopped, card: args.card };
    },
  });

  // ---------- 10. flow_status ----------

  ctx.tools.register({
    name: "flow_status",
    description:
      "读全局会话状态表（~/.dsh/会话状态.md），汇总「活跃 N / 待机 M」并列出明细。用来一眼看谁在活动、决定能不能重启宿主。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        only: {
          type: "string",
          enum: ["active", "idle"],
          description: "只看活跃或只看待机，不填全看",
        },
      },
      required: [],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const rows = readSessionStatus();
      if (!rows.length) {
        return {
          active: 0,
          idle: 0,
          rows: [],
          text: `没读到会话状态表，或表里没有登记行：${SESSION_STATUS_TABLE}`,
        };
      }
      const isActive = (r) => r.state.includes("活跃");
      const isIdle = (r) => r.state.includes("待机");
      const active = rows.filter(isActive);
      const idle = rows.filter(isIdle);
      let list = [...active, ...idle];
      if (args.only === "active") list = active;
      else if (args.only === "idle") list = idle;

      const lines = [
        `活跃 ${active.length} / 待机 ${idle.length}（共登记 ${rows.length} 条）`,
        "",
        ...list.map((r) => {
          const mark = isActive(r) ? "活跃" : isIdle(r) ? "待机" : r.state || "（未填）";
          return `- ${mark}  ${r.id.slice(8, 16)}  ${r.role}  ${r.updated}`;
        }),
      ];
      return {
        active: active.length,
        idle: idle.length,
        rows: list,
        text: lines.join("\n"),
      };
    },
  });

  /** flow_run 用的派单（不重复注册工具逻辑）。 */
  async function runDispatch(file, role, note, timeoutMs) {
    let text = fs.readFileSync(file, "utf8");
    const { head } = parseCard(text);
    if (head.status === STATUS.done) throw new Error("这张卡已经 done，别再派单");
    const target = roleSession(role);
    const downstream = downstreamOf(role);
    // 写卡走 commitCard（0.3.5）：与独立工具 flow_dispatch 共用同一套写法，别只改一边
    text = commitCard(file, (latest) => {
      let t = head.status !== STATUS.processing ? setStatus(latest, STATUS.processing) : latest;
      t = upsertHead(t, "to_session", target);
      if (downstream) t = upsertHead(t, "downstream", downstream);
      // 派单行也带上会话 id：与独立工具 flow_dispatch（826 行）对齐——0.3.1 的验收标准是
      // 「派单记录里保留派给谁的痕迹，不能只有卡头一处」，runDispatch 这条新路径原来漏了（1 号真宿主挖出）
      return t.trimEnd() + `\n\n> 派单 → ${role} ${target}（${stamp()}）${note ? "：" + note : ""}\n`;
    });
    logDispatch(target, path.basename(file), "已派单", `派给 ${role}${note ? "：" + note : ""}`);
    let reply = "";
    let delivered = false;
    try {
      reply = await say(target, `【统筹】派单：${path.basename(file)}，请认领。`, timeoutMs);
      delivered = true;
    } catch (error) {
      reply = String(error && error.message);
    }
    return { delivered, reply };
  }

  /** flow_run 用的关闭归档。 */
  async function runClose(file) {
    let text = fs.readFileSync(file, "utf8");
    const { head } = parseCard(text);
    if (head.status === STATUS.done) throw new Error("这张卡已经 done 了");
    if (head.status !== STATUS.waitingFinal) {
      throw new Error(`只有 waiting_final 的卡能归档，当前是 ${head.status || "（无状态）"}`);
    }
    if (lastVerdict(text) !== "通过") throw new Error("卡里没有「通过」的验收结论，不能归档");
    // 写卡走 commitCard（0.3.5）：与独立工具 flow_close 共用同一套写法
    text = commitCard(file, (latest) => setStatus(latest, STATUS.done));

    const type = sanitize(head.type || "任务卡", "任务卡");
    const destDir = path.join(archiveDir(), type, yyyymm());
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(file));
    if (fs.existsSync(dest)) throw new Error(`归档目标已存在，不覆盖：${dest}`);

    const before = sha256(file);
    fs.renameSync(file, dest);
    const after = sha256(dest);
    if (before !== after) throw new Error(`SHA 不一致（${before} ≠ ${after}），文件已移到 ${dest}`);
    logDispatch(head.to_session, path.basename(file), "已归档", dest);
    return { archivedTo: dest, sha256: after };
  }
}

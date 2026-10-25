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
const DEFAULT_TIMEOUT_MS = 180000;
const ROLES = ["统筹", "预研", "开发", "测试"];

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

const HEAD_ORDER = ["from", "to", "type", "ticket", "status", "created"];

function renderHead(head) {
  const lines = ["---"];
  for (const key of HEAD_ORDER) {
    if (head[key] !== undefined && head[key] !== "") lines.push(`${key}: ${head[key]}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/** 只改 YAML 头里的 status（正文里的同名字符串不动）。 */
function setStatus(text, status) {
  const { hasHead } = parseCard(text);
  if (!hasHead) throw new Error("这张卡没有 YAML 头，不敢改状态");
  return text.replace(/^(status:\s*).*$/m, `$1${status}`);
}

/** 这张卡最后一段验收的结论：「通过」「不通过」，或空（还没验过）。 */
function lastVerdict(text) {
  const idx = text.lastIndexOf("## 验收");
  if (idx < 0) return "";
  const m = /结论：(\S+)/.exec(text.slice(idx));
  return m ? m[1] : "";
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
  throw new Error(`找不到卡片「${ref}」（在 ${dir} 里没搜到）`);
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

  function roleSession(role) {
    const target = config().roles[role];
    if (!target) throw new Error(`还没登记「${role}」的会话，先 flow_roles set ${role} session-…`);
    return String(target);
  }

  // ---------- 1. flow_roles ----------

  ctx.tools.register({
    name: "flow_roles",
    description:
      "登记 / 查看四个角色（统筹、预研、开发、测试）各自的会话 id。action=get 看现状；action=set 登记一个角色。会话 id 要用完整 id 带 session- 前缀。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["get", "set"] },
        role: { type: "string", enum: ROLES },
        sessionId: { type: "string", description: "完整会话 id，如 session-abcdefgh-…" },
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
        const lines = ROLES.map((role) => `${role}：${roles[role] || "（未登记）"}`);
        return { roles, text: lines.join("\n") };
      }
      if (!ROLES.includes(args.role)) throw new Error(`role 只能是：${ROLES.join(" / ")}`);
      if (!args.sessionId) throw new Error("set 需要 sessionId");
      if (!String(args.sessionId).startsWith("session-")) {
        throw new Error("sessionId 要带 session- 前缀，只传 uuid 会报 session/not-found");
      }
      const roles = { ...config().roles, [args.role]: String(args.sessionId) };
      saveConfig({ roles });
      return { roles, text: `已登记 ${args.role} → ${args.sessionId}` };
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
        to: { type: "string", enum: ["开发", "测试"], description: "派给谁" },
        note: { type: "string", description: "派单附言" },
        timeoutMs: { type: "integer", description: "等待上限，默认 180000" },
      },
      required: ["card", "to"],
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
      if (head.status === "done") throw new Error("这张卡已经 done，别再派单");

      const role = args.to;
      const target = roleSession(role);

      if (head.status !== "processing") text = setStatus(text, "processing");
      text = text.trimEnd() + `\n\n> 派单 → ${role}（${stamp()}）${args.note ? "：" + String(args.note) : ""}\n`;
      fs.writeFileSync(file, text, "utf8");

      let reply = "";
      let delivered = false;
      try {
        reply = await say(
          target,
          `【统筹】派单：${path.basename(file)}，请认领。`,
          Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
        );
        delivered = true;
      } catch (error) {
        reply = String(error && error.message);
      }
      return { file: path.basename(file), to: role, status: "processing", delivered, reply };
    },
  });

  // ---------- 4. flow_verify ----------

  ctx.tools.register({
    name: "flow_verify",
    description:
      "测试回执：把验收结论（通过 / 不通过 + 报告路径）追加到卡里。不通过会把卡投回开发重做。卡状态不动（done 由 flow_close 设）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        card: { type: "string", description: "卡片文件名或路径" },
        pass: { type: "boolean", description: "是否通过，默认 true" },
        report: { type: "string", description: "测试报告路径，可不填" },
        note: { type: "string", description: "结论备注" },
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
      const section = [
        "",
        `## 验收（${stamp()}）`,
        "",
        `- 结论：${pass ? "通过" : "不通过"}`,
        `- 报告：${args.report ? String(args.report) : "（无）"}`,
        args.note ? `- 备注：${String(args.note)}` : "",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n");
      text = text.trimEnd() + section + "\n";
      fs.writeFileSync(file, text, "utf8");

      let reply = "";
      let delivered = false;
      if (!pass) {
        try {
          reply = await say(
            roleSession("开发"),
            `【测试】${path.basename(file)} 验收不通过，请重做。报告：${args.report || "见卡"}`,
            Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS,
          );
          delivered = true;
        } catch (error) {
          reply = String(error && error.message);
        }
      }
      return { file: path.basename(file), pass, status: head.status, delivered, reply };
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
      if (head.status === "done") throw new Error(`这张卡已经是 done 了：${path.basename(file)}`);

      text = setStatus(text, "done");
      fs.writeFileSync(file, text, "utf8");

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
        const text = fs.readFileSync(file, "utf8");
        const { head } = parseCard(text);
        const name = path.basename(file);

        if (head.status === "done") {
          steps.push({ step: "done", file: name });
          break;
        }

        if (head.status === "pending") {
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
          try {
            const out = await runClose(file);
            steps.push({ step: "close", file: name, archivedTo: out.archivedTo, sha256: out.sha256 });
          } catch (error) {
            stopped = `归档失败：${String(error && error.message)}`;
          }
          break;
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
        {
          if (lastVerdict(fs.readFileSync(file, "utf8")) !== "通过") {
            steps.push({ step: "wait-verify", file: name, hint: "验收结论还没写进卡或还没通过，等测试调 flow_verify" });
            break;
          }
        }
        continue;
      }

      return { steps, stopped, card: args.card };
    },
  });

  /** flow_run 用的派单（不重复注册工具逻辑）。 */
  async function runDispatch(file, role, note, timeoutMs) {
    let text = fs.readFileSync(file, "utf8");
    const { head } = parseCard(text);
    if (head.status === "done") throw new Error("这张卡已经 done，别再派单");
    const target = roleSession(role);
    if (head.status !== "processing") text = setStatus(text, "processing");
    text = text.trimEnd() + `\n\n> 派单 → ${role}（${stamp()}）${note ? "：" + note : ""}\n`;
    fs.writeFileSync(file, text, "utf8");
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
    if (head.status === "done") throw new Error("这张卡已经 done 了");
    text = setStatus(text, "done");
    fs.writeFileSync(file, text, "utf8");

    const type = sanitize(head.type || "任务卡", "任务卡");
    const destDir = path.join(archiveDir(), type, yyyymm());
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(file));
    if (fs.existsSync(dest)) throw new Error(`归档目标已存在，不覆盖：${dest}`);

    const before = sha256(file);
    fs.renameSync(file, dest);
    const after = sha256(dest);
    if (before !== after) throw new Error(`SHA 不一致（${before} ≠ ${after}），文件已移到 ${dest}`);
    return { archivedTo: dest, sha256: after };
  }
}

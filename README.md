# dsh-flow

跨会话流程编排：让四个角色（统筹 / 预研 / 开发 / 测试）在 DSH 里配合走完一条活——派单、实现、独立验收、需求比对、终审把关、归档，然后回到起点开下一条。

**和剧场插件（dsh-theater）无关**：不 import、不依赖、不共用数据。投递是自己实现的（`agent.steer` + 等 `turn/end`），插件里也没有任何剧本逻辑。

---

## 解决什么

多会话协作时，两件事最容易坏：

- **「自己验自己」**：开发写完自测通过，就等于「做完了」。没有第二双眼睛，边界没人报。
- **流程全靠人记**：派了谁、到哪一步、卡在哪，散在各个会话的脑子里。换一天就接不上。

dsh-flow 把「一条活怎么走完」固成工具：任务卡是文档（正本），状态写在 YAML 头里，每一步都有工具管。**人和会话都不用记流程，照卡走就行。**

---

## 角色与流程

```
                        ┌─────────── 回到起点（下一轮）────────────┐
                        ▼                                            │
预研 ─提需求/选型─► 统筹 ─建卡、拆解、派单─► 开发 ─实现、自测、push、回执─┤
                     │                                              │
                     └──派验收──► 测试 ─独立验收、出报告、报边界──► 统筹 ─需求比对、终审、归档
```

| 角色 | 干什么 | 不干什么 |
| --- | --- | --- |
| **统筹** | 拆解、建卡、派单、派验收、需求比对、终审把关、汇总、归档 | 不自己动手实现；不替别人拍板 |
| **预研** | 提需求、写预研说明、选型 | 不直接改实现 |
| **开发** | 认领、实现、自测、push、回执 | 不自验——自测通过不等于验收通过 |
| **测试** | 独立验收、出报告、报边界 | 不替开发改代码；不接「边改边验」 |

闭环一句话：**预研 → 统筹（建卡/拆解）→ 开发（做）/ 测试（验）→ 统筹（需求比对、终审把关，不过就再走一轮开发）→ 统筹（汇总/归档）→ 回到起点。**

五个坎：**派单 → 认领 → 回执 → 独立验收 → 终审**。少一个，这条活就不算闭环。

---

## 流程原理（平台无关）

这套流程不绑 DSH。拆开看只有五个抽象——**角色 / 任务卡 / 状态机 / 投递 / 归档**，换到飞书、GitHub Issues、Notion 或者自建系统，照着都能复刻。

三条不变量换平台也不能改：

1. **卡是正本**：状态、派单记录、验收结论都在卡上；聊天和看板只是视图。
2. **开发不自验**：做的人不判自己。这条松了，整个流程就没有意义了。
3. **关闭要有通过的验收**：没有验收的 `done` 是耍赖。

完整原理——八拍时序（每拍的输入/产出/判据/失败怎么办）、状态转移表、换平台映射表、最小实现清单、复刻成功的判据——见 **[docs/流程原理.md](docs/流程原理.md)**。

---

## 工具

| 工具 | 干什么 |
| --- | --- |
| `flow_roles` | 登记 / 查看四个角色对应的会话 id；`action=set` 用逗号分隔可一次登记多个会话（多实例，例如三个测试） |
| `flow_start` | 建任务卡：写 YAML 头（from/to/type/ticket/status/created），status=`pending`，投给统筹 |
| `flow_dispatch` | 统筹派单：卡状态 `pending → processing`，记一笔派单，投给开发 / 测试；**写 `toSession`（完整会话 id）优先于 `to` 角色名**；顺手把下一站写进卡头 `downstream`（不填按 `to` 推导：开发→测试、测试→统筹）；**派给谁就把卡头 `to_session` 改成谁**（0.3.1：不改这一笔，交卡时的「提交人」会取到建卡人统筹，终审驳回就投错人），派单行也带会话 id |
| `flow_submit` | 开发交卡：`processing → waiting_verify`，追加「## 交付记录」，**自动挑一个空闲测试**（名下没有在途卡）投过去；都忙就停在 `waiting_verify` 报「排队」。提交人取 `session` 参数 → 卡头 `to_session` 兜底；**兜底撞上统筹登记 id 一律作废，记「（未登记）」并写明原因**（0.3.2：手工建卡的卡头常是统筹，那不是交卡人） |
| `flow_ask` | 开发遇需求对不上、不确定时**不许猜**：卡 `processing → blocked`，追加「## 疑问」，投统筹决策 |
| `flow_answer` | 统筹答复疑问：`blocked → processing`，追加「## 决策」，投回开发；决策留卡里供追溯 |
| `flow_verify` | 测试回执：把「通过 / 不通过 + 报告路径」写进卡；不通过投回开发（**实现缺陷类最多退 2 轮**——测试退回和 `flow_reject` 驳回合起来算同一本账，第 3 次动作转 `waiting_human` 人工裁定；此状态下再调会直接报错，要先由统筹 `flow_dispatch` 放行）。**先投递再记账**，投递结果分三档见下。**`dryRun:true` 只算不改**：不改卡、不投递、不写登记单、不占分配时间，返回 `wouldBeStatus` / `wouldDeliverTo` / `rejectsLeft`，给测试验流程用 |
| `flow_reject` | 统筹终审驳回（0.3.0）：**只有 `waiting_final` 能驳**，退回 `processing` 投**原开发**（从最后一段「## 交付记录」的提交人取；**提交人若是统筹登记 id，作废并记进 `ignoredCoordinatorSubmitters` 报出来**，改投空闲开发——0.3.2），卡上追加「## 终审驳回」段（理由 / 驳回人 / 类型 / 轮次）。`type` 可选 `实现缺陷` / `执行书缺陷`，不填算实现缺陷；**两类各 2 轮、账合并**（`## 验收` 的测试退回和驳回算同一本），同类型满 2 轮后第 3 次抛错提示人工裁定。投递明确失败时卡一个字都不动 |
| `flow_close` | 归档：状态改 `done`、移到【归档区】`<类型>\<YYYY-MM>\`、移动前后核对 SHA-256 |
| `flow_run` | 一键封顶：读一张卡按状态自动推进，失败停下报原因 |
| `flow_status` | 读全局会话状态表，汇总「活跃 N / 待机 M」+ 明细；`only` 可只看活跃或待机 |

### 状态机（0.3.0）

```
pending → processing → blocked → waiting_verify → waiting_final → done
              ▲            │            │               │
              └─ answer ───┘            │               │
              └────── 不通过返工 ────────┘               │
              └────────── flow_reject 驳回 ──────────────┘

waiting_verify ──实现缺陷类满 3 次──> waiting_human ──统筹 flow_dispatch 放行──> processing
```

| 状态 | 谁在手上 | 怎么离开 |
| --- | --- | --- |
| `pending` | 等派单（统筹） | `flow_dispatch` → `processing` |
| `processing` | 开发在做 | `flow_submit` → `waiting_verify`；`flow_ask` → `blocked` |
| `blocked` | 等统筹答复疑问 | `flow_answer` → `processing` |
| `waiting_verify` | 测试在验（或排队中） | `flow_verify` 通过 → `waiting_final`；不通过 → `processing`（回开发；**实现缺陷类满 3 次 → `waiting_human`**） |
| `waiting_human` | 连退超限，等人工裁定 | 统筹 `flow_dispatch` 派单 → 转回 `processing`（等于放行）；**此状态下不能再 `flow_verify`** |
| `waiting_final` | 等统筹终审 | `flow_close` → `done`（归档）；`flow_reject` → `processing`（退回原开发，**唯一能驳的状态**） |
| `done` | 归档区 | 终态 |

卡头的 `to_session` 记的是**当前持有人**，挑空闲测试就靠它判断「谁手里有在途卡」。

### 数据在哪

- `~/.dsh/plugins/dsh-flow/config.json` — 工作区路径、任务卡目录、归档目录、四个角色的会话 id。
- 任务卡 — 在 `config.workspace` + `config.tasksDir` 下（`workspace` 默认为空，**首次使用前必须配成本机工作区路径**；`tasksDir` 默认 `【文档区】\计划与任务`）。
- 归档 — 在 `config.workspace` + `config.archiveDir` 下，按 `<类型>\<YYYY-MM>` 分。
- 派活登记单 — `【文档区】\进度\派活登记.md`（即 `tasksDir` 的同级 `进度/` 下），一行一条：时间 ｜ 谁 ｜ 任务 ｜ 状态 ｜ 摘要。`flow_dispatch` / `flow_submit`（含排队）/ `flow_verify` / `flow_close` 各自追加；**只追加不重写**，写失败不影响主流程——但**不再静默**：会 `console.error` 并往插件目录 `_dispatch-error.log` 落一条完整堆栈，排查「登记单没写」先看它。登记单的「谁」列默认取卡头 `to_session`；手工建的卡没有这一栏，交卡时传 `flow_submit({ "session": "session-…" })` 补上。
- **投递结果分三档**（`flow_verify` / `flow_submit` 都按这套）：`delivered`（`reply` 正常返回）、`timeout`（超时，不确定）、`failed`（`reply` 里是 `not-found` / `不存在` 这类，明确没送到）。**超时按「当它送到了」处理**——照常 `touchAssigned`、卡头写 target、登记单记「…（投递超时，未确认）」；因为漏记分配时间的伤害比多记一次大。只有 `failed` 才回滚卡头、不占分配时间、记「投递失败（未送达）」。返回体里有 `outcome` 字段，三档一眼可辨。
- **为什么超时不等于没送到**：`theater_say` 超时的消息通常已经送达，只是对方没在 `timeoutMs` 内回。2026-10-25 实测：往开发投「请重做」，对端真收到了，但当时按「未送达」记账，对端和白纸黑字的登记单对不上。
- **假派活**：明确失败（会话不存在）时不会有「开发收到请重做、去看卡已没了」这种事。这种卡头 `to_session` 会回滚成原持有人，不留指向死会话的指针；`lastAssigned` 也不动，轮转挑人不受影响。要复现：把 `config.json` 里某个角色**临时**指到不存在的会话，跑 `flow_verify` / `flow_submit`，看登记单记的是不是「投递失败（未送达）」，跑完记得还原。
- `~/.dsh/会话状态.md` — **全局会话状态表**，所有会话共用一张，**不由本插件维护也不归本插件**。`flow_status` 只读它，汇总「活跃 / 待机」；这张表是判断「现在能不能重启宿主」的依据。

---

## 安装

1.  plugin 目录已有（`~/.dsh/plugins/dsh-flow/`）。

2.  在 profile 的 `package.json` 里挂上：

```json
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-flow": "link:<home>/.dsh/plugins/dsh-flow" },
"dsh": { "profile": { "bundles": ["...", "dsh-flow"] } }
```

3.  建 junction（PowerShell）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-flow" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-flow"
```

4.  重启 DSH（Host 只在启动时加载插件一次）。**改了 `lib/*.js` 必须重启才生效，改 `config.json` 不用。**

5.  登记四个角色：

```jsonc
flow_roles({ "action": "set", "role": "统筹", "sessionId": "session-abcdefgh-…" })
flow_roles({ "action": "set", "role": "开发", "sessionId": "session-abcdefgh-…" })
// 预研、测试同理
flow_roles({ "action": "get" })   // 看现状
```

> `sessionId` 必须带 `session-` 前缀。只传 uuid 会报 `session/not-found`。

---

## 一键 vs 分步

| 场景 | 用哪个 |
| --- | --- |
| 想盯着每一步、每一步都能改主意 | **分步**：`flow_start` → `flow_dispatch` → `flow_verify` → `flow_close` |
| 卡已经写好，只想让它往前走 | **一键**：`flow_run` |
| 卡在哪一步说不清 | `flow_run` 先用 `maxSteps: 1` 探一步，看返回的 `steps` |

`flow_run` 的推进逻辑：

- `pending` → 派给开发
- `processing`、卡里没有「## 验收」段 → 请测试验；测试把结论写进卡后，下一圈才继续
- `processing`、卡里有验收段 → 关闭归档
- `done` → 结束

**中途失败就停**，返回 `steps` 和 `stopped` 说明卡在哪。它不会替你改实现、也不会替你编验收结论。

---

## 完整案例：从预研提需求到归档

场景：预研发现缺一个「视频录制」能力，提给统筹；统筹拆成两单（开发 + 测试）；开发做出 0.1.0；测试独立验收；统筹终审、比对需求，收口归档。

### 第 1 步 · 预研提需求

预研会话里：

```jsonc
flow_start({
  "title": "视频录制插件",
  "summary": "录屏录制",
  "from": "预研",
  "to": "统筹",
  "requirement": "需要一个能把屏幕/会话录成 mp4 的插件：开始、停止、存到交付区。依赖尽量少。",
  "criteria": "1) flow 工具能起录、停录；2) 产物是能播的 mp4；3) 空 PATH 能跑或写清依赖。"
})
```

结果：

- 卡落地：`【文档区】\计划与任务\任务卡_视频录制插件_录屏录制_NA_20261025.md`
- YAML 头：`from: 预研`、`to: 统筹`、`type: 任务卡`、`ticket: NA`、`status: pending`
- 统筹被投递叫醒（投递正文包在代码块里，语音不会念）

### 第 2 步 · 统筹建卡、拆解、派单

统筹看卡后拆成两条：

- 实现单 → 开发
- 验收单 → 测试

```jsonc
// 派给开发
flow_dispatch({ "card": "任务卡_视频录制插件_录屏录制_NA_20261025.md", "to": "开发", "toSession": "<开发会话 id>",
                "note": "按卡实现到 0.1.0，自测后 push，回执写在卡末" })
```

- 卡状态：`pending → processing`
- 卡里多一行：`> 派单 → 开发 session-<前 8 位>…（2026-10-25 14:20）：按卡实现到 0.1.0，…`
- 卡头 `to_session` 同步改成被派的那个会话（0.3.1 起）——它记的是「当前持有人」，交卡时「提交人」也从这里取
- 开发被叫醒

### 第 3 步 · 开发实现、回执

开发照卡做，做完在卡末尾写 `## 回执`（改了什么 / 验了什么 / 版本 / push SHA），然后：

```jsonc
flow_dispatch({ "card": "任务卡_视频录制插件_录屏录制_NA_20261025.md", "to": "测试",
                "note": "实现完了，请独立验收" })
```

### 第 4 步 · 测试独立验收

测试**只看任务卡的验收标准，不看开发写的回执结论**：

```jsonc
flow_verify({ "card": "任务卡_视频录制插件_录屏录制_NA_20261025.md",
              "pass": true,
              "report": "【文档区】\\测试文档\\测试报告-视频录制插件-20261025.md",
              "note": "三条判据全过；边界：没测长录制（>30 分钟）" })
```

- 卡里追加 `## 验收（2026-10-25 15:02）`，结论「通过」，报告路径，备注
- **不通过**时 `pass: false`，卡会投回开发重做

### 第 5 步 · 统筹汇总、归档

统筹先做需求比对与终审：功能跟需求对不对得上、有没有 BUG、有没有小改大收益的优化点——不过就出方案再走一轮开发；通过了才汇总给主人，然后：

```jsonc
flow_close({ "card": "任务卡_视频录制插件_录屏录制_NA_20261025.md" })
```

- 状态：`processing → done`
- 文件移到：`【归档区】\任务卡\2026-10\任务卡_视频录制插件_录屏录制_NA_20261025.md`
- 移动前后 SHA-256 一致才返回成功

### 一键版

上面五步如果不想一步步点：

```jsonc
flow_run({ "card": "任务卡_视频录制插件_录屏录制_NA_20261025.md" })
```

它会：派开发 → 请测试验（等测试把结论写进卡）→ 关闭归档，每步都记在返回的 `steps` 里；哪一步没成，`stopped` 会说明。

---

## 验证边界

**单测**

- 分步闭环、拒绝路径、`flow_run` 分步推进：历史自测脚本 21 项全过（模板工作区，跑完还原 config）。
- 段落拼接：`_selftest_section.mjs` 10 项全过（0.2.5 起）。
- 宿主内实际加载：2026-10-25 重启后工具出现在真实工具列表。**前提是每个工具的 schema 必须带 `additionalProperties: false` 和 `output`**——缺了宿主会把整行静默判成「启动失败」，工具不出现但也不报错。

**真实会话闭环**

- **0.2.0**（2026-10-25，开发 3 / 测试 3 六条独立会话跑四张卡）：`flow_roles get` 多实例显示正常；`flow_submit` 四次交卡都由工具挑人，两个不同测试先后接到卡；全链路四遍走通无人工补位；旧单值配置回归正常。
- **0.2.5**：`waiting_human` 用真卡验——连退第 1、2 次回 `processing`，第 3 次转 `waiting_human`，第 4 次 `flow_verify` 直接被拒；`flow_dispatch` 放行后回 `processing`，再验通过进 `waiting_final`。验收段四段都两换行、段内不粘连。另有独立测试会话按四条判据复核通过。
- **0.2.6**：`dryRun` 硬条件——同一张卡跑前跑后 SHA-256 不变、登记单不增行、`lastAssigned` 一字不差；`wouldBeStatus` / `wouldDeliverTo` / `rejectsLeft` 与真跑一致；`waiting_human` 下 `dryRun` 同样被拒（闸门与真跑同源）；`flow_submit` 投递失败回滚卡头、不占分配时间；`resolveCard` 找不到卡时带 `dryRun` 提示。
- **0.2.7**：三档复查——`timeout` 档 `outcome=timeout`、卡头写 target 不回滚、`lastAssigned` 确实变动、登记单记「投递超时（未确认）」；`failed` 档（死号）卡头回滚、死号不进 `lastAssigned`、记「投递失败（未送达）」。判据 6 的连退 1/2/3 递增不跳号、通过进 `waiting_final` 一并复查。
- **0.3.0**（2026-10-26，加 `flow_reject`）：重启后真卡流程已验——统筹真调通过路径 5/5（含第 3 次报错），测试中心模块级复验 40/0。函数级已验（`reworkCounts` 合并账：验收不通过 1 + 驳回(实现缺陷) 1 = `impl: 2`；两段执行书缺陷 = `spec: 2`、`impl: 0`；无类型驳回算实现缺陷；`originalDeveloper` 多段取最后、假值返回空串）。工具注册在重启后已验。段头注入方向另验：`safeLine` / `safeBlock` 把写进卡的自由文本压平坦化，段切与字段解析一律行首锚定——理由里写 `## 验收`、`- 类型：`、`- 提交人：` 都改不动段与账；`lastVerdict()` 也一并改成行首锚定（原来用字面 `lastIndexOf("## 验收")`，理由里一句「## 验收 结论：不通过」就能骗过 `flow_close` 的归档判定）。
- **0.3.1**（2026-10-26，派单时更新 `to_session`）：`flow_dispatch` 派完把卡头 `to_session` 改成被派的会话，派单行带上会话 id；`flow_submit` 的「- 提交人」改取真正的交卡人（`args.session` → 卡头 `to_session` 兜底），不再可能写成建卡人。起因：建卡时 `to_session` 写统筹，派给开发后卡头仍指统筹，交卡记成「提交人：统筹」，`flow_reject` 的 `originalDeveloper` 照提交人取，终审驳回就投回统筹而不是开发（2026-10-26 13:26 那张卡被当成别人的，源头在此）。六态流转、两套验收、驳回轮次账均未动。
- **0.3.2**（2026-10-26，堵住 0.3.1 漏的那条入口）：0.3.1 只修了主路径，5 号探针 F 抓到反例——手工建卡 + 卡头 `to_session` 是统筹 + 交卡不传 `session`，提交人照样记成统筹，`originalDeveloper` 再从提交人取，驳回仍投统筹。现在两头都拦：`flow_submit` 的兜底撞上统筹登记 id 一律作废，记「（未登记）」并加一行「- 提交人判定：… 是统筹登记 id，不作交卡人」；`originalDeveloper` 扫交付记录时跳过统筹 id，并把跳过的写进 `flow_reject` 返回的 `ignoredCoordinatorSubmitters`（同时 `console.error` 报一行），不静默。另修「## 交付记录」段头前少一个空行（与 `flow_verify` 的段间口径对齐，属段粘连类，5 号 §五 复现）。函数级已验（0.3.2，机器 harness：卡头统筹 + 不传 session → 提交人「（未登记）」+ 判定行 + 段头两换行；对照卡头是开发 → 提交人写开发、无判定行；交付记录里提交人=统筹 → 驳回 `to` 是空闲开发、`isOriginalDeveloper:false`、`ignoredCoordinatorSubmitters` 有值）。
- **0.3.3**（2026-10-26，第三个洞：写卡把别人的段吃掉）：`flow_submit` / `flow_verify` / `flow_reject` 三个工具都是「先投递、再写卡」，投递最长等 120 秒；旧写法把**投递前**读到的 `text` 加上新段整段 `writeFileSync` 回去，这几十秒里别人追加的段（测试的「## 验收」、统筹的「## 终审驳回」、开发自己的回执）会被一起抹掉。实证：15:49 C3 卡的「## 交付记录」落盘后消失，卡上只剩一段引用在代码块里的同名标题，`originalDeveloper` 取不到原开发，15:53 终审驳回投到了 1 号身上。现在写卡统一走 `commitCard(file, mutate)`：写前重读磁盘、把改动套在最新内容上、写完再核对，连抢三轮报错不硬写；段拼装统一走 `appendSection()`（两个换行起段）。另加交卡自检 `assertDeliveredRecord()`：交完若 `stripFencedBlocks` 后找不到本次的「## 交付记录（时间）」，直接报错，不当成交卡成功。harness 已验六组（A 旧写法复现吞段；B `commitCard` 保住邻居段且段头两换行；C 同一张卡并发交两次、两条交付记录都在；D 卡末未闭合围栏仍写出真段；E `flow_verify` 通过路径 status/段正常；F `flow_reject` 仍投原开发）。
- **0.3.4**（2026-10-26，第四个洞：改头改到了正文上）：`setStatus` / `upsertHead` 的正则 `^key:.*$` 是满篇搜的，不认「YAML 头」和「正文」。头里没有 `to_session` 而行文里贴了一段带 `to_session:` 的证据（开发回执里常贴卡头原文），改的就会是**正文那一行**——头没补上、正文被改写，等于卡头永远不记持有人。实证：16:00 交卡后卡头仍无 `to_session`，回执代码块里那行引用被当成目标改了。现在两个函数都先切出第一对 `---` 之间的头块（`inHead()`），只在头里动手；头缺失直接报错。harness 已验（头无 `to_session` + 正文有同名行 → 头补上被派会话、正文那行原样不动、status 照改）。
- **0.3.5**（2026-10-26，写卡口统一）：剩下六个口子——`flow_dispatch`、`flow_ask`、`flow_answer`、`flow_close`、`flow_run` 里的 `runDispatch` / `runClose`——全部从「读旧文本 → 改 → `writeFileSync` 整段写回」换成 `commitCard`（写前重读、写后核对、连抢三轮报错）。另外顺手补了第七处：`flow_run` 的「老卡补 waiting_final」那行写的是 `setStatus(text, …)`，形状与六处相同、但字符串不匹配 `fs.writeFileSync(file, text`，`grep` 查不出来。`flow_ask` / `flow_answer` 两段改用 `appendSection()`，段头前补上第二个换行（与 `flow_verify` 口径一致，属段粘连类）。六态流转、两类轮次账、投递行为（`say` 那部分）一个字没动；`grep -c "fs.writeFileSync(file, text" lib/index.js` = 0。另修 `flow_run` 的派单行：原来只有角色名（`> 派单 → 开发（时间）`），不带会话 id，与 `flow_dispatch` 的 `> 派单 → 开发 session-…（时间）` 不一致——0.3.1 的验收标准是「派单记录里保留派给谁的痕迹，不能只有卡头一处」，新路径漏了（1 号开发在真宿主里挖出）。实证见「样本」下面的 AC 回执。
- **0.3.6**（2026-10-26，第五个洞：写卡加文件锁）：`commitCard` 改成 `async`，落盘前先抢 `<卡>.lock`——`fs.openSync(lock, "wx")` 是原子的「不存在才创建」，跨进程互斥靠它，不再靠读-改-写那几微秒。锁里写 `pid + token + 时间`；抢不到就退避重试（2→40ms 翻倍、带抖动，不忙等），8s 还抢不到报错不硬写。三个必须兜住的情况：持锁方崩了（`process.kill(pid,0)` 判死，或锁的 mtime 超 5s 的 TTL）判僵尸锁，**处置权靠 `rename` 抢**——两个进程同时判出同一把僵尸锁时只有一个 rename 成功，另一个老实回去重抢，不会出现「A 删了 B 刚建的新锁」（这条是压测里真踩出来的：`stat` 报 ENOENT、随后 `readFileSync` 又读到活锁，凭一次 `stat` 失败就偷会双持）；释放只删 token 对得上的那把，读不到或 token 变了都不碰。落盘同时从 `writeFileSync` 改成「同目录临时文件 + `rename`」原子替换：`writeFileSync` 先截断再写，并发时别的会话会读到半张卡（实测报「这张卡没有 YAML 头」3 次），`rename` 之后读者要么看到旧整卡、要么看到新整卡。另外 Windows 上锁文件「正在删除/被占用」时 `open wx` 报的是 `EPERM` 而不是 `EEXIST`，按同一种「抢不到」处理；`rename` 撞到 `EPERM/EBUSY/EACCES` 退几步再试。11 处调用点跟着改 `await`；六态流转、两类轮次账、投递行为一个字没动；`flow_start` 新建卡那次写、`saveConfig` 都没碰。等锁的超时判断放在循环最前面、僵尸锁处置完也退避一次，保证任何路径都在 8s 内收口、不会绕成无退避的死循环。**改前/改后（同一套真多进程压测：20 个独立进程各写 5 轮 + 1 个进程连写 40 笔，共 140 段）**：0.3.4 只活下来 83 段（丢 57 段，40.7%），0.3.6 是 140/140（丢 0，无重复、卡头与正文完好）；100 个进程同时抢（200 段）0 丢；持锁进程 `kill -9` 后 128ms 内下一笔拿到锁，TTL 过期锁 124ms 内被拾取；单笔端到端（含 1ms 投递）100 次均值 66–75ms → 78–88ms，差的那十几毫秒是多一次临时文件 + rename 的落盘。回执见「样本」下面的 AC 单。
- 现场共造 9 张一次性假卡（dryRun / submit / waiting_human / 连退回归 / 通过 / 判据 CD 等），验完全部清掉，config 临时改动均已还原。

**没验的（先当不能）**

- **0.3.2 的兜底已在 0.3.4 补上真工具那一枪**（手工建卡 + 卡头写统筹 + `flow_submit` 不传 `session` → 提交人记「（未登记）」+ 判定行写明是统筹登记 id、不作交卡人、段头前两个换行在），主路径 0.3.1 已验过。
- **协议内写者的窗口已堵死，协议外的不行**：`commitCard` 现在整段读-改-写都在文件锁里，同一台机器上走 `commitCard` 的写者一律排队，读-写之间不再有缝。**剩下的是不走锁的写者**——别的进程/脚本直接 `appendFileSync` 往卡里加东西（0.3.5 的 D 组探针就是这种），它插在别人 write→rename 之间，照样会被整段覆盖；这类写者要么改成走工具，要么只能把卡的存储改成追加式日志（改存储格式，不在本版范围）。另：锁只管同机同盘，跨机共享目录不做。6 号 2026-10-26 拿独立进程高频并发压过一轮（4 组 12 轮、6200 段 + 12 次交卡），当时一段没丢，但那是运气好、窗口还在。当时的压测报告留在内部文档区（`测试文档\验收输出_探针H2_高频并发写卡_20261026.md`），未随仓库发布。
- **`flow_dispatch` / `flow_ask` / `flow_answer` 的投递失败**：仍沿用旧语义——先写卡（含 `to_session`、段、派单行）再投递，投递明确失败时卡头已指向那个会话，下一轮由统筹改派覆盖。`flow_verify` / `flow_submit` / `flow_reject` 是「先投递再记账」，两套不一致，**待改**（0.3.5 只统一了写卡口，没动次序）。
- **写后核对看不出来的那种吞段已经不再发生（锁挡的），但核对本身仍是「自己写的 vs 重读的」**：0.3.6 之后照样保留那三轮核对，它的作用变成第二道保险——只在协议外写者插进来时才会撞出来（构造得到：独立进程忙轮询卡文件 mtime，一变就追加，`commitCard` 连抢三轮后报「正被别的会话反复改动」，实测触发过）。
- **「20 段一个不丢」这类高频追加探针，对「写卡在投递之前」的口子不具区分力**：这几处写卡发生在投递之前，窗口是微秒级，改前改后都能过；要证明改动的价值，得把读-写窗口人为放大（0.3.5 的 D 组），或造两个并发写者（0.3.6 的 AC-01 那样：20 个独立进程 + 1 个连写进程，0.3.4 丢 57/140）。

- **`flow_submit` 的 `timeout` 档**：跟 `flow_verify` 同一套判定，但没单独实证。
- **`failed` 档的字面量匹配**：靠 `/not-found|不存在/i` 认，宿主换措辞会漏判成 `timeout`，届时同步改正则。
- **排队路径**：交卡时刻一直错开，`pickFree` 返回 null 那条没在真实会话跑过。
- **疑问回传**：`flow_ask` / `flow_answer` 一次都没走到。
- **挑人轮转**：只验了「不是固定第一个」，没验连续多轮是否真按最久未派轮转。
- **跨工作区**（`config.workspace` 指到别处）、同名卡片、卡被归档后再被 `flow_run` 指到。

**样本**：单机、Windows 宿主、9 张假卡 + 6 条真实会话；不是端到端演练。0.2.6 的 `timeout` 档是拿生产 config 直接投到真开发身上验的——方式不合规，结论可采信。



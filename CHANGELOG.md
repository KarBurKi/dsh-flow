# dsh-flow 更新日志

> 0.3.0–0.3.5 的明细记在 README 的「版本与实证」段落里，本日志从 0.3.6 起继续记。

## 0.3.6（2026-10-26）

- **写卡加文件锁，堵掉读-改-写之间的窄缝**：`commitCard` 改成 `async`，落盘前先抢 `<卡>.lock`（`fs.openSync(lock, "wx")` 原子创建，锁内写 `pid + token + 时间`）。抢不到退避重试（2→40ms 翻倍 + 抖动，不忙等），8s 上限报错不硬写。
- **僵尸锁**：持锁进程崩了（`process.kill(pid, 0)` 判死）或锁 mtime 超 5s（TTL）判僵尸。处置权靠 `rename` 抢——两个进程同时判出同一把僵尸锁时只有一个能改名成功，避免「A 删了 B 刚建的新锁」把互斥破掉。释放只删 token 对得上的那把。
- **落盘改原子替换**：写同目录临时文件再 `rename` 覆盖。原来 `writeFileSync` 先截断再写，并发时读者会读到半张卡（实测报「这张卡没有 YAML 头」3 次），`rename` 之后读者要么看到旧整卡、要么看到新整卡。
- **Windows 的 `EPERM`**：锁文件处于删除中/被占用时 `open wx` 报 `EPERM` 而不是 `EEXIST`，按同一种「抢不到」处理；`rename` 撞 `EPERM/EBUSY/EACCES` 退几步重试。
- 11 处调用点全部补 `await`。六态流转、两类轮次账、工具语义、`flow_start` 新建卡那次写、`saveConfig` 都没动。等锁超时判断前置、僵尸锁处置后也退避，任何路径都在 8s 内收口（不会绕成无退避死循环）。
- 实测：20 个独立进程各写 5 轮 + 1 个进程连写 40 笔（共 140 段）——0.3.4 只活下来 83 段（丢 57），0.3.6 是 140/140；100 个进程同时抢（200 段）0 丢；持锁进程 `kill -9` 后 128ms 内下一笔拿到锁，过期锁 124ms 内被拾取；单笔端到端 100 次均值 66–75ms → 78–88ms。
- 已知没堵：不走锁直接 `appendFileSync` 的写者挡不住；只管同机同盘；TTL 让路时理论上还有一次缝。详见 README「没验的」。

## 0.2.7（2026-10-25）

- **投递三档**：`outcome = delivered / timeout / failed`。`failed` 认 reply 里的 not-found / 不存在；`timeout` 按「当它送到了」处理——`touchAssigned`、卡头写 target、登记单记「验收不通过（第 N 次）（投递超时，未确认）」；`flow_submit` 同口径记「已交卡（投递超时，未确认）」。返回体加 `outcome`。
- 判据 1/2/3/4 复查 + 判据 6 全过。

## 0.2.6（2026-10-25）

- **`flow_verify({dryRun:true})`**：只回显、不动卡、不投递、不登记。返回 `wouldBeStatus`、`wouldDeliverTo`、`rejectsLeft` 等，闸门跟真跑同源。
- **记账挪到投递之后**：`flow_verify` / `flow_submit` 先 `say`、看 `delivered`、再写卡记账；失败不 `touchAssigned`、卡头回滚原持有人、登记单记「投递失败（未送达）」带错因。
- `resolveCard` 找不到卡时提示「一次性验证卡可用 dryRun」。

## 0.2.5（2026-10-25）

- **`waiting_human` 独立状态**：连退超限转人工不再是 `processing`，`flow_verify` 见了直接拒；`flow_dispatch` 派单即放行回 `processing`；`flow_run` 有 wait-human 分支。
- **验收段不粘连**：拼段时空行写死不过 `filter`，段间补两个换行。

## 0.2.4（2026-10-25）

- `flow_submit` 加可选 `session` 参数，派活登记「谁」列优先取 `args.session`。

## 0.2.3（2026-10-25）

- 修 0.2.2 的 `logDispatch` 从未被调用：补上 `flow_dispatch`、`runDispatch` 等 7 处调用；`catch` 从静默改为写 `console.error` 和 `_dispatch-error.log`。

## 0.2.2（2026-10-25）

- **连退上限**：`MAX_REJECTS = 2`，连退第 3 次转人工裁定，不再自动回开发。
- **派活登记单**：工作区下的 `进度\派活登记.md`，追加式登记派单、交卡、验收、归档。

## 0.2.1（2026-10-25）

- 收口修正与自愈补丁（详见 0.2.0 后首轮现场修复）。

## 0.2.0（2026-10-25）

- **下游自动路由**：状态机 5 态 `pending → processing → waiting_verify → waiting_final → done`；`config.roles` 支持数组；`flow_dispatch` 写卡头 `downstream`。
- **`flow_submit`**：写卡、`processing → waiting_verify`、按「名下无 waiting_verify 卡」挑空闲测试投递；无空闲测试则排队。
- **`flow_verify`**：pass → `waiting_final` + 投统筹终审；fail → `processing` + 投空闲开发返工。
- **`flow_close`**：只认 `waiting_final` 且卡里有通过结论才归档。

## 验证边界

- 0.2.6 / 0.2.7 的 timeout 档用生产 config 直接投到真开发身上验过（方式不合规，结果可采信）；`flow_submit` 的 timeout 档只有同源推理，没单独实证。
- 空正文重试属宿主 asar 补丁，不在本插件范围。

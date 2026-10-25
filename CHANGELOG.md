# dsh-flow 更新日志

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
- **派活登记单**：`D:\【欧鲸鲸的工作室】\【文档区】\进度\派活登记.md`，追加式登记派单、交卡、验收、归档。

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

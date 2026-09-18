# 飞书连接与迁移部署

Oryn Eyes 的飞书入口使用官方 Node SDK 长连接，无需公网回调地址、域名或入站端口。支持企业自建应用；群自定义 Webhook 机器人不能接收用户消息，不能代替企业自建应用。

飞书入口与 QQ/AstrBot 入口可以同时连接同一个 Oryn 服务，也可以只部署飞书。模型、源码检查、Issue 去重和发布仍由原有服务负责，目标仓库由 `ORYN_REPOSITORY` 决定，默认 `YourTongji/YourTJ-Hub`。不需要安装 AstrBot、OneBot 或 NapCat。

## 创建应用与订阅事件

1. 在飞书开放平台创建企业自建应用，启用机器人能力，记录 App ID 与 App Secret。
2. 在「权限管理」申请下面的应用身份权限；名称以平台显示为准。发布版本，完成管理员审批，并将测试用户加入应用可用范围。
3. 启动下文中的飞书连接进程。到「事件与回调 → 事件配置」选择长连接方式接收事件，订阅 `im.message.receive_v1`（接收消息）。如果控制台提示没有长连接，先检查进程是否记录了 `feishu_connected`。
4. 将机器人加入目标群。私聊直接发消息；群里 @机器人触发。机器人只处理用户消息，不响应其他机器人的消息。

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群内 @机器人的消息 |
| `im:message:send_as_bot` | 以机器人身份发送回执和最终结果 |
| `im:message:readonly` | 读取明确引用的原消息 |
| `im:resource` | 读取消息里的图片资源 |
| `im:message.group_msg`（可选） | 接收未 @ 的群消息用于短期上下文；需要相应审批 |
| `im:message.reactions:write_only` | 在原消息上添加/删除表情回应；若已授予 `im:message` 可免 |

没有全量群消息权限时，近期上下文只包含应用实际收到的消息，不会主动抓取整个群聊历史。所有近期上下文仅保留同一用户、同一会话/话题，30 分钟过期。明确引用可补入其他发言人的原消息，但原消息必须属于同一个会话。

飞书国际版 Lark 使用 `FEISHU_DOMAIN=lark`，并在对应开放平台配置应用；两边凭据不可混用。

## 在新机器部署

适用于 Linux x64 / ARM64，选择 CI 中对应架构的部署包，解压到 `~/oryn-eyes`。包内包含 Bun、官方飞书 SDK 和已构建的 Synergy Core；不要在不同架构机器之间直接复制依赖和二进制文件。运行源码时先执行 README 中的安装与 Core 构建步骤。

系统需要 Python 3、venv 支持及 Pillow。Pillow 负责截图尺寸限制、EXIF 清除和统一编码：

```sh
cd ~/oryn-eyes
python3 -m venv .venv
.venv/bin/pip install -r astrbot_plugin_oryn_eyes/requirements.txt
mkdir -p ~/.config/oryn-eyes ~/.config/systemd/user
chmod 700 ~/.config/oryn-eyes
install -m 600 deploy/feishu.env.example ~/.config/oryn-eyes/feishu.env
```

编辑 `feishu.env`，填入真实 App ID / App Secret，并将 `ORYN_PYTHON` 设置为这台机器上 `~/oryn-eyes/.venv/bin/python` 的**绝对路径**，环境文件中的 `~` 不会自动展开。密钥文件不要放入 Git。

按 README 配置 `model.env`、`github.env`、`bridge.env`。其中 `bridge.env` 的 `ORYN_BRIDGE_TOKEN` 必须与 Oryn 服务一致；飞书连接进程不需要模型或 GitHub 密钥。飞书单独部署不需要 QQ 插件使用的 `bridge.token`。

```sh
install -m 644 deploy/oryn-eyes.service ~/.config/systemd/user/
install -m 644 deploy/oryn-eyes-feishu.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now oryn-eyes.service oryn-eyes-feishu.service
curl --fail http://127.0.0.1:18080/health
journalctl --user -u oryn-eyes-feishu.service --since today
```

无人登录时仍需运行用户服务的机器，还需管理员启用该用户的 lingering。日志使用系统 journal，沿用机器的保留/轮转策略；截图和会话不落长期存储。

Oryn 服务默认绑定 loopback，推荐两个进程同机部署。若分开部署，使用受认证的 HTTPS 入口或 SSH/Tailscale 隧道，设置 `ORYN_EYES_URL`；远程明文 HTTP 被拒绝，避免泄露桥接 Token。运行前台调试时，可用 `bin/bun --env-file=/绝对路径/bridge.env --env-file=/绝对路径/feishu.env src/feishu.ts`。

## 行为与配置

支持文字、图片和包含文字/图片的富文本消息，以及明确引用消息。图片只能从飞书官方的消息资源 API 获取，不会访问聊天文本提供的任意图片 URL。下载限制 8 MB，归一化后每张 4 MB，最多 6 张、总计 20 MB；不可读图片会明确标为不可用。卡片、音视频、表情包和合并转发不作为支持输入。

收到反馈后机器人先在原消息上添加 👀（`GLANCE`）表情回应，不再发送文字回执。处理结束时先添加 ✅（`DONE`）再移除 👀，随后只发送最终结论一条回复，中途不发进度消息。表情接口不可用时退回为在最终回复末尾附上日志编号，保证每条反馈都可追溯。私聊 `stop` 或群里 `@机器人 stop` 停止该用户在当前会话/话题中的未完成请求，原消息表情同样切换为 ✅。

| 环境变量 | 默认值 / 说明 |
| --- | --- |
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 必填 |
| `FEISHU_DOMAIN` | `feishu`；可选 `lark` |
| `ORYN_BRIDGE_TOKEN` | 必填，与服务一致 |
| `ORYN_EYES_URL` | `http://127.0.0.1:18080` |
| `ORYN_EYES_BUDGET_SECONDS` | `900`，应与服务总预算一致 |
| `FEISHU_MAX_PENDING` | `20`，限制飞书侧处理中任务 |
| `FEISHU_ALLOWED_CHAT_IDS` | 逗号分隔的群 ID；空值允许机器人所在全部群 |
| `FEISHU_ALLOW_PRIVATE` | `true`；设为 `false` 禁用私聊 |
| `ORYN_PYTHON` | `python3`；必须能导入 Pillow |

消息重投按 message ID 在内存中去重，回复使用稳定的 UUID 降低重试重复发送。平台事件立即确认，耗时模型处理在后台执行，避免超过飞书三秒事件处理时限。进程重启会丢失内存队列与上下文；不能承诺跨任意故障恰好一次投递。

## 验收与排查

1. 日志出现 `feishu_connected`，仅表示长连接成功，不等于已完成事件订阅和权限审批。
2. 私聊「你好」，验证原消息出现 👀 表情、处理结束后切换为 ✅，并收到一条最终回答。
3. 群里 @机器人发送截图，确认能理解截图；引用上一条消息继续追问。
4. 测试 `stop`，确认原任务结束且不创建后续 Issue。
5. 用日志编号查 `feishu_received` / `feishu_accepted` / `feishu_finished`；`feishu_accepted` 的 `job` 可关联 Oryn 服务日志。

只连接不回复时检查：应用是否已发布、用户是否在可用范围、是否启用 `im.message.receive_v1`、是否获批相应权限、群消息是否 @了当前机器人，以及 chat allowlist。SDK 原始错误可能携带凭据，因此不会完整打印。

迁移时先停止旧机器的 `oryn-eyes-feishu.service`，再在新机器启用。同一个应用只运行一个飞书入口；飞书长连接多实例会随机分发事件，不会广播，内存上下文和 stop 路由也不会跨进程共享。QQ 入口可以独立保留。

官方依据：[Node SDK](https://github.com/larksuite/node-sdk)、[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)、[消息资源 API](https://open.feishu.cn/api-explorer?project=im&resource=message.resource&apiName=get&version=v1)。

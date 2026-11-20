# 让某个会话座席固定成「论文助手」

插件本身装在整个 profile 上：任何会话都能用到 `mcp__formatjiang__*` 工具、`formatjiang-paper` 技能与 `/formatjiang` 命令。

如果想把**某一个座席**固定成论文助手（例如「格式匠论文助手」这个会话只做论文，不掺别的活），做法是在 profile 的 `cordis.patch.yml` 里给预设（agent preset）加一行，把本插件挂进那个预设的 `plugins` 列表。

> 预设住在 profile 的组合里，不在插件包里：bundle 只能往根组合插入内容，改不了某个预设的插件清单。所以这一步必须由你在 profile 里改，插件没法替你写。

## 现有的预设长什么样

`cordis.patch.yml` 里每个预设都是一条 `@deepseek-ai/dsh-agent-preset` 行，`config.plugins` 是它的插件清单：

```yaml
- insert:
    - id: preset-ds-qq-bot1
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ds-qq-bot1
        name: 大肥鱼1号
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent powered by the {{model}} model.
          # …其余插件行
```

## 加一行就够

在目标预设的 `plugins` 列表里追加（位置随意，同一层即可）：

```yaml
          - id: formatjiang-assistant
            name: '@local/formatjiang-assistant'
            config:
              executablePath: ''
              installationId: ''
              dataDir: ''
              startupTimeoutMs: 90000
              toolCallTimeoutMs: 270000
```

如果想在这个座席里换个口吻，把 `persona` 行的 `prefix` 换成论文助手的定位即可，例如：

```yaml
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                You are a thesis assistant powered by the {{model}} model.
                你只处理用户已经导入格式匠的论文：套版、提交检查、资料与页码取证。
                连接状态不明时先调 formatjiang_status，不要在断线状态下反复重试业务工具。
```

## 装完怎么确认

1. 重启 DeepSeek Harness。
2. 在那个预设下新建会话，让它调用 `formatjiang_status`：返回「已连接」且工具数大于 0 即为挂上。
3. 如果它说「没有 mcpManager」，说明这个预设的插件清单里缺 `@deepseek-ai/dsh-mcp-client`（或对应的 mcp 管理器行）——补上后再试，插件自己不会插第二份。

## 这个座席能做什么、不能做什么

- 能：套版（预览 → 直接建分支）、提交检查与问题清单、知识库检索与页码取证、打开格式匠、重连与诊断信息。
- 不能：写作正文编辑（格式匠的 MCP 目录里没有这类工具）、论文导入、版本删除。这些操作仍要在格式匠界面里做。
- 写操作仍受格式匠自己的 `confirmation_token` 与 `safe_write` 约束，本插件不提供绕过任何一道的途径。
- 对话里不再为写操作征求同意：预览后直接执行。以「DeepSeek Harness」客户端类型接入的安装，结构快照确认也默认放行，不弹格式匠原生确认框；其他客户端类型仍逐次弹框。

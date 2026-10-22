# magpie-google-ai-studio

为 [Magpie](https://github.com/yetone/magpie) 接入 Google AI Studio 网页账号，将 Gemini JSON 和 SSE 请求转换为 AI Studio Playground 和 Build 的私有接口请求。

插件使用 `Bun.WebView`，不需要 Go、Python、Playwright、Puppeteer 或独立 API 服务。

## 安装

### 安装插件

在 Magpie Web 的"设置 → 插件 → Discover"中，找到"Have one in mind?"，输入 `magpie-google-ai-studio` 后点击 `Install`。命令行安装方式：

```sh
magpie plugin add magpie-google-ai-studio
```

也可以从 GitHub 安装：

```sh
magpie plugin add github:XYenon/magpie-google-ai-studio
```

选择一种安装方式即可。运行 `magpie plugin update` 可更新所有已安装的插件。

### 运行环境和登录

Magpie 会自动下载 Bun 来运行插件。插件需要 `Bun.WebView`，普通桌面或服务器还需安装 Chrome、Chromium、Edge 等 Chromium 浏览器。

在 Magpie 官方 Docker 镜像中，插件启动时会检查浏览器是否可用，缺少依赖时从镜像配置的 Debian 软件源下载 Chromium、字体和运行库。依赖解压到 `/config/cache/magpie-google-ai-studio/dependencies/`，不需要 root 或修改镜像。按官方建议挂载 `/config` 即可持久化依赖和账号会话。

首次安装需要联网，且容器用户必须能写入 `/config`。安装在后台进行，登录或请求会等待安装完成，后续启动会检查并复用已有依赖。Docker 中自动添加 `--no-sandbox` 和 `--disable-dev-shm-usage`。若设置了 `chromePath` 或 `BUN_CHROME_PATH`，插件会优先使用指定浏览器，无法启动时会报错。

安装后，在提供商页面添加 Google AI Studio 账号，或运行：

```sh
magpie plugin login google-ai-studio
```

选择"登录 Google AI Studio"，在打开的 Chrome 窗口完成登录和 AI Studio 首次使用设置，然后关闭窗口。插件会验证并保存会话，后续请求在后台运行。交互登录最多等待 10 分钟。

登录窗口出现在运行 Magpie 的机器上，使用独立的 Chrome 配置目录。远程服务器没有桌面时，可在有桌面的机器上登录，再迁移会话。

非 Docker 的 Linux 环境可安装发行版提供的 Chromium，例如 Debian：

```sh
sudo apt-get update
sudo apt-get install -y chromium
```

找不到浏览器时，可设置 `BUN_CHROME_PATH` 或 `chromePath`。

## 在两台机器之间迁移会话

两端安装本插件后，可以通过 Magpie Web 复制、粘贴迁移文本，也可以传输 `account.aistudio.json` 文件。目标机器可以没有桌面。

两种方式都包含账号名称、Google Cookie（包括 HttpOnly Cookie）和 AI Studio 的 localStorage、sessionStorage，不包含源机器路径或 Chrome 加密密钥。导入会创建新的本地 Chrome 配置目录。若 Google 已使凭据失效或要求额外验证，需要在源机器重新登录再导出。

### 在 Magpie Web 复制、粘贴迁移文本

1. 在源机器的 Magpie 中添加 Google AI Studio 账号，选择"导出可复制的会话迁移文本（Web）"。填写登录时的账号名称，只有一个本机会话时可留空。同名会话需使用文件方式导出。
2. 点击迁移文本旁的复制按钮，将完整文本私密传到目标机器。文本以 `aistudio-session:v1-` 开头，显示省略号不影响复制。
3. 在目标机器的 Magpie 中添加 Google AI Studio 账号，选择"粘贴会话迁移文本导入（Web）"，粘贴到密码输入框。验证成功后自动保存账号并读取模型列表。

导出使用 Magpie 的登录窗口，因此仍显示"登录链接"、`Code` 和 `Open again`。不要打开链接或点击 `Open again`。复制后在 `Code` 输入 `DONE` 并完成，也可以直接关闭窗口。

迁移文本没有加密，只做 gzip 压缩和十六进制编码，持有者可以使用其中的登录凭据。请私密传输，导入后清除剪贴板和临时副本。插件不将粘贴内容保存到账号元数据。

迁移文本上限为 60 KiB，解压后的 JSON 上限为 1 MiB，超限请使用文件迁移。插件会拒绝损坏、不完整或版本不支持的文本，验证失败时不会保存账号，并会清理新建的导入目录。压缩校验不能验证发送者身份，请只导入可信来源的文本。

### 从 Magpie 导出文件

首次登录时填写"可迁移会话包导出路径"，登录成功后会自动导出。已有账号可在 Magpie 中添加账号，选择"导入 Google AI Studio 会话／导出本机会话"，或运行：

```sh
magpie plugin login google-ai-studio 2
```

依次填写：

1. 源机器的 `account.session.json` 绝对路径。
2. 账号名称留空，保留原名称。
3. 导出路径，例如 `/config/account.aistudio.json`。

本机会话描述文件默认位于 `~/.local/share/magpie-google-ai-studio/<账号目录>/account.session.json`，官方 Docker 中为 `/config/home/.local/share/magpie-google-ai-studio/<账号目录>/account.session.json`。设置了 `MAGPIE_AISTUDIO_DATA_DIR` 时，以该目录为准。账号目录名是随机 ID，可查看描述文件中的 `accountId` 来识别账号。

导出会读取并验证当前浏览器会话，不需要 Google 密码或 API Key。文件包含明文凭据，Unix 权限为 `0600`，已有文件不会被覆盖。请私密传输，并使用新的导出文件名。Magpie 会按相同账号名称更新已有记录。

### 在目标机器的 Magpie 导入文件

将会话文件复制到目标服务器，在目标 Magpie 中选择"导入 Google AI Studio 会话／导出本机会话"，或运行 `magpie plugin login google-ai-studio 2`：

1. 输入目标机器上 `account.aistudio.json` 的绝对路径。
2. 账号名称留空即可沿用源账号名称，也可以改名。
3. 导出路径留空。

验证成功后自动保存账号并读取模型列表。文件入口也接受 AIStudio2API 的 `{ "cookies": [...], "origins": [...] }` storage-state JSON。

`account.session.json` 只引用本机目录，不能单独跨机器使用。跨机器请传输迁移文本或 `.aistudio.json` 文件，Magpie 的通用备份不包含插件登录凭据。

文件路径属于运行 Magpie 的服务器，Docker 中应填写容器内路径。Magpie Web 没有插件会话文件的上传或下载入口，文件需通过服务器传输或 `/config` 挂载目录取出和放入。若只使用 Web，请选择迁移文本方式。

## 配置

在 Magpie Web 的"设置 → 插件"中编辑选项 JSON，或修改 `plugins.json` 中本插件的 `options`。例如：

```json
{
  "chromePath": "/usr/bin/chromium",
  "timeoutMs": 180000
}
```

也可通过命令行配置：

```sh
magpie plugin options magpie-google-ai-studio '{"chromePath":"/usr/bin/chromium","timeoutMs":180000}'
```

### 插件选项

所有字段均可省略，`{}` 使用默认配置。

| 字段             | 类型           | 默认值                                                       | 说明                                                                                                                                                                                                                                                        |
| ---------------- | -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chromePath`     | 字符串         | 自动查找                                                     | Magpie 所在机器上的 Chromium 系浏览器可执行文件路径。优先于 `BUN_CHROME_PATH`；未指定时依次查找托管浏览器、`PATH` 中的浏览器及平台默认路径。官方 Docker 通常无需填写，插件会自动安装缺少的依赖。                                                            |
| `chromeArgs`     | 字符串数组     | `[]`                                                         | 追加到登录窗口及后台浏览器的启动参数。显式代理参数优先于自动代理。禁止以 `--user-data-dir`、`--remote-debugging` 或 `--headless` 开头的参数，账号目录、调试接口和运行模式由插件管理。官方 Docker 还会自动添加 `--no-sandbox` 和 `--disable-dev-shm-usage`。 |
| `bootstrapModel` | 字符串         | 账号目录中首个可用的 GenerateContent 模型                    | 初始化页面和 WAA 时使用的模型，不改变实际生成请求指定的模型。必须来自当前账号的 GenerateContent 目录，仅允许字母、数字、下划线、点和连字符，不带 `models/` 前缀；不可用时会报错。                                                                           |
| `timeoutMs`      | 数字，单位毫秒 | 浏览器进程通信和生成请求为 `180000`；页面内部请求为 `120000` | 覆盖上述可配置的超时，必须是有限数值且不小于 `1000`。不代表整个启动或登录过程的总时限；部分页面初始化等待使用固定超时，交互式登录最多等待 10 分钟。                                                                                                         |

### 环境变量

环境变量应设置在 Magpie 进程或 Docker 容器中，不写入选项 JSON。

| 变量                                                 | 默认值                                     | 说明                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUN_CHROME_PATH`                                    | 自动查找                                   | 浏览器可执行文件路径，插件选项 `chromePath` 的优先级更高。                                                                                                                                                |
| `MAGPIE_AISTUDIO_DATA_DIR`                           | `~/.local/share/magpie-google-ai-studio/`  | 创建和导入账号时保存会话及独立 Chrome 配置目录的位置。官方 Docker 默认为 `/config/home/.local/share/magpie-google-ai-studio/`；自定义到其他位置时需自行挂载以持久化。修改此变量不会自动移动已有账号目录。 |
| `XDG_CACHE_HOME`                                     | `~/.cache`；官方 Docker 为 `/config/cache` | 自动安装浏览器依赖的缓存根目录，依赖保存在其 `magpie-google-ai-studio/dependencies/` 子目录。                                                                                                             |
| `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` | 未设置                                     | 进程的 HTTP、HTTPS、通用代理及免代理规则，也接受对应小写变量。通过 Magpie 使用时，应优先在 Magpie 中配置代理，宿主会向账号进程传入实际选择的代理。                                                        |

### 代理

登录窗口和后台浏览器自动使用 Magpie 选择的全局、提供商或账号代理，也支持"直连"。修改代理后，下次请求会重启该账号的后台浏览器以应用配置，不需要重新登录。

独立命令行工具支持 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式。HTTP 和 HTTPS 代理可以包含用户名、密码，插件通过本机中转处理认证，不把自动代理的密码写入 Chrome 启动参数或会话包。Magpie 配置的 SOCKS 代理使用宿主提供的 HTTP 转接；独立运行时也支持不带认证的 SOCKS4、SOCKS5 代理。

若需单独设置浏览器代理，可在 `chromeArgs` 中填写 `--proxy-server=http://127.0.0.1:7890`，或指定 PAC、自动发现、`--no-proxy-server`。显式参数优先于自动配置。

## 请求流程

1. Magpie 把客户端请求转换为 Gemini 格式，调用插件的 `fetch`。
2. 普通聊天使用 Playground 的 MakerSuite 协议，工具、Schema、媒体和语音请求使用 AI Studio Build 的原生 Gemini JSON 转发。两种路径都由账号对应的 WebView 取得新的 WAA 证明。
3. WebView 在 AI Studio 页面内发送带 cookies 的原生 `fetch`，按需读取响应。
4. 插件返回 Gemini JSON 或 SSE。Build 路径保留原生响应中的工具结果、思考签名、引用来源和用量信息。

初始化时，插件会在临时聊天中填写一条初始化消息，并拦截提交请求，取得页面动态请求头和 WAA 服务。该初始化请求在页面内被阻止，不发送到生成接口。实际请求重新生成 WAA 证明及 SAPISID 签名。

交互登录期间不连接浏览器调试接口，关闭登录窗口后才通过 WebView 验证会话。插件禁用 Chrome 自身的账号登录，避免恢复的网页 Cookie 因缺少浏览器 OAuth 令牌而被清除，并等待 Chrome 退出后再读取会话存储。

AI Studio 会拒绝 Bun 默认无头 Chrome 的部分浏览器标记，即使账号已登录、模型列表可读取，生成接口仍可能返回 403。插件启动 Chrome 时关闭 `AutomationControlled` 标记，并从浏览器实际 User-Agent 中移除 `HeadlessChrome` 前缀，保留真实平台和版本，不固定伪造某个 Chrome 版本。

## 支持的功能

模型列表来自当前账号的 Playground 目录，暂时只列出输出为文本的会话模型。图片生成、TTS 和 embedding 模型暂不列出，等待 Magpie 支持模型用途分类，见 [magpie#3279](https://github.com/yetone/magpie/issues/3279)。底层调用接口仍保留下表中的功能。插件根据模型系列及目录能力声明输入输出类型，不使用固定的模型清单。每个模型能接受的工具、Schema 和媒体仍由 Google 服务端决定。

| 功能                       | 接口和行为                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 对话生成                   | `generateContent`、`streamGenerateContent`，支持系统指令、思考配置和签名回传。流中断会报错，不补造成功的完成帧。                                                                         |
| 函数调用                   | 支持 `AUTO`、`NONE`、`ANY`、`VALIDATED` 和 `allowedFunctionNames`，工具参数通过 `parameters` 或 `parametersJsonSchema` 原样交给服务端。`NONE` 会移除用户函数声明。                       |
| 结构化输出                 | 支持 `responseSchema` 和 `responseJsonSchema`。后者转换为网页接受的原生 `responseFormat`，保留 `$defs`、`$ref`、`additionalProperties` 和数值限制，交给服务端处理。                      |
| 图片、音频、视频、PDF 输入 | Gemini 聊天模型支持 `inlineData`，Magpie 的模型能力中也声明对应输入类型。`fileData` 会原样传递，但插件不替客户端上传文件或赋予远端文件访问权限。                                         |
| 图片和语音生成             | 使用账号可用的图片模型或 TTS 模型，通过 `responseModalities`、`speechConfig` 配置，返回原生 `inlineData`。                                                                               |
| 内置工具                   | 支持透传 `codeExecution`、`googleSearch`、`urlContext`、`googleMaps`，保留执行结果和引用元数据。可用性取决于模型。                                                                       |
| Embeddings                 | 支持 Magpie 的 OpenAI 格式 `/v1/embeddings`，以及插件内部的 Gemini `embedContent`、`batchEmbedContents`。支持批量、`dimensions`、`float` 和 `base64`，每批最多 100 条并保持输入顺序。    |
| Token 计数                 | 插件支持 Gemini `countTokens`，接受 `contents` 或 `generateContentRequest`，调用 AI Studio 的原生计数接口。                                                                              |
| 自动续写                   | Playground 模型目录声明续写能力时，插件使用服务端续写令牌继续生成，并合并 JSON 或 SSE 和用量。每轮最多 32768 个输出 token，到达调用方的 `maxOutputTokens` 后结束。Build 路径不模拟续写。 |

插件保留 Google 的原生 `promptFeedback` 拦截说明，包括搜索可能返回的 `PROHIBITED_CONTENT`。响应既无候选答案，也无明确拦截原因时，插件会报错。

原生 Gemini 请求示例，模型名称需替换为账号目录中支持相应功能的模型：

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "调用 lookup，查询编号 7。" }] }],
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "lookup",
          "parametersJsonSchema": {
            "type": "object",
            "properties": { "id": { "type": "integer" } },
            "required": ["id"],
            "additionalProperties": false
          }
        }
      ]
    }
  ],
  "toolConfig": { "functionCallingConfig": { "mode": "ANY", "allowedFunctionNames": ["lookup"] } }
}
```

Magpie 的 embeddings 请求正文示例：

```json
{
  "model": "google-ai-studio/gemini-embedding-001",
  "input": ["第一段文本", "第二段文本"],
  "dimensions": 128,
  "encoding_format": "float"
}
```

### 尚不能完整提供的接口

插件尚未提供以下接口。探测结果不能证明 Google 完全不支持它们。

| 接口          | 已观察到的结果和剩余限制                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files / Drive | 当前账号通过 Build 列举 Files 返回 403，获取 Drive 访问令牌返回 401。当前 Magpie 也没有将 Files 上传请求交给该插件的入口，媒体可先使用 `inlineData`。                                                                     |
| 显式缓存      | 当前账号列举缓存返回 403，创建缓存返回 404，未取得可用的缓存资源。普通对话不受影响。                                                                                                                                      |
| Live          | 已取得网页 WebChannel 握手响应，但尚未验证完整实时生成。当前 Magpie 的 provider 插件没有双向 WebSocket 转发入口。                                                                                                         |
| Veo           | 私有生成接口曾返回 operation，但查询结果返回 `401 unauthorized_client`，未能取得视频。当前 Magpie 的通用视频路由也不调用这类账号插件。                                                                                    |
| Interactions  | 私有 `CreateInteractionStream` 已返回文本 `OK`，说明网页接口可用。Build 的公开格式路径返回 404，当前 Magpie 没有对应接口和事件转换契约，插件尚未实现这条独立协议。仅支持 Interactions 的模型不列入 GenerateContent 目录。 |

AI Studio 私有接口会变化，网页的 DOM、动态请求头或 WAA 服务变化时，可能需要更新插件。Google 返回的权限、限流和服务错误会交给 Magpie 处理，插件不自动重试生成请求。

## 开发和验证

克隆仓库后安装开发依赖，并运行检查：

```sh
git clone https://github.com/XYenon/magpie-google-ai-studio.git
cd magpie-google-ai-studio
bun install --frozen-lockfile
bun run check
AISTUDIO_WEBVIEW_TEST=1 bun test test/webview.test.ts
```

`bun run check` 运行代码检查、格式检查、markdownlint、类型检查和默认测试，GitHub CI 使用相同命令。Biome 负责 TypeScript 和 JSON，Prettier 负责 Markdown 和 YAML，两者不重复格式化同一类文件。

代码沿用双引号、分号、两空格缩进和 110 列行宽。Biome 警告会导致检查失败，条件内赋值和非空断言允许使用。markdownlint 使用默认规则，仅关闭行长限制，保留中文段落和配置表格的原有换行。

| 命令                             | 用途                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `bun run lint`                   | 检查代码、格式、import 顺序和 Markdown，不修改文件。              |
| `bun run lint:markdown`          | 单独运行 markdownlint。                                           |
| `bun run lint:fix`               | 整理 import、应用安全的代码修复及 Markdown 修复，然后格式化文件。 |
| `bun run format`                 | 格式化 TypeScript、JSON、Markdown 和 YAML。                       |
| `bun run typecheck` / `bun test` | 单独运行类型检查或默认测试。                                      |

EditorConfig 统一 UTF-8、LF 换行和文件末尾换行，Markdown 保留尾随空格。VS Code 推荐 Biome、Prettier 和 markdownlint 扩展，并按文件类型配置保存时格式化与修复。所有检查工具都遵循 `.gitignore`，不处理会话文件或 `.amp/` 中的产物。

本地开发时，可通过 `magpie plugin add /absolute/path/to/magpie-google-ai-studio` 安装工作目录。

默认测试不启动浏览器。最后一条命令使用 Chromium 和本地模拟服务，验证传输、签名、流式读取、取消、会话迁移和代理配置。迁移测试需要 `openssl` 生成本地 HTTPS 证书，不需要 Google 账号。

在能访问 Docker daemon 的 Linux 环境中，可验证官方镜像的依赖安装：

```sh
AISTUDIO_DOCKER_TEST=1 bun test test/dependencies.test.ts
```

测试以官方镜像的默认非 root 用户检查依赖安装、代理故障恢复、重建容器后断网复用 `/config` 卷及缺失运行库的修复，并通过 WebView 操作验证浏览器。测试不使用 Google 账号，结束后会删除专用测试卷。

使用已登录的账号进行真实生成检查：

```sh
bun run smoke /path/to/account.session.json <model-id>
```

该命令读取模型列表并请求一次简短的流式回答，用于验证真实账号链路。本地模拟服务只能验证传输逻辑，无法证明 Google 会接受当前会话的 WAA 证明。

## 许可证

Copyright (C) 2026 XYenon and contributors.

本项目按 [GNU Affero General Public License 第 3 版或任何后续版本](https://www.gnu.org/licenses/agpl-3.0.html)（`AGPL-3.0-or-later`）发布，完整许可见 [LICENSE](LICENSE)。AIStudio2API 的 MIT 版权和许可声明保留在 [NOTICE](NOTICE) 中。

## 参考

私有协议及 WAA 流程参考 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)。标准接口参考 [Google Gemini API](https://ai.google.dev/api/generate-content)，插件契约参考 [Magpie 文档](https://github.com/yetone/magpie/blob/main/site/public/docs/plugins.html)。上游许可见 [NOTICE](NOTICE)。

# ChatDrop

受微信文件传输助手启发的本地文本与文件传输工具。

## 功能

- 密码保护的网页登录
- 可选 30 天自动登录，并在活跃访问时自动续期
- 左侧会话列表，右侧消息与文件流
- 支持发送文本、图片和任意文件
- 支持在输入框中直接粘贴剪贴板图片上传
- 文件保存到本地磁盘，元数据存储在 SQLite

## 环境要求

- Node.js 24+

## 快速开始

```bash
npm install
npm start
```

打开 [http://localhost:3000](http://localhost:3000)。

## 后台服务

```bash
./chatdrop.sh start
./chatdrop.sh restart
./chatdrop.sh status
./chatdrop.sh logs
```

- PID 文件：`data/run/chatdrop.pid`
- 日志文件：`data/logs/chatdrop.log`

默认本地配置在 `config.yaml`：

- 密码：`changeme`
- 工作目录：`./data`

程序会基于 `workspace_dir` 自动派生这些路径：

- 文件目录：`<workspace_dir>/files`
- 数据库：`<workspace_dir>/db/chatdrop.sqlite`
- PID：`<workspace_dir>/run/chatdrop.pid`
- 日志：`<workspace_dir>/logs/chatdrop.log`

如果服务需要暴露到局域网或公网，先修改默认密码，并建议配合 HTTPS、限流和其他安全加固。

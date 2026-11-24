# 订阅共享资料库

链接导入、RSS 自动导入、RSS 日报周报和知乎文本在获取正文前按规范化来源地址查公开资料库。命中时从固定 Git 提交下载正文并核对 SHA-256，再交给既有阅读加工流程。新增公开 RSS 原稿须由同步服务在当前公开 feed 中确认条目，再独立读取正文。仅能通过登录取得或无法独立核验的条目继续本机处理，回执保留 `local_only` 和原因。B 站的字幕与视频处理仍沿用本机入口。

订阅页的「共享资料库」默认开启。关闭后，新材料走本机导入。已登录的订阅用户由服务器代写主分支，匿名投稿由同一服务器代提 PR。已发表材料可以直接匿名复用。待合并条目有 PR 链接，队列会继续检查主分支。

`index/articles/` 按来源地址索引原稿和加工版本。同步服务通过 GitHub Contents API 按选定的提交读取。快进写入遇到并发时重新核对索引。匿名投稿分支按来源生成，重复投稿复用同一 PR。[公开订阅索引](https://github.com/memoedu/progressive-reading-library/blob/main/index/subscriptions.json)只记录公开来源地址。Thoughts Memo 译文的索引保留上游许可证、固定提交、目录及 Git blob 哈希。

完成导入且可关联公开原稿时，已登录的客户端可同步本次生成的译文和带导图卡的 Markdown。读取区正文、批注和本机运行包保留在本机。可选择加工类型和文件哈希下载固定版本。省略 `--sha256` 时选择该类型最后登记的版本。

```powershell
node subscription-workflow/cli.mjs download-shared-version --url '<原稿链接>' --kind translation --output '<新文件.md>'
```

`index/materials/` 按 SHA-256 索引原始 PDF、EPUB、DOCX 和 TXT。服务器根据已核验的公开地址、字节数和 SHA-256 重新下载原件，再将文件存入 `原材料/<格式>/`。没有公开来源凭据的本机原件留在本机。同步命令从资料库下载并核验原材料，已有输出文件按原样保留。

```powershell
node subscription-workflow/cli.mjs sync-shared-material --sha256 '<原件哈希>' --output '<新文件.pdf>'
```

## 服务器配置

独立同步进程在 127.0.0.1:43182 运行，经 HTTPS 路由访问。部署文件见 [systemd 单元](../subscription-workflow/deploy/shared-library.service) 和 [nginx 片段](../subscription-workflow/deploy/shared-library.nginx.conf)。源文件和依赖从已验证的 Git 提交构建。生产配置由 systemd LoadCredential 读取，路径为 /etc/progressive-reading-sync/config.json。

服务器配置字段包括 `port`、`trust_proxy`、`gitleaks`、`accounts`、`session_secret`、`private_email_sha256` 和 `github`。`github` 包含 `appId`、`installationId`、`keyPath`。将 GitHub App 安装到公开资料库并授予 Contents 和 Pull requests 写权限。私钥通过 systemd 独立凭据提供。账号记录的 salt 和 hash 由 `createSharedAccount` 生成。移除或替换账号后，重启同步进程使对应会话失效。`trust_proxy` 只用于由 nginx 覆盖 X-Real-IP 的回环部署。

将[来源配置示例](../config/shared-library-server-sources.example.json)的字段合并到服务器配置。`public_rss` 声明公开 feed、可接受的文章域名和分类目录。`public_materials` 的每条记录包含 `url`、`extension`、`sha256` 和 `bytes`，并可用 `article_url` 关联文章索引及加工版本。仅登记已验证的匿名原件下载地址，单件不超过 25 MiB。

客户端将 [配置示例](../config/subscription-library-sync.example.json)保存到工作流数据根目录的 .local-ir/subscription-library-sync.json。使用账号时通过订阅页登录，会话绑定所配置的 HTTPS endpoint。

缺少服务器写入配置时，健康接口的 write_available 返回 false。此时可校验现有索引和匿名下载，实际新材料发布待写入配置就绪后启用。

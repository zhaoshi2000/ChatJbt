# 技术设计参考（官方来源）

查阅日期 2026-09-20。以下文档用于核实浏览器行为边界，不代表项目已获得官方认证或在真实浏览器完成验收。

1. Chromium — User Data Directory
   https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md
   用户数据目录包含 Cookie 等 profile 数据；Windows 可通过 `--user-data-dir` 指定目录。用于解释不同账户要采用独立 profile/user-data directory，而不是多个普通标签页。

2. Chrome — The extension service worker lifecycle
   https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
   后台可能因空闲/执行时限终止；应持久化重要状态并能够恢复。本项目选择持久 outbox、任务快照、启动校验，而不是承诺“永不休眠”。

3. Chrome — storage API
   https://developer.chrome.com/docs/extensions/reference/api/storage
   storage.local 持久状态与 storage.session 的不同生命周期。扩展不从 Chrome Sync 获取账号绑定；代码将 local 存储访问级别限制为可信扩展上下文。

4. Chrome — tabs API
   https://developer.chrome.com/docs/extensions/reference/api/tabs
   创建/更新标签页与 autoDiscardable。数字标签页 ID 不应当作为可跨浏览器重启持续使用的账号标识。

5. Chrome — Manage Chrome with multiple profiles
   https://support.google.com/chrome/answer/2364824?hl=en
   多个浏览器 profile 的概念与不同用户资料；这种分离不替代操作系统用户隔离。

6. Microsoft Edge — UserDataDir policy
   https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/UserDataDir
   Edge 可通过 --user-data-dir 指定配置目录，但强制 UserDataDir 策略优先。启动脚本只读检查相关注册表策略；发现强制目录时拒绝启动，避免误将 A/B 放进同一目录，不修改策略。

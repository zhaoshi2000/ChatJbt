# 逗包 v1.2.0 测试报告

执行日期：2026-09-20。工程基于用户本轮可访问的 `Doubao-WebBridge-v1.1.0.zip`，测试结果仅对应本包 v1.2.0。

## 实际执行结果

| 测试层 | 结果 | 实际验证内容 |
|---|---|---|
| Java 21 构建 | 通过 | 公共 JSON 工具、后端、任务库、工作区库编译；静态网页打入 out/backend.jar |
| JSON 编解码 | 16 条断言通过 | Unicode、长整数、嵌套、重复键拒绝、非法 JSON、非有限值拒绝 |
| Node 核心 / worker / 本机网页桥接 | 31 项测试通过 | 原有完成检测/SSE UTF-8、双 lane 调度、独立 outbox、错误页面/文档/账号拒绝、重新唤醒恢复、非本机消息拒绝、无侧边栏入口 |
| 真 Java HTTP 集成 | 15 项 unittest 场景通过 | 账号 ACL、跨账号列表/正文/SSE/取消/删除拒绝、账号管理权限、并发提交竞争、按会话幂等、profile/lease/seq 防串写、同账号并行上限、B 不等待离线 A、重启与旧归档 |
| 离线 Chromium UI / DOM | 14 项场景通过 | 同账号两网页+另一账号网页三路回复、独立草稿/会话选择、重建页面恢复、丢 ACK 重试、同会话双观察者、XSS 文本渲染、手机布局、管理令牌清理、双内容脚本搜索等待与最终回复替换 |

Node 原始输出：`test-logs/node.txt`；Java JSON：`test-logs/json.txt`；HTTP：`test-logs/http.txt`；离线 UI 清单：`test-logs/ui-results.json`，控制台输出 `test-logs/ui.txt`。

这些“通过”是不同层级的测试，不应相加解释为多个真实账号实测。HTTP 场景包括同一场景内的多个子断言；上表不把子断言另外算作独立测试数。

## 测试环境

Linux 容器；OpenJDK 21.0.11；Node v22.16.0；Python 3.13；Python Playwright 驱动已安装的 Chromium。当前 Chromium 受托管策略限制，禁止安装扩展、实际网页导航及创建真实多配置文件。因此：

- 使用浏览器 `set_content` 展示真实 HTML/CSS/JS，没有绕过或删除企业策略。
- 生产 ESM 通过测试脚本拼接加载，仅把导入导出连接、origin/history、存储与 transport 替换为明确的离线测试适配层。真正业务代码执行，后端调用是真实 Java HTTP。
- 账号 A/B、聊天内容、搜索阶段和最终回答均为合成测试数据。
- Node VM 中运行真实 background.js，Chrome 的 storage/session/tabs/runtime/alarms 由测试替身模拟。测试不是浏览器真实 Service Worker 休眠验收。
- 内容采集脚本运行在 `chatgpt-fixture.html` 测试 DOM 中，不读取真实账号；两个独立 DOM 分别提交到真实后端的不同账号/会话/租约。
- UI 流式 transport 通过后台 HTTP 快照生成可读流；真实 HTTP SSE 的双观察者行为另由 HTTP 集成用例验证。

## 测试过程发现并修正

网页每 4 秒刷新列表与 SSE 同时到达时，旧 HTTP 快照曾可能覆盖较新流式版本；现按任务 version 比较，不回退正文。空正文任务状态从排队变为执行时，提示文案现在同步刷新。

UI 管理弹窗关闭事件为异步，测试改为等待真实 close 完成再断言字段清空，不依赖固定 150 ms 假定。测试夹具的搜索/结束状态名也已与现有 fixture 一致，分别为 `searching` 和 `complete`。

## 尚未验收，不能声称通过

1. Windows 10/11 上 `.bat`/PowerShell 脚本执行、路径空格、Edge/Chrome 不同安装位置与企业配置。
2. 真正通过 `--user-data-dir` 建立 A/B 窗口、手动安装扩展、保留独立 Cookie 与登录、跨机器/配置文件升级。
3. 两个或更多真实已登录 ChatGPT 账号同时对话、真实搜索/思考/长回答、真实界面变动和限流。
4. MV3 后台被真实浏览器终止、整浏览器崩溃、操作系统睡眠、多天运行、大量会话性能、磁盘满/断电等故障。
5. 真实 OpenAI API 额度、模型可用性、流式计费及生产运行；这一分支仅保留源码兼容。
6. Chrome Web Store / Edge Add-ons 商店审核、签名安装包、Windows EXE。

## 建议的真机验收顺序

先以两个独立浏览器配置文件安装本包扩展，A/B 各创建并配对专属令牌，手动登录对应上游账号。A 窗口开两个本地新会话，B 窗口开一个。分别发不同问题，核对上游标签页、历史和回答归属。然后分别测试普通网页刷新、同会话另页查看、取消 A 而 B 继续、关闭一个工作页并按原地址恢复、停止后端再启动。确认正常后再增加并发量。

截图 `screenshots/*` 来自上述受控浏览器渲染；不是样机设计图，也不是用户实际账号截图。

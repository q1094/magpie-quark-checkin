# quark-checkin

夸克网盘接进 **magpie / OpenCode**：**一条 App 抓包 URL** 就能读空间占用 + 每日签到领空间。

> **这里没有 LLM。** 夸克网盘不提供任何大模型，插件注册的 `quark` 供应商模型列表**永远为空**（`config` 钩子里 `models: {}`），既不转发请求也不代理 API。
> 用 magpie 纯粹是为了两件事：**在面板/`magpie quota` 里看空间占用**，以及**让 magpie 的每日调度去跑签到**（不用自己养 cron、不用 GitHub Actions）。包装成插件只是借用它的账号存储与定时器。

```
magpie plugin add github:q1094/quark-checkin
magpie plugin login quark     # 选第一种：粘一条抓包 URL（不用装浏览器、不用手机抓第二个接口）
magpie quota                  # quark · 普通用户 · 空间 79.7% ↻…
```

开发时也可以直接加载本地文件夹（免安装、改完重载即生效）：`magpie plugin add ./quark-checkin`。

## 一条 URL 能拿到什么（2026-11-12 实测）

在 App 里对 `drive-m.quark.cn/1/clouddrive/capacity/growth/info` 抓一张，整条 URL 粘进来，`data` 里直接就有：

| 字段 | 值（真实账号实测） | 用在哪 |
| --- | --- | --- |
| `total_capacity` | 10926161920 | 空间总量 |
| `use_capacity` | 8713460952 | 已用（**使用量就在这**，不用再调别的接口） |
| `member_type` | `NORMAL` | 卡片上的「普通用户」 |
| `cap_sign` | `{sign_daily, sign_progress, sign_target, sign_daily_reward, …}` | 今日签没签、连签进度、今天能领多少 |
| `cap_growth` | `{cur_total_cap, cur_total_sign_day}` | 签到累计容量、累计签到天数 |
| `cap_composition` | `{member_own, sign_reward}` | 签到至今一共换来多少空间 |

所以**不需要浏览器登录，也不需要 cookie** —— 这正是之前「网页登录」那条链路做不到的部分。

另外实测确认的几条边界（别再试了，都跑过）：

- **只留 `kps` / `sign` / `vcode` 三个参数就够**：抓包 URL 里那堆 `uc_param_str`、`ut`、`mt`、`ni`、`dn`、`sn`、`pc` 可以全丢，返回的 `data` 一模一样；
- **`kps/sign/vcode` 可以反复用**（同一天多次请求、跨接口请求都正常），不是一次性票据；
- **已经签到过再 POST** `/growth/sign` 返回 `HTTP 400 code 44210 cap_growth_sign_repeat` —— 这是「今天已签」，按 `done` 处理，不是失败；
- **App 凭证打 `drive-pc`（PC 侧）是 401 `require login [guest]`**，只能打 `drive-m`；
- **网页 cookie 打 `drive-m` 也是 401**：`__kps`(24B)、`__pus`、`__puus`、`/account/info` 里的 `mobilekps`(112B) 当 `kps` 参数都试过，配移动端 UA、配假 `sign`/`vcode` 全是 401；
- **网页端没有签到功能**：`pan.quark.cn` 页面里搜「签到 / 领空间」0 处命中，PC 侧 `growth/info` 恒返回 `data:{}`；
- `member_info` 里没有昵称，`/account/info` 用 App 参数读也是空 —— 所以账号名用创建时间（`created_at`）当稳定标识，卡片 `user` 留空。

由此得到两条链路的分工：

| | App 凭证（推荐） | 网页 cookie（备选） |
| --- | --- | --- |
| 空间总量 / 已用 | ✅ 一个接口 | ✅ |
| 签到累计 / 连签 / 今日签到 | ✅ | ❌ |
| 每日签到 | ✅ | ❌（401） |
| 登录态有效期 | ❌（凭证没有到期时间，只能显示「几天前抓的」） | ✅（cookie 到期） |
| 要人工做什么 | 抓一次 URL（约 2 个月重抓一次） | 扫码登录一次（14 天自动续） |

## 登录一：App 抓包 URL（推荐）

在 Windows 上装 **MuMu 模拟器（开 Root）+ ProxyPin（装系统证书）** 就能抓，不需要实体手机（新版夸克 App 对用户级 CA 校验很严，实体机反而要先 Root）。

1. 模拟器里装夸克 App、登录，进「我的 → 空间 / 签到」，点一下签到或进空间页；
2. ProxyPin 里找 `drive-m.quark.cn/1/clouddrive/capacity/growth/info`；
3. **整条 URL 原样复制**（`kps`、`sign`、`vcode` 都在里面，多余参数插件会丢掉）；
4. `magpie plugin login quark` → 选第一项 → 粘进去。

认证时会先真跑一次 `growth/info`：能用才算登录成功，并把规范化后的 URL 存成账号的 key。

不想粘到登录流程里也行，写文件：

```json
// ~/.quark/app-params.json（QUARK_APP_PARAMS_FILE 可改路径；一行一条，# 开头是注释）
{"url": "https://drive-m.quark.cn/1/clouddrive/capacity/growth/info?…&kps=…&sign=…&vcode=…"}
```

> **别用 URLSearchParams 拆这条 URL**：它把字面量 `+` 当空格，而 `kps`/`sign` 里就有 `+`，一转就废。插件自己按 `&`、`=` 拆，只做 percent-decode（上游项目踩过这个坑，这里照抄了它的修法）。

## 登录二/三：网页（只读空间）

- **夸克网页登录（受控浏览器）**：插件弹出自己的浏览器窗口（持久 profile `~/.quark/web-profile`），扫码或短信登录一次。能读空间和「登录态还剩多久」，**但签到需要 App 参数**（这一问里可以顺手粘一条 URL）。
- **手填网页 Cookie**：F12 复制 `pan.quark.cn` 的整段 Cookie。同样只能读空间，且拿不到到期时间。

受控浏览器用的是系统已装的 Chrome / Edge（`playwright-core` 在 `optionalDependencies`，不下载浏览器）。登录完成后窗口自动关闭，之后读用量**不会再开浏览器**。

### 网页登录态会自己续

长期票据（`__pus` / `__kps` / `__uid` / `b-user-id`，一般 14 天）到期前 **26 小时**，magpie 会调 `auth.refresh`：静默开一次 profile 访问 `pan.quark.cn`，把新 cookie 写回账号；读用量撞见 401 时也会续一次（同账号一小时最多一次），续不上才报「失效」。短票据 `__puus` 只有 1 天但访问网页即刷新，所以卡片按长期票据算。

## 卡片长什么样

App 凭证（推荐路径）：

```
quark · 普通用户
空间        8.12 / 10.18 GB · 79.7%
签到累计    180 MB · 连签 1/7 · 共 8 天
今日已签到   +20 MB
凭证        今天抓的（失效后重抓一次）
```

网页登录：

```
空间        8.12 / 10.18 GB · 79.7%
登录态      还剩 13 天（2026-11-26 16:26:58 到期，网页票据到期前会自动续）
```

- 「空间」是唯一带百分比条、会被当成「用满」的窗口（不设 `aside`），给的是 `used` + `amount` + `limit` + `unit`，**不是**把数字塞进 `display` 字符串——那样 magpie 画不出条，也没有历史曲线；
- 其余都是文字行（`aside: true`）：读数用满不代表账号不能用，菜单栏默认也不显示；
- 保险箱（`secret_*`）实测和总量一模一样，不是独立配额，所以只在真不同时才多画一行。

## 每日签到

magpie 每个北京日会给每个已登录账号调一次 `auth.checkin`，不用自己养 cron：

1. `growth/info`：`cap_sign.sign_daily === true` → `done`；
2. 否则 POST `/growth/sign`（`{"sign_cyclic":true}`）→ `claimed` + 今天的奖励；
3. 返回 `44210 cap_growth_sign_repeat` → `done`（别人/App 已经签过了）；
4. POST 结果不确定 → **复查一次** `growth/info`，确认签上了就报 `claimed`，不谎报失败；
5. 没有凭证 → `ineligible` 并说明去哪儿补（不会静默失败）。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `QUARK_APP_PARAMS_FILE` | `~/.quark/app-params.json` | 签到参数文件（`QUARK_APP_PARAMS` 也能直接给内容） |
| `QUARK_WEB_PROFILE` | `~/.quark/web-profile` | 受控浏览器的 profile（登录态在这儿，删掉等于退出登录） |

## 测试

```sh
npm test     # node --test test/offline.test.mjs —— 18 项，全离线
```

覆盖：`+` 号不被吃掉、四种参数形状、账号记录优先于文件、两条链路按 key 前缀分流、空间百分比与文字行、保险箱去重、App 凭证一个接口读齐、401 如实失效、网页 cookie 401 自动续期并写回账号、签到 `claimed`/`done`/`ineligible`/`44210 repeat`/参数失效/POST 无奖励但复查已签。

## 已知限制

- **抓包凭证会过期**（大致一到两个月）：签到突然一直 `failed`、卡片显示「凭证 N 天前抓的」时，重抓一次即可。空间那半同样受影响（都走同一个接口）。
- **没有昵称**：App 侧所有接口都不返回昵称，卡片 `user` 为空、账号标识用 `created_at`，重复抓包会替换同一账号而不是多加一个。
- 受控浏览器的 profile 被强杀后可能起不来：报错会写「删掉 `~/.quark/web-profile` 再登录一次」。
- 与夸克官方无关联；不绕过任何计费，签到的空间是账号本身该领的。

## 参考的上游

签到接口不是这个项目发现的：下面几个仓库已经在跑同样的接口（大多是 Python/QX 脚本 + GitHub Actions 或青龙面板的形态）。本仓库**没有复制它们的代码**，只是照着它们的经验重写了一个 magpie 插件（下面标了具体借鉴了什么）。

| 项目 | 借鉴了什么 / 结论 |
| --- | --- |
| [Liu8Can/Quark_Auto_Check_In](https://github.com/Liu8Can/Quark_Auto_Check_In)（MIT） | **主要参考**。唯一还在维护的（313★，2026-11-05 仍有提交）、本机跑过它的 CI 单测 13 项全绿。借鉴：`growth/info` / `growth/sign` 两个接口的用法、支持新版「整条 URL」形式的凭证、用 `&`+`=` 手拆 query（`URLSearchParams` 会把字面量 `+` 当空格）、签到后复查避免误报失败 |
| [whi3e55/Quark_Auot_Check_In](https://github.com/whi3e55/Quark_Auot_Check_In) | Liu8Can 那支的早期版本，2024-11 之后没动过。只用来确认接口形态的历史 |
| [Cp0204/quark-auto-save](https://github.com/Cp0204/quark-auto-save) | 3.1k★，主力是转存/整理，签到只是附带的。参考了它「扫码拿网页登录态」的思路（本仓库的备选登录方式） |
| [carlleilzj/Quark_CheckIn_QX](https://github.com/carlleilzj/Quark_CheckIn_QX) | Quantumult X 脚本，思路相同：先存参数、每天定时打同一个接口。没有额外信息增量 |

想直接跑签到脚本（不进 magpie）的话，推荐去用 Liu8Can 那个，功能比这里全（多账号、防失效保活等）。

## License

MIT。上游参考项目各自保留自己的 License；本仓库代码为重新实现。
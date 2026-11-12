// 夸克网盘 in magpie / OpenCode：一条 App 抓包 URL 就能读空间占用 + 做每日签到。
// 这里没有 LLM：供应商模型表恒空，只用 magpie 的账号存储、用量卡和每日 checkin 调度。
//
// 2026-11 实测（见 README「实测记录」）：
//   · App 抓包 URL（kps/sign/vcode）打 drive-m /capacity/growth/info：
//     total_capacity、use_capacity、member_type、cap_sign、cap_growth、cap_composition
//     全在里面 —— 空间占用和签到状态一个接口就够，不需要浏览器、不需要 cookie。
//     而且只留 kps/sign/vcode 三个参数就够（uc_param_str/ut/mt/ni 这些可以丢）。
//   · 网页登录态（受控浏览器扫码）读 drive-pc /member 也有 total/use，但 growth/info
//     恒返回 data:{}、网页版页面里也没有签到入口 —— cookie 那条链路签到做不到。
//   · 移动端接口不认网页 cookie（401 require login [guest]），所以签到只能用 App 凭证。
//
// 因此：默认走 App 凭证；网页登录保留成备选（只想看空间、不想抓包时用）。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { formatLocal, formatRemain, readWebSession, sessionFromCookies } from "./web.mjs"

const PROVIDER = "quark"
const PROVIDER_NAME = "夸克网盘"
const NPM = "@ai-sdk/openai-compatible"
const API_BASE = "https://drive-pc.quark.cn"

const GROWTH_INFO = "https://drive-m.quark.cn/1/clouddrive/capacity/growth/info"
const GROWTH_SIGN = "https://drive-m.quark.cn/1/clouddrive/capacity/growth/sign"
const APP_MEMBER = "https://drive-m.quark.cn/1/clouddrive/member"
const WEB_MEMBER = "https://drive-pc.quark.cn/1/clouddrive/member"
const WEB_MEMBER_QUERY = "pr=ucpro&fr=pc&uc_param_str=&fetch_subscribe=true&fetch_identity=true"

const UA_PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Quark/4.0.0"
const UA_APP =
  "Mozilla/5.0 (Linux; Android 13; PGT-AN10 Build/HONORPGT-AN10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Quark/6.8.5.461 Mobile Safari/537.36"

const REFRESH_LEAD_MS = 26 * 60 * 60 * 1000 // 网页长期票据一般 14 天，提前一天续
const RENEW_MIN_MS = 60 * 60 * 1000 // 同一个账号一小时内最多真去开一次浏览器
const SIGN_REPEAT = 44210 // cap_growth_sign_repeat：今天已经签过了

/** App 签到参数文件：不想在登录时粘 URL 的话，写这里也行。 */
function appParamsFile() {
  return process.env.QUARK_APP_PARAMS_FILE || process.env.QUARK_APP_PARAMS || join(homedir(), ".quark", "app-params.json")
}

const lastRenew = new Map()

// ---- 参数解析 ---------------------------------------------------------------

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)
const gb = (n) => Math.round((Number(n) / 1024 ** 3) * 100) / 100
const mb = (n) => Math.round(Number(n) / 1024 ** 2)

/** 1024 进制的人读写法：1.25 GB。 */
function fmtBytes(n) {
  const v = Number(n) || 0
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${Math.round(x * 100) / 100} ${units[i]}`
}

function decode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 自己拆 query：不能用 URLSearchParams —— 它把字面量 `+` 当空格，
 * 而抓包 URL 的 kps/sign 里就有 `+`，一转就废（上游项目踩过这个坑）。
 */
function parseQuery(qs) {
  const out = {}
  for (const part of String(qs ?? "").split("&")) {
    if (!part) continue
    const i = part.indexOf("=")
    const key = decode(i < 0 ? part : part.slice(0, i))
    const value = i < 0 ? "" : decode(part.slice(i + 1))
    if (!(key in out)) out[key] = value
  }
  return out
}

const pick3 = (o) => {
  if (!o) return null
  const out = { kps: String(o.kps ?? ""), sign: String(o.sign ?? ""), vcode: String(o.vcode ?? "") }
  return out.kps && out.sign && out.vcode ? out : null
}

/**
 * 把用户粘进来的东西变成 {kps, sign, vcode}。四种形状都认：
 *   1. 整条抓包 URL（drive-m…/capacity/growth/info?...&kps=&sign=&vcode=）
 *   2. `user=xx; kps=…; sign=…; vcode=…`（可以只放一条 url=…）
 *   3. JSON：{"url":…} / {"kps":…,"sign":…,"vcode":…}
 *   4. 已经是 {kps, sign, vcode} 的对象
 */
function parseParams(raw) {
  if (raw && typeof raw === "object") {
    const direct = pick3(raw)
    if (direct) return direct
    return parseParams(raw.url || raw.cookie || raw.params || "")
  }
  const text = String(raw ?? "").trim()
  if (!text) return null

  if (text.startsWith("{")) {
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      return null
    }
    if (!json || typeof json !== "object") return null
    const inner = json.url || json.cookie || json.params || json.COOKIE_QUARK || json.value || ""
    return parseParams(inner) || parseParams(json)
  }

  const fields = {}
  for (const part of text.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    const key = part.slice(0, i).trim()
    if (key) fields[key] = part.slice(i + 1).trim()
  }

  const url = fields.url || (text.startsWith("http") ? text : "")
  const merged = url ? parseQuery(url.split("?").slice(1).join("?")) : {}
  for (const k of ["kps", "sign", "vcode"]) if (fields[k]) merged[k] = fields[k]
  return pick3(merged)
}

/** 账号记录（App URL 或 metadata）优先，其次参数文件（一行一条，# 开头当注释）。 */
function resolveParams(auth, { file = appParamsFile(), readFile = (f) => readFileSync(f, "utf8") } = {}) {
  const meta = auth?.metadata ?? {}
  for (const candidate of [auth?.key, meta.appParams, meta.appUrl, meta.credential, meta.url]) {
    const p = parseParams(candidate)
    if (p) return p
  }
  const direct = pick3(meta)
  if (direct) return direct

  let text = ""
  try {
    text = String(readFile(file) ?? "")
  } catch {
    return null
  }
  const whole = parseParams(text)
  if (whole) return whole
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith("#")) continue
    const p = parseParams(s)
    if (p) return p
  }
  return null
}

/** 规范化成一条能直接发的 URL：参数只留 kps/sign/vcode，多余的全丢。 */
function appUrl(base, p, extra = "") {
  return `${base}?pr=ucpro&fr=android&kps=${encodeURIComponent(p.kps)}&sign=${encodeURIComponent(p.sign)}&vcode=${encodeURIComponent(p.vcode)}${extra}`
}

/** 这条账号记录是 App 凭证还是网页 cookie。 */
const isAppAuth = (auth) => /^https?:\/\//i.test(String(auth?.key || ""))

// ---- HTTP ------------------------------------------------------------------

async function httpJson(url, { cookie, method = "GET", body, app, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const headers = { accept: "application/json" }
  if (cookie) {
    headers.cookie = cookie
    headers["user-agent"] = UA_PC
    headers.referer = "https://pan.quark.cn/"
  }
  if (app) headers["user-agent"] = UA_APP
  if (body !== undefined) headers["content-type"] = "application/json"

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, json, text: String(text).slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

const ok200 = (r) => r.status === 200 && r.json?.status === 200 && !!r.json?.data

/** 成长信息（含容量 + 签到状态）：App 凭证专属。 */
async function growthInfo(params, deps = {}) {
  const r = await httpJson(appUrl(GROWTH_INFO, params), { app: true, fetchImpl: deps.fetchImpl })
  return { ...r, ok: ok200(r), data: ok200(r) ? r.json.data : null }
}

/** 提交签到。alreadySigned=true 表示服务端说今天已经签过了（不是错误）。 */
async function growthSign(params, deps = {}) {
  const r = await httpJson(appUrl(GROWTH_SIGN, params), { app: true, method: "POST", body: { sign_cyclic: true }, fetchImpl: deps.fetchImpl })
  const alreadySigned = r.status === 400 && Number(r.json?.code) === SIGN_REPEAT
  const ok = ok200(r) && r.json.data.sign_daily_reward !== undefined
  return { ...r, ok, alreadySigned, data: ok ? r.json.data : null }
}

/** App 侧的会员信息：只为了拿 created_at 当稳定账号标识。 */
async function appMember(params, deps = {}) {
  const r = await httpJson(appUrl(APP_MEMBER, params, "&fetch_subscribe=true&fetch_identity=true"), { app: true, fetchImpl: deps.fetchImpl })
  return { ...r, ok: ok200(r), data: ok200(r) ? r.json.data : null }
}

/** 网页侧会员信息：cookie 才有，含 total_capacity / use_capacity。 */
async function webMember(cookie, deps = {}) {
  const r = await httpJson(`${WEB_MEMBER}?${WEB_MEMBER_QUERY}`, { cookie, fetchImpl: deps.fetchImpl })
  return { ...r, ok: ok200(r), data: ok200(r) ? r.json.data : null }
}

const MEMBER_TYPES = { NORMAL: "普通用户", VIP: "会员", SVIP: "超级会员", ZVIP: "至尊会员", MINI_VIP: "迷你会员" }

/** App 和网页两边的 member/growth 里容量字段名一样，抽一份出来。 */
function capacityOf(data) {
  const d = data ?? {}
  return {
    total: Number(d.total_capacity || 0),
    used: Number(d.use_capacity || 0),
    secretTotal: Number(d.secret_total_capacity || 0),
    secretUsed: Number(d.secret_use_capacity || 0),
    memberType: String(d.member_type || ""),
  }
}

// ---- usage / checkin（可注入，便于离线测试） --------------------------------

/**
 * 卡片：空间占用（唯一带百分比条的窗口）+ 签到累计/今日签到 + 凭证或登录态。
 * 空间窗口不设 aside：它就是这个账号唯一「会被用满」的东西。
 */
function windowsFrom({ cap, growth, meta, now = Date.now() }) {
  const windows = []
  const data = growth?.data ?? {}
  const c = cap ?? capacityOf(data)

  if (c.total > 0) {
    windows.push({ name: "空间", used: pct(c.used, c.total), amount: gb(c.used), limit: gb(c.total), unit: "GB" })
  }

  // 实测这俩经常和总量一模一样（不是独立配额），那样就不必画一行重复的数字
  if (c.secretTotal > 0 && c.secretTotal !== c.total) {
    windows.push({ name: "保险箱", display: `${fmtBytes(c.secretUsed)} / ${fmtBytes(c.secretTotal)}`, aside: true })
  }

  const capSign = data.cap_sign
  if (growth?.ok && capSign) {
    const cum = fmtBytes(data.cap_composition?.sign_reward ?? data.cap_growth?.cur_total_cap ?? 0)
    const days = data.cap_growth?.cur_total_sign_day
    const streak = `${capSign.sign_progress ?? "?"}/${capSign.sign_target ?? "?"}`
    windows.push({ name: "签到累计", display: `${cum} · 连签 ${streak}${days ? ` · 共 ${days} 天` : ""}`, aside: true })
    windows.push({
      name: capSign.sign_daily ? "今日已签到" : "今日未签到",
      display: capSign.sign_daily ? `+${fmtBytes(capSign.sign_daily_reward ?? 0)}` : "等 magpie 今日签到",
      aside: true,
    })
  }

  if (meta?.source === "app" && meta?.loginAt) {
    const at = Date.parse(meta.loginAt)
    const days = at ? Math.floor((now - at) / 86400000) : null
    windows.push({
      name: "凭证",
      display: days == null ? "抓包凭证" : days <= 0 ? "今天抓的（失效后重抓一次）" : `${days} 天前抓的（失效后重抓一次）`,
      aside: true,
    })
  }

  const exp = meta?.sessionExpiresAt ? Date.parse(meta.sessionExpiresAt) : 0
  if (exp) {
    const left = exp - now
    const head = left <= 0 ? "已过期" : `还剩 ${formatRemain(left)}`
    windows.push({ name: "登录态", display: `${head}（${formatLocal(meta.sessionExpiresAt)} 到期，网页票据到期前会自动续）`, aside: true })
  }
  return windows
}

async function renewSession({ auth, client, deps }) {
  const key = auth?.metadata?.nickname || auth?.accountId || "default"
  const at = lastRenew.get(key) || 0
  if (Date.now() - at < RENEW_MIN_MS) return null
  lastRenew.set(key, Date.now())
  const reader = deps.sessionReader || ((opts) => readWebSession(opts))
  const s = await reader({ headless: true, timeoutMs: 60_000 })
  if (!s?.ok || !s.cookie) return null
  const expires = s.sessionExpiresAt ? Date.parse(s.sessionExpiresAt) : 0
  const body = {
    ...auth,
    key: s.cookie,
    ...(expires ? { expires } : {}),
    metadata: {
      ...(auth.metadata ?? {}),
      nickname: s.nickname || auth.metadata?.nickname,
      cookies: s.cookies,
      sessionExpiresAt: s.sessionExpiresAt,
      renewedAt: new Date().toISOString(),
    },
  }
  try {
    await client?.auth?.set?.({ path: { id: PROVIDER }, body })
  } catch {}
  return body
}

/** App 凭证链路：一个 growth/info 就有容量 + 签到状态。 */
async function appUsage({ params, auth, deps }) {
  const meta = auth?.metadata ?? {}
  if (!params) return { plan: PROVIDER_NAME, user: "", error: "还没有夸克凭证：用「App 抓包 URL」登录一次", windows: [] }

  const info = await growthInfo(params, deps)
  if (!info.ok) {
    const msg = info.json?.message || info.text || `HTTP ${info.status}`
    const expired = info.status === 401 || /require login|guest/i.test(String(msg))
    return { plan: PROVIDER_NAME, user: "", error: expired ? "抓包凭证失效了：在夸克 App 里重新抓一次 growth/info 那条 URL" : `读取容量失败：${msg}`, windows: [] }
  }

  const cap = capacityOf(info.data)
  return {
    plan: MEMBER_TYPES[cap.memberType] || cap.memberType || PROVIDER_NAME,
    user: meta.nickname || "",
    windows: windowsFrom({ cap, growth: info, meta, now: deps.now ?? Date.now() }),
  }
}

/** 网页 cookie 链路：容量靠 drive-pc member，顺手续期。 */
async function webUsage({ auth, client, deps }) {
  let cookie = auth.key
  let account = auth
  let member = await webMember(cookie, deps)

  if (member.status === 401 || member.status === 403) {
    const renewed = await renewSession({ auth, client, deps })
    if (renewed) {
      account = renewed
      cookie = renewed.key
      member = await webMember(cookie, deps)
    }
  }

  const meta = (account.metadata ?? {})
  if (!member.ok) {
    if (member.status === 401 || member.status === 403) {
      return { plan: PROVIDER_NAME, user: meta.nickname || "", error: "网页登录态失效了：重新登录一次这个账号", windows: [] }
    }
    return {
      plan: PROVIDER_NAME,
      user: meta.nickname || "",
      error: `读取容量失败（HTTP ${member.status || "?"} ${member.json?.message ?? member.text ?? ""}）`.trim(),
      windows: [],
    }
  }

  // 有 App 参数就顺手把签到那两行也读出来（失败不影响容量）
  const params = resolveParams(account, deps)
  const growth = params ? await growthInfo(params, deps).catch(() => null) : null
  const cap = capacityOf(member.data)
  return {
    plan: MEMBER_TYPES[cap.memberType] || cap.memberType || PROVIDER_NAME,
    user: meta.nickname || "",
    windows: windowsFrom({ cap, growth, meta, now: deps.now ?? Date.now() }),
  }
}

async function usageOf({ auth, client, deps = {} }) {
  const key = String(auth?.key || "")
  if (isAppAuth(auth)) return await appUsage({ params: parseParams(key), auth, deps })
  if (key) return await webUsage({ auth, client, deps })
  // 没有 key：可能是从参数文件来的（本地调试/迁移）
  const params = resolveParams(auth, deps)
  if (params) return await appUsage({ params, auth, deps })
  throw new Error("还没有连接夸克网盘：用「App 抓包 URL」登录一次（或受控浏览器网页登录）")
}

async function checkinOf({ auth, deps = {} }) {
  const params = resolveParams(auth, deps)
  if (!params) {
    return {
      outcome: "ineligible",
      message: `还没有夸克凭证：每日领空间只认 App 里的 kps/sign/vcode（网页 cookie 打进去是 401）。抓到后粘进登录的那一问，或写进 ${appParamsFile()}。`,
    }
  }

  const info = await growthInfo(params, deps)
  if (!info.ok) {
    const msg = info.json?.message || info.text || `HTTP ${info.status}`
    if (info.status === 401 || /require login|guest/i.test(String(msg))) {
      return { outcome: "failed", message: "kps/sign/vcode 已失效：在夸克 App 里重新抓一次（看到 growth/info 那条请求，整条 URL 复制）" }
    }
    return { outcome: "failed", message: `读取签到状态失败：${msg}` }
  }

  const cap = info.data?.cap_sign ?? {}
  if (cap.sign_daily) {
    return { outcome: "done", streak: cap.sign_progress ?? undefined, message: `今日已签到 +${fmtBytes(cap.sign_daily_reward ?? 0)}` }
  }

  const signed = await growthSign(params, deps)
  if (signed.alreadySigned) {
    return { outcome: "done", streak: cap.sign_progress ?? undefined, message: "今日已签到（服务端回 cap_growth_sign_repeat）" }
  }
  if (!signed.ok) {
    // POST 结果不确定：复查一次再下结论，免得明明签了却报 failed
    const recheck = await growthInfo(params, deps).catch(() => null)
    const again = recheck?.data?.cap_sign
    if (recheck?.ok && again?.sign_daily) {
      return {
        outcome: "claimed",
        credit: mb(again.sign_daily_reward ?? 0),
        streak: again.sign_progress,
        message: `+${fmtBytes(again.sign_daily_reward ?? 0)}（复查确认）`,
      }
    }
    const msg = signed.json?.message || signed.text || `HTTP ${signed.status}`
    return { outcome: "failed", message: `提交签到没成功：${msg}` }
  }

  const reward = signed.data.sign_daily_reward ?? 0
  return { outcome: "claimed", credit: mb(reward), streak: cap.sign_progress ? cap.sign_progress + 1 : undefined, message: `+${fmtBytes(reward)}` }
}

// ---- 登录 ------------------------------------------------------------------

/** 方式一（推荐）：App 抓包 URL，免浏览器、免 cookie。 */
async function appSignIn({ url } = {}) {
  const params = parseParams(url)
  if (!params) {
    return {
      type: "failed",
      error: "这段内容里找不到 kps/sign/vcode：要夸克 App 里 `drive-m.quark.cn/1/clouddrive/capacity/growth/info` 那条请求的完整 URL",
    }
  }
  const info = await growthInfo(params)
  if (!info.ok) {
    const msg = info.json?.message || info.text || `HTTP ${info.status}`
    return { type: "failed", error: `这条凭证用不了（${msg}）：确认是从「我的 → 空间/签到」页刚抓的，别用其它接口的 URL` }
  }
  const member = await appMember(params).catch(() => null)
  const createdAt = Number(member?.data?.created_at || 0)
  const cap = capacityOf(info.data)
  return {
    type: "success",
    key: appUrl(GROWTH_INFO, params),
    // created_at 是账号创建时间，抓多少次都不变 —— 重新抓包会替换同一账号而不是多加一个
    ...(createdAt ? { accountId: `u${createdAt}` } : {}),
    metadata: {
      source: "app",
      params,
      loginAt: new Date().toISOString(),
      capacity: { total_capacity: cap.total, use_capacity: cap.used, member_type: cap.memberType },
      ...(info.data?.cap_growth ? { sign_days: info.data.cap_growth.cur_total_sign_day ?? null } : {}),
    },
  }
}

async function signInFromSession(s, { appParams, source }) {
  if (!s?.ok) return { type: "failed", error: s?.error || "没拿到夸克网页登录态" }
  const probe = await webMember(s.cookie)
  if (!probe.ok) {
    return { type: "failed", error: `这个登录态读不到网盘容量（HTTP ${probe.status || "?"} ${probe.json?.message ?? ""}），请确认账号能打开 pan.quark.cn`.trim() }
  }
  const expires = s.sessionExpiresAt ? Date.parse(s.sessionExpiresAt) : 0
  return {
    type: "success",
    key: s.cookie,
    accountId: s.nickname || undefined,
    ...(expires ? { expires } : {}),
    metadata: {
      nickname: s.nickname || "",
      source,
      cookies: s.cookies,
      sessionExpiresAt: s.sessionExpiresAt,
      capacity: { total_capacity: probe.data?.total_capacity ?? 0, use_capacity: probe.data?.use_capacity ?? 0, member_type: probe.data?.member_type ?? "" },
      ...(appParams ? { appParams } : {}),
      loginAt: new Date().toISOString(),
    },
  }
}

/** 方式二：受控浏览器扫码登录（只读空间，签到还缺 App 参数）。 */
async function browserSignIn({ appParams } = {}) {
  const s = await readWebSession({ headless: false, timeoutMs: 10 * 60 * 1000 })
  return await signInFromSession(s, { appParams, source: "browser" })
}

/** 方式三：手粘网页 Cookie（不装 playwright / 不想弹窗口时用）。 */
async function cookieSignIn({ cookie, appParams } = {}) {
  const raw = String(cookie ?? "").trim()
  if (!raw) return { type: "failed", error: "没有填 Cookie" }
  const header = raw.replace(/\s*\r?\n\s*/g, " ")
  const s = { ok: true, cookie: header, nickname: "", cookies: [], sessionExpiresAt: null, sessionMsLeft: null }
  return await signInFromSession(s, { appParams, source: "cookie" })
}

/** App URL 里那三个参数可以顺带补进网页账号，让它也能签到。 */
const paramsOfInput = (v) => {
  if (!v) return undefined
  const p = parseParams(v)
  return p ? appUrl(GROWTH_INFO, p) : String(v)
}

// ---- 插件 ------------------------------------------------------------------

export const QuarkPlugin = async ({ client } = {}) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    const was = cfg.provider[PROVIDER] ?? {}
    cfg.provider[PROVIDER] = {
      name: PROVIDER_NAME,
      npm: NPM,
      api: API_BASE,
      ...was,
      // 夸克网盘不提供任何 LLM 模型：这里只挂用量卡与签到，模型表恒为空。
      models: { ...(was.models ?? {}) },
    }
  },

  provider: {
    id: PROVIDER,
    async models(provider) {
      return provider.models
    },
  },

  auth: {
    provider: PROVIDER,
    refreshLead: REFRESH_LEAD_MS,

    // 只有网页 cookie 账号需要续；App 凭证没有续期手段（失效就重抓）。
    async refresh(auth) {
      if (!auth?.key || isAppAuth(auth)) return undefined
      const s = await readWebSession({ headless: true, timeoutMs: 60_000 })
      if (!s.ok || !s.cookie) return undefined
      const expires = s.sessionExpiresAt ? Date.parse(s.sessionExpiresAt) : 0
      if (s.cookie === auth.key && !expires) return undefined
      return {
        key: s.cookie,
        ...(expires ? { expires } : {}),
        metadata: {
          ...(auth.metadata ?? {}),
          nickname: s.nickname || auth.metadata?.nickname,
          cookies: s.cookies,
          sessionExpiresAt: s.sessionExpiresAt,
          renewedAt: new Date().toISOString(),
        },
      }
    },

    async usage(getAuth) {
      return await usageOf({ auth: await getAuth(), client })
    },

    async checkin(getAuth) {
      return await checkinOf({ auth: await getAuth() })
    },

    // 没有模型，loader 不给 baseURL / apiKey，只为满足契约存在。
    async loader() {
      return {}
    },

    methods: [
      {
        type: "api",
        label: "夸克 App 抓包 URL（推荐：一条 URL 就够，免浏览器）",
        placeholder: "https://drive-m.quark.cn/1/clouddrive/capacity/growth/info?…&kps=…&sign=…&vcode=…",
        prompts: [
          {
            type: "password",
            key: "url",
            message: "夸克 App 里 growth/info 那条请求的整条 URL（含 kps/sign/vcode；只要这三个参数，多余参数会被丢掉）",
            validate: (v) => (parseParams(v) ? undefined : "里面没找到 kps/sign/vcode，确认复制的是 growth/info 那条完整 URL"),
          },
        ],
        authorize: async (inputs) => await appSignIn({ url: inputs?.url }),
      },
      {
        type: "api",
        label: "夸克网页登录（受控浏览器，只能看空间占用）",
        placeholder: "直接回车：会在本机弹出插件自己的浏览器窗口",
        prompts: [
          {
            type: "password",
            key: "appUrl",
            message: "（可选）App 抓包 URL，让这个账号也能每日签到；留空也行，之后可写 ~/.quark/app-params.json",
          },
        ],
        authorize: async (inputs) => await browserSignIn({ appParams: paramsOfInput(inputs?.appUrl) }),
      },
      {
        type: "api",
        label: "手填网页 Cookie（不用受控浏览器）",
        placeholder: "浏览器 F12 → 网络 → pan.quark.cn 请求里的整段 Cookie",
        prompts: [
          { type: "password", key: "cookie", message: "pan.quark.cn 的整段 Cookie（要含 __pus / __puus）", validate: (v) => (String(v || "").trim() ? undefined : "Cookie 不能为空") },
          { type: "password", key: "appUrl", message: "（可选）App 抓包 URL，签到用" },
        ],
        authorize: async (inputs) => await cookieSignIn({ cookie: inputs?.cookie, appParams: paramsOfInput(inputs?.appUrl) }),
      },
    ],
  },
})

/** 离线测试入口（magpie 只把导出的函数当插件，这个对象不会被当成插件）。 */
export const _internal = {
  PROVIDER,
  GROWTH_INFO,
  GROWTH_SIGN,
  APP_MEMBER,
  WEB_MEMBER,
  appUrl,
  appParamsFile,
  isAppAuth,
  fmtBytes,
  parseQuery,
  parseParams,
  resolveParams,
  growthInfo,
  growthSign,
  appMember,
  webMember,
  usageOf,
  checkinOf,
  windowsFrom,
  capacityOf,
  sessionFromCookies,
  formatRemain,
  formatLocal,
}
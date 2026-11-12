// 受控浏览器：插件自己的浏览器窗口（持久 profile），用来做「免抓包」的那半件事。
//
// 夸克的网页登录态能读空间容量（drive-pc /1/clouddrive/member），但**读不到签到**：
// growth/info 对网页/PC 侧恒返回 data:{}，网页版页面里也没有签到入口，移动端同接口
// 只认 App 签发的 kps/sign/vcode（带网页 cookie 一律 401 guest）。所以这里只负责
// 登录 + 采集 cookie，签到在 index.mjs 里走 App 参数那条链路。
//
// 依赖 playwright-core 是 optionalDependencies：没装就只能手填 Cookie（登录方式二）。

import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const HOME_URL = "https://pan.quark.cn/"
export const ACCOUNT_PATH = "/account/info"

/** 长期票据（决定「登录态还剩多久」）；__puus 是一天的短票据，访问网页即续，单独列。 */
export const LONG_COOKIES = ["__pus", "__kps", "__uid", "b-user-id"]
export const SHORT_COOKIES = ["__puus", "_UP_A4A_11_", "tfstk", "isg"]

const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"]

/** 受控浏览器的 profile：登录态在这里，删掉等于退出登录。 */
export function profileDir() {
  return process.env.QUARK_WEB_PROFILE || join(homedir(), ".quark", "web-profile")
}

export async function loadPlaywright() {
  for (const name of ["playwright-core", "playwright"]) {
    try {
      return await import(name)
    } catch {}
  }
  return null
}

async function launch(headless) {
  const pw = await loadPlaywright()
  if (!pw) {
    const err = new Error("没有可用的 playwright-core（用「手填网页 Cookie」登录，或装一次 playwright-core）")
    err.code = "NO_PLAYWRIGHT"
    throw err
  }
  const dir = profileDir()
  mkdirSync(dir, { recursive: true })
  const base = { headless, viewport: headless ? { width: 1280, height: 820 } : null, args: LAUNCH_ARGS }
  let lastErr = null
  // 用系统已装的 Chrome / Edge，避免再下一份 chromium
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await pw.chromium.launchPersistentContext(dir, { ...base, channel })
    } catch (e) {
      lastErr = e
    }
  }
  try {
    return await pw.chromium.launchPersistentContext(dir, base)
  } catch (e) {
    throw lastErr ?? e
  }
}

/** ctx.cookies() → 插件自己要的形状（名称/到期/剩余），只留 quark 域名下的。 */
export function sessionFromCookies(list, now = Date.now()) {
  const rows = (list || [])
    .filter((c) => /(^|\.)quark\.cn$/.test(String(c.domain || "")))
    .map((c) => {
      const expiresAt = c.expires > 0 ? new Date(c.expires * 1000) : null
      return {
        name: c.name,
        host: c.domain,
        httpOnly: !!c.httpOnly,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        msLeft: expiresAt ? expiresAt.getTime() - now : null,
      }
    })
  const pick = (names) => rows.filter((r) => names.includes(r.name) && r.msLeft != null).sort((a, b) => a.msLeft - b.msLeft)
  const long = pick(LONG_COOKIES)
  const short = pick(SHORT_COOKIES)
  const soonest = long.length ? long[0] : short[0] ?? null
  return {
    cookie: rows.length ? (list || []).map((c) => `${c.name}=${c.value}`).join("; ") : "",
    cookies: rows,
    sessionExpiresAt: soonest?.expiresAt ?? null,
    sessionMsLeft: soonest?.msLeft ?? null,
    // 长期票据都没了就是真掉登录态；短票据到期只说明该开一次网页
    broken: long.length === 0,
  }
}

function banner(page, text) {
  return page
    .evaluate((t) => {
      let el = document.getElementById("__quark_plugin_banner")
      if (!el) {
        el = document.createElement("div")
        el.id = "__quark_plugin_banner"
        el.style.cssText =
          "position:fixed;z-index:2147483647;top:0;left:0;right:0;padding:10px 16px;background:#1677ff;color:#fff;font:14px/1.5 system-ui;text-align:center"
        document.body.appendChild(el)
      }
      el.textContent = t
    }, text)
    .catch(() => {})
}

async function readAccount(page) {
  return await page.evaluate(async (path) => {
    try {
      const res = await fetch(path, { credentials: "include", headers: { accept: "application/json" } })
      if (!res.ok) return { status: res.status }
      const json = await res.json()
      return { status: res.status, nickname: json?.data?.nickname ?? null }
    } catch (e) {
      return { status: 0, error: String(e).slice(0, 160) }
    }
  }, ACCOUNT_PATH)
}

/**
 * 打开受控浏览器，等网页登录态可用，然后采集 cookie。
 *   headless=false：弹窗给用户扫码（登录用），拿到就关。
 *   headless=true ：静默续期用（profile 里已有登录态时几秒就好）。
 */
export async function readWebSession({ headless = true, timeoutMs = 3 * 60 * 1000 } = {}) {
  let ctx = null
  try {
    ctx = await launch(headless)
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {})
    if (!headless) await banner(page, "请在这个窗口里登录夸克网盘（扫码或短信都行）；登录成功后窗口会自动关闭，回到 magpie 即可")

    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      const acc = await readAccount(page)
      if (acc.nickname) {
        const s = sessionFromCookies(await ctx.cookies())
        return { ok: true, nickname: acc.nickname, ...s }
      }
      last = acc
      await page.waitForTimeout(3000)
    }
    return {
      ok: false,
      error:
        last?.status === 0
          ? `打不开夸克网盘页面：${last.error ?? "未知原因"}`
          : "等待登录超时（这个窗口里还没有完成夸克登录）",
    }
  } catch (e) {
    const msg = e?.message ?? String(e)
    // Edge/Chrome 在 profile 被强杀后可能起不来：给出可操作的一句
    const hint = /has been closed|SingletonLock|ProcessSingleton|user data directory is already in use/i.test(msg)
      ? `（受控浏览器的 profile 可能坏了或被占用：关掉残留浏览器、删掉 ${profileDir()} 再登录一次）`
      : ""
    return { ok: false, error: msg + hint, code: e?.code ?? null }
  } finally {
    try {
      await ctx?.close()
    } catch {}
  }
}

/** 剩余时长的中文短写法。 */
export function formatRemain(ms) {
  if (ms == null) return "会话"
  if (ms <= 0) return "已过期"
  if (ms >= 86400000) return `${Math.floor(ms / 86400000)} 天`
  if (ms >= 3600000) return `${Math.floor(ms / 3600000)} 小时`
  return `${Math.max(1, Math.floor(ms / 60000))} 分钟`
}

/** 面板/卡片里的本地时间：2026-12-10 11:13:37。 */
export function formatLocal(iso) {
  if (!iso) return "会话"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "会话"
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

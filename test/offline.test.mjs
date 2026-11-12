// 离线测试：不联网、不开浏览器。所有 HTTP 由假 fetch 给，浏览器由假 sessionReader 给。
import assert from "node:assert/strict"
import { test } from "node:test"

import { _internal as Q } from "../index.mjs"

const GB = 1024 ** 3
const APP_KEY = "https://drive-m.quark.cn/1/clouddrive/capacity/growth/info?pr=ucpro&fr=android&kps=K&sign=S&vcode=V"

/** 按 URL 片段分派的假 fetch。 */
function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body })
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) {
        const out = typeof handler === "function" ? handler(url, init) : handler
        return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200 })
      }
    }
    throw new Error(`unexpected url ${url}`)
  }
  fn.calls = calls
  return fn
}

const growthBody = (extra = {}) => ({
  status: 200,
  data: {
    member_type: "NORMAL",
    total_capacity: 10 * GB,
    use_capacity: 2 * GB,
    "88VIP": false,
    cap_growth: { lost_total_cap: 0, cur_total_cap: 180 * 1024 ** 2, cur_total_sign_day: 8 },
    cap_composition: { other: 0, member_own: 10 * GB, sign_reward: 180 * 1024 ** 2 },
    cap_sign: { sign_daily: false, sign_target: 7, sign_progress: 5, sign_daily_reward: 0 },
    ...extra,
  },
})

const growthOk = (extra = {}) => ({ status: 200, body: growthBody(extra) })
const webMemberOk = (total, used) => ({ status: 200, body: { status: 200, data: { total_capacity: total, use_capacity: used, member_type: "NORMAL" } } })

test("parseQuery 保留字面量 +，不把它当空格", () => {
  const q = Q.parseQuery("kps=a+b%2Bc&sign=x&vcode=")
  assert.equal(q.kps, "a+b+c")
  assert.equal(q.sign, "x")
  assert.equal(q.vcode, "")
})

test("parseParams 四种形状都认", () => {
  const url = "https://drive-m.quark.cn/1/clouddrive/capacity/growth/info?__t=1&kps=K+1&sign=S%2FS&vcode=V9&mt=4"
  assert.deepEqual(Q.parseParams(url), { kps: "K+1", sign: "S/S", vcode: "V9" })
  assert.deepEqual(Q.parseParams("user=张三; kps=K; sign=S; vcode=V;"), { kps: "K", sign: "S", vcode: "V" })
  assert.deepEqual(Q.parseParams(`user=张三; url=${url};`), { kps: "K+1", sign: "S/S", vcode: "V9" })
  assert.deepEqual(Q.parseParams(JSON.stringify({ url })), { kps: "K+1", sign: "S/S", vcode: "V9" })
  assert.deepEqual(Q.parseParams({ kps: "K", sign: "S", vcode: "V" }), { kps: "K", sign: "S", vcode: "V" })
  assert.equal(Q.parseParams("kps=K; sign=S"), null)
  assert.equal(Q.parseParams(""), null)
})

test("resolveParams：账号记录（key/metadata）优先，其次文件（跳过注释）", () => {
  const readFile = () => "# 注释行\n\nkps=FK; sign=FS; vcode=FV\n"
  assert.deepEqual(Q.resolveParams({ key: APP_KEY }, { readFile }), { kps: "K", sign: "S", vcode: "V" })
  assert.deepEqual(Q.resolveParams({ metadata: { kps: "MK", sign: "MS", vcode: "MV" } }, { readFile }), { kps: "MK", sign: "MS", vcode: "MV" })
  assert.deepEqual(Q.resolveParams({ key: "ck=1", metadata: {} }, { readFile }), { kps: "FK", sign: "FS", vcode: "FV" })
  assert.equal(Q.resolveParams({ metadata: {} }, { readFile: () => { throw new Error("ENOENT") } }), null)
})

test("isAppAuth 按 key 前缀区分两条链路", () => {
  assert.equal(Q.isAppAuth({ key: APP_KEY }), true)
  assert.equal(Q.isAppAuth({ key: "__pus=abc; __puus=def" }), false)
  assert.equal(Q.isAppAuth({}), false)
})

test("windowsFrom：空间占比、保险箱、签到累计、凭证天数", () => {
  const now = Date.parse("2026-11-12T00:00:00Z")
  const growth = { ok: true, data: growthBody({ cap_sign: { sign_daily: true, sign_target: 7, sign_progress: 3, sign_daily_reward: 20 * 1024 ** 2 } }).data }
  const windows = Q.windowsFrom({
    cap: { total: 10 * GB, used: 2 * GB, secretTotal: GB, secretUsed: GB / 4, memberType: "NORMAL" },
    growth,
    meta: { source: "app", loginAt: "2026-11-10T00:00:00Z" },
    now,
  })
  const space = windows[0]
  assert.equal(space.name, "空间")
  assert.equal(space.used, 20)
  assert.equal(space.amount, 2)
  assert.equal(space.limit, 10)
  assert.equal(space.unit, "GB")
  assert.equal(space.aside, undefined, "空间窗口不设 aside：它才是会被用满的那个")
  assert.ok(windows.some((w) => w.name === "保险箱" && w.aside === true))
  const cum = windows.find((w) => w.name === "签到累计")
  assert.match(cum.display, /180 MB/)
  assert.match(cum.display, /3\/7/)
  assert.match(cum.display, /共 8 天/)
  assert.ok(windows.find((w) => w.name === "今日已签到"))
  assert.match(windows.find((w) => w.name === "凭证").display, /2 天前/)
})

test("windowsFrom：保险箱和总量一样时不重复画一行", () => {
  const windows = Q.windowsFrom({ cap: { total: 10 * GB, used: GB, secretTotal: 10 * GB, secretUsed: GB, memberType: "NORMAL" } })
  assert.equal(windows.some((w) => w.name === "保险箱"), false)
})

test("usageOf（App 凭证）：一个 growth/info 就有空间占用和签到状态", async () => {
  const fetchImpl = fakeFetch([["capacity/growth/info", growthOk()]])
  const out = await Q.usageOf({ auth: { type: "api", key: APP_KEY, metadata: { source: "app", loginAt: "2026-11-11T00:00:00Z" } }, deps: { fetchImpl } })
  assert.equal(out.plan, "普通用户")
  assert.equal(out.windows[0].used, 20)
  assert.equal(out.windows[0].limit, 10)
  assert.ok(out.windows.find((w) => w.name === "今日未签到"))
  assert.equal(out.error, undefined)
})

test("usageOf（App 凭证）：401 时如实说失效，不给假数字", async () => {
  const fetchImpl = fakeFetch([["capacity/growth/info", { status: 401, body: { status: 401, message: "require login [guest]" } }]])
  const out = await Q.usageOf({ auth: { type: "api", key: APP_KEY, metadata: {} }, deps: { fetchImpl } })
  assert.equal(out.windows.length, 0)
  assert.match(out.error, /重新抓一次/)
})

test("usageOf（网页 cookie）：401 时用受控浏览器续一次，并把新 cookie 写回账号", async () => {
  let first = true
  const fetchImpl = fakeFetch([
    [
      "/1/clouddrive/member",
      () => {
        if (first) {
          first = false
          return { status: 401, body: { status: 401, message: "require login [guest]" } }
        }
        return webMemberOk(20 * GB, 5 * GB)
      },
    ],
  ])
  const saved = []
  const client = { auth: { set: async (payload) => saved.push(payload) } }
  const sessionReader = async () => ({
    ok: true,
    cookie: "ck=2",
    nickname: "夸父",
    cookies: [{ name: "__pus", expiresAt: "2026-12-01T00:00:00Z", msLeft: 1000 }],
    sessionExpiresAt: "2026-12-01T00:00:00Z",
  })
  const out = await Q.usageOf({ auth: { type: "api", key: "ck=1", metadata: { nickname: "夸父" } }, client, deps: { fetchImpl, sessionReader } })
  assert.equal(out.windows[0].used, 25)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].path.id, "quark")
  assert.equal(saved[0].body.key, "ck=2")
})

test("usageOf：两样都没有时报错指明登录方式", async () => {
  await assert.rejects(() => Q.usageOf({ auth: { type: "api", key: "" }, deps: { readFile: () => "" } }), /还没有连接夸克网盘/)
})

test("checkinOf：没有凭证报 ineligible 并说清怎么办", async () => {
  const out = await Q.checkinOf({ auth: { type: "api", key: "", metadata: {} }, deps: { readFile: () => "" } })
  assert.equal(out.outcome, "ineligible")
  assert.match(out.message, /kps\/sign\/vcode/)
  assert.match(out.message, /app-params\.json/)
})

test("checkinOf：今日已签到是 done，不是 failed", async () => {
  const fetchImpl = fakeFetch([["growth/info", growthOk({ cap_sign: { sign_progress: 3, sign_target: 7, sign_daily: true, sign_daily_reward: 100 * 1024 ** 2 } })]])
  const out = await Q.checkinOf({ auth: { type: "api", key: APP_KEY, metadata: {} }, deps: { fetchImpl } })
  assert.equal(out.outcome, "done")
  assert.equal(out.streak, 3)
  assert.match(out.message, /100 MB/)
})

test("checkinOf：签到成功给 claimed + credit", async () => {
  const fetchImpl = fakeFetch([
    ["growth/info", growthOk()],
    ["growth/sign", { status: 200, body: { status: 200, data: { sign_daily_reward: 500 * 1024 ** 2 } } }],
  ])
  const out = await Q.checkinOf({ auth: { type: "api", key: APP_KEY, metadata: {} }, deps: { fetchImpl } })
  assert.equal(out.outcome, "claimed")
  assert.equal(out.credit, 500)
  assert.equal(out.streak, 6)
  assert.match(out.message, /500 MB/)
})

test("checkinOf：服务端回 44210 cap_growth_sign_repeat 也算 done", async () => {
  const fetchImpl = fakeFetch([
    ["growth/info", growthOk()],
    ["growth/sign", { status: 400, body: { status: 400, code: 44210, message: "cap_growth_sign_repeat" } }],
  ])
  const out = await Q.checkinOf({ auth: { type: "api", key: APP_KEY, metadata: {} }, deps: { fetchImpl } })
  assert.equal(out.outcome, "done")
  assert.match(out.message, /repeat/)
})

test("checkinOf：参数失效给 failed 并提示重抓", async () => {
  const fetchImpl = fakeFetch([["growth/info", { status: 401, body: { status: 401, message: "require login [guest]" } }]])
  const out = await Q.checkinOf({ auth: { type: "api", key: APP_KEY, metadata: {} }, deps: { fetchImpl } })
  assert.equal(out.outcome, "failed")
  assert.match(out.message, /已失效/)
})

test("checkinOf：POST 没回奖励但复查已签 → 按 claimed（不谎报失败）", async () => {
  let infoCalls = 0
  const fetchImpl = fakeFetch([
    [
      "growth/info",
      () => {
        infoCalls += 1
        return infoCalls === 1
          ? growthOk()
          : growthOk({ cap_sign: { sign_progress: 6, sign_target: 7, sign_daily: true, sign_daily_reward: 300 * 1024 ** 2 } })
      },
    ],
    ["growth/sign", { status: 500, body: { status: 500, message: "boom" } }],
  ])
  const out = await Q.checkinOf({ auth: { type: "api", key: APP_KEY, metadata: {} }, deps: { fetchImpl } })
  assert.equal(out.outcome, "claimed")
  assert.equal(out.credit, 300)
  assert.match(out.message, /复查确认/)
})

test("appUrl 只保留 kps/sign/vcode，并把 + / 转义掉", () => {
  const url = Q.appUrl("https://drive-m.quark.cn/x", { kps: "K+1", sign: "S/S", vcode: "V" })
  assert.equal(url, "https://drive-m.quark.cn/x?pr=ucpro&fr=android&kps=K%2B1&sign=S%2FS&vcode=V")
})

test("fmtBytes 走 1024 进制", () => {
  assert.equal(Q.fmtBytes(0), "0 B")
  assert.equal(Q.fmtBytes(1024), "1 KB")
  assert.equal(Q.fmtBytes(10 * GB), "10 GB")
  assert.equal(Q.fmtBytes(1.5 * GB), "1.5 GB")
})
// ライブの巻き戻しテスト：ライブを見ていて巻き戻したとき、その時点に投稿されたコメントが流れるかを確かめる。
// 架空のページ（https://fyl.test/）に、映像の遅れを自由に変えられる偽のプレイヤーを置き、API だけ本物の YouTube に転送する。
// 使い方: npm run test:rewind   （LIVE=<動画ID> で対象のライブを指定できる。指定が無ければ検索して探す）
import { webkit } from "playwright"
import { findBusyLive, openFakePage, openYouTube, readScript } from "./lib.mjs"

const SCRIPT = readScript()
const WATCH_MS = 40000 // 巻き戻す前に見ておく時間（この間のコメントが貯まる）
const REWIND_SEC = 35 // 巻き戻す秒数
const AFTER_MS = 15000
const TOLERANCE_MS = 15000 // 流れたコメントの投稿時刻と「映っている映像の時刻」の許容差

const browser = await webkit.launch()
// にぎやかなライブを選び、API に必要な ytcfg を本物のページから取る
const yt = await openYouTube(browser)
const VIDEO = process.env.LIVE ?? (await findBusyLive(yt, { queries: ["雑談"], max: 6 }))
if (!VIDEO) throw new Error("テスト用のライブ配信が見つからない")
const context = await yt.evaluate(() => ytcfg.get("INNERTUBE_CONTEXT"))
await yt.close()
const page = await openFakePage(browser, { proxy: true })
await page.addInitScript("window.__flowed = []")
await page.goto(`https://fyl.test/watch?v=${VIDEO}`)
await page.evaluate(context => {
	window.ytcfg = { get: k => (k === "INNERTUBE_CONTEXT" ? context : undefined) }
	// 本物のページと同じく <script> の本文にも埋め込む（ISOLATED=1 のときはこちらから読む。実行はさせない）
	const embedded = document.createElement("script")
	embedded.type = "application/json"
	embedded.textContent = `ytcfg.set(${JSON.stringify({ INNERTUBE_CONTEXT: context })});`
	document.head.append(embedded)
	const v = document.querySelector("video")
	Object.defineProperty(v, "paused", { get: () => false })
	// 偽のプレイヤー：映っている映像の配信時刻 = 今 - 遅れ
	window.__lagMs = 3000
	// 再生位置も同じ遅れで進める（ページから切り離された環境では、こちらから遅れを見積もる）
	Object.defineProperty(v, "currentTime", { get: () => (Date.now() - window.__lagMs) / 1000 - 1.7e9 })
	document.querySelector("#movie_player").getProgressState = () => ({ ingestionTime: (Date.now() - window.__lagMs) / 1000 })
}, context)
// 流れたときに、投稿時刻と「映っている映像の時刻」との差を記録する
await page.addScriptTag({
	content: SCRIPT.replace(
		"const flow = chat => {",
		"const flow = chat => { window.__flowed.push({ diff: chat.ts - (Date.now() - window.__lagMs), ts: chat.ts });",
	),
})

const take = () => page.evaluate(() => window.__flowed.splice(0))
await page.waitForTimeout(WATCH_MS)
const before = await take()
const rewoundAt = Date.now()
await page.evaluate(sec => {
	window.__lagMs = sec * 1000
}, REWIND_SEC)
await page.waitForTimeout(AFTER_MS)
const after = await take()
await browser.close()

const off = after.filter(x => Math.abs(x.diff) > TOLERANCE_MS)
// 巻き戻し先の時間帯（巻き戻した時点の REWIND_SEC 秒前から AFTER_MS の間）に、もともとコメントがあったか。
// チャットが少ない配信では、その時間帯にコメントが無く判定できないことがある
const windowStart = rewoundAt - REWIND_SEC * 1000
const expected = before.filter(x => x.ts >= windowStart && x.ts <= windowStart + AFTER_MS).length
const problems = []
if (before.length === 0) problems.push("巻き戻す前にコメントが流れない（チャットが少ない配信の可能性）")
if (after.length === 0 && expected > 0) problems.push(`${REWIND_SEC} 秒巻き戻したあと、その時間帯のコメント ${expected} 件が流れない`)
if (off.length) problems.push(`映っている時刻とずれたコメントが ${off.length} 件（最新のコメントを流している可能性）`)
const summary = after.length
	? `巻き戻す前 ${before.length} 件・巻き戻した後 ${after.length} 件（すべて映っている時刻の ±${TOLERANCE_MS / 1000} 秒以内）`
	: `巻き戻し先の時間帯にコメントが無かったため判定できず（巻き戻す前 ${before.length} 件）`
console.log(problems.length ? "NG  " : "OK  ", `ライブの巻き戻し（${VIDEO}：${REWIND_SEC} 秒）`, problems.length ? problems.join(" / ") : summary)
process.exit(problems.length ? 1 : 0)

// ライブの巻き戻しテスト：ライブを見ていて巻き戻したとき、その時点に投稿されたコメントが流れるかを確かめる。
// 架空のページ（https://fyl.test/）に、映像の遅れを自由に変えられる偽のプレイヤーを置き、API だけ本物の YouTube に転送する。
// 使い方: npm run test:rewind   （LIVE=<動画ID> で対象のライブを指定できる。指定が無ければ検索して探す）
import fs from "node:fs"
import path from "node:path"
import { webkit } from "playwright"

const ROOT = path.resolve(import.meta.dirname, "..")
const SCRIPT = fs.readFileSync(process.env.SCRIPT ?? path.join(ROOT, "flow-youtube-chat-lite.user.js"), "utf8")
const WATCH_MS = 40000 // 巻き戻す前に見ておく時間（この間のコメントが貯まる）
const REWIND_SEC = 35 // 巻き戻す秒数
const AFTER_MS = 15000
const TOLERANCE_MS = 15000 // 流れたコメントの投稿時刻と「映っている映像の時刻」の許容差

const candidates = async () => {
	const html = await (
		await fetch("https://www.youtube.com/results?search_query=%E9%9B%91%E8%AB%87&sp=EgJAAQ%253D%253D", { headers: { "accept-language": "ja" } })
	).text()
	return [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map(m => m[1]))].slice(0, 6)
}

const browser = await webkit.launch()
const page = await browser.newPage()
await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" })
await page.waitForFunction(() => window.ytcfg?.get?.("INNERTUBE_CONTEXT"), null, { timeout: 30000 })
// チャットが少ない配信だと判定できないので、直近 30 秒のコメントが一番多いライブを選ぶ
const activity = id =>
	page.evaluate(async id => {
		const api = (ep, body) =>
			fetch(`/youtubei/v1/${ep}?prettyPrint=false`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ context: ytcfg.get("INNERTUBE_CONTEXT"), ...body }),
			}).then(r => r.json())
		const find = (o, k) => {
			const st = [o]
			while (st.length) {
				const x = st.pop()
				if (x && typeof x === "object") {
					if (k in x) return x[k]
					st.push(...Object.values(x))
				}
			}
		}
		const r = find(await api("next", { videoId: id }), "liveChatRenderer")
		const continuation = !r?.isReplay && r?.continuations?.[0]?.reloadContinuationData?.continuation
		if (!continuation) return -1
		const res = await api("live_chat/get_live_chat", { continuation })
		const since = (Date.now() - 30000) * 1000
		return (res.continuationContents?.liveChatContinuation?.actions ?? []).filter(
			a => Number(Object.values(a.addChatItemAction?.item ?? {})[0]?.timestampUsec) > since,
		).length
	}, id)
let VIDEO = process.env.LIVE
if (!VIDEO) {
	let best = -1
	for (const id of await candidates()) {
		const n = await activity(id).catch(() => -1)
		if (n > best) [best, VIDEO] = [n, id]
	}
}
if (!VIDEO) throw new Error("テスト用のライブ配信が見つからない")
const context = await page.evaluate(() => ytcfg.get("INNERTUBE_CONTEXT"))
await page.route("https://fyl.test/**", async r => {
	const u = new URL(r.request().url())
	if (u.pathname.startsWith("/youtubei/")) {
		const response = await r.fetch({
			url: `https://www.youtube.com${u.pathname}${u.search}`,
			headers: { ...r.request().headers(), origin: "https://www.youtube.com", referer: "https://www.youtube.com/" },
		})
		return r.fulfill({ response })
	}
	r.fulfill({
		contentType: "text/html",
		body: '<!doctype html><html><head></head><body><div id="movie_player" style="position:relative;width:800px;height:450px"><video></video></div></body></html>',
	})
})
await page.addInitScript("window.__flowed = []")
await page.goto(`https://fyl.test/watch?v=${VIDEO}`)
await page.evaluate(context => {
	window.ytcfg = { get: k => (k === "INNERTUBE_CONTEXT" ? context : undefined) }
	const v = document.querySelector("video")
	Object.defineProperty(v, "paused", { get: () => false })
	// 偽のプレイヤー：映っている映像の配信時刻 = 今 - 遅れ
	window.__lagMs = 3000
	document.querySelector("#movie_player").getProgressState = () => ({ ingestionTime: (Date.now() - window.__lagMs) / 1000 })
}, context)
// 流れたときに、投稿時刻と「映っている映像の時刻」との差を記録する
await page.addScriptTag({
	content: SCRIPT.replace("const flow = chat => {", "const flow = chat => { window.__flowed.push(chat.ts - (Date.now() - window.__lagMs));"),
})

const take = () => page.evaluate(() => window.__flowed.splice(0))
await page.waitForTimeout(WATCH_MS)
const before = await take()
await page.evaluate(sec => {
	window.__lagMs = sec * 1000
}, REWIND_SEC)
await page.waitForTimeout(AFTER_MS)
const after = await take()
await browser.close()

const off = after.filter(d => Math.abs(d) > TOLERANCE_MS)
const problems = []
if (before.length === 0) problems.push("巻き戻す前にコメントが流れない（チャットが少ない配信の可能性）")
if (after.length === 0) problems.push(`${REWIND_SEC} 秒巻き戻したあとコメントが流れない`)
if (off.length) problems.push(`映っている時刻とずれたコメントが ${off.length} 件（最新のコメントを流している可能性）`)
console.log(
	problems.length ? "NG  " : "OK  ",
	`ライブの巻き戻し（${VIDEO}：${REWIND_SEC} 秒）`,
	problems.length
		? problems.join(" / ")
		: `巻き戻す前 ${before.length} 件・巻き戻した後 ${after.length} 件（すべて映っている時刻の ±${TOLERANCE_MS / 1000} 秒以内）`,
)
process.exit(problems.length ? 1 : 0)

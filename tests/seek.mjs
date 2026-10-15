// アーカイブのシーク追従テスト：途中から見て、過去の位置に戻したとき、その位置のコメントが流れるかを確かめる。
// ヘッドレスのブラウザでは YouTube の動画をシークすると止まってしまうので、再生位置を自由に動かせる偽の動画を置いた
// 架空のページ（https://fyl.test/）にスクリプトを読み込み、API だけ本物の YouTube に転送する。
// 使い方: npm run test:seek   （REPLAY=<動画ID> START=<秒> BACK=<秒> で対象を変えられる）
import fs from "node:fs"
import path from "node:path"
import { webkit } from "playwright"

const ROOT = path.resolve(import.meta.dirname, "..")
const SCRIPT = fs.readFileSync(process.env.SCRIPT ?? path.join(ROOT, "flow-youtube-chat-lite.user.js"), "utf8")
// 既定：コメントが 29〜31 分あたりに集中しているアーカイブ
const VIDEO = process.env.REPLAY ?? "he90VRGAr8o"
const START = Number(process.env.START ?? 1825)
const BACK = Number(process.env.BACK ?? 1760)
const WAIT_MS = 15000

const browser = await webkit.launch()
const page = await browser.newPage()
// API に必要な ytcfg を本物のページから取る
await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: "domcontentloaded" })
await page.waitForFunction(() => window.ytcfg?.get?.("INNERTUBE_CONTEXT"), null, { timeout: 30000 })
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
await page.evaluate(
	([context, start]) => {
		window.ytcfg = { get: k => (k === "INNERTUBE_CONTEXT" ? context : undefined) }
		// 偽の動画：再生位置が実時間で進み、代入でシークできる
		const v = document.querySelector("video")
		let base = start
		let t0 = performance.now()
		Object.defineProperty(v, "currentTime", {
			get: () => base + (performance.now() - t0) / 1000,
			set: x => {
				base = x
				t0 = performance.now()
			},
		})
		Object.defineProperty(v, "paused", { get: () => false })
		Object.defineProperty(v, "duration", { get: () => 99999 })
	},
	[context, START],
)
// 流れたときの再生位置を記録する
await page.addScriptTag({
	content: SCRIPT.replace("const flow = chat => {", "const flow = chat => { window.__flowed.push(document.querySelector('video').currentTime);"),
})

const flowedSince = async () => page.evaluate(() => window.__flowed.splice(0))
await page.waitForTimeout(WAIT_MS)
const before = await flowedSince()
await page.evaluate(x => {
	document.querySelector("video").currentTime = x
}, BACK)
await page.waitForTimeout(WAIT_MS)
const after = await flowedSince()
await browser.close()

const problems = []
if (before.length === 0) problems.push(`${START} 秒から見始めてコメントが流れない`)
if (after.length === 0) problems.push(`${BACK} 秒に戻したあとコメントが流れない`)
if (after.some(t => t > START)) problems.push("戻したのに、戻す前の位置のコメントが流れた")
console.log(
	problems.length ? "NG  " : "OK  ",
	`アーカイブのシーク（${VIDEO}：${START} 秒 → ${BACK} 秒）`,
	problems.length ? problems.join(" / ") : `戻す前 ${before.length} 件・戻した後 ${after.length} 件`,
)
process.exit(problems.length ? 1 : 0)

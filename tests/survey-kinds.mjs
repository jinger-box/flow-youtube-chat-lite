// 実際のライブで届くチャット項目の種類を数え、まだ流していない種類の見本を保存する（保守用。CI では動かさない）
// YouTube が新しい種類（例：2026-11 の有料ギフト giftMessageViewModel）を足したときに気づくために使う。
// 使い方: node tests/survey-kinds.mjs <保存先.json> [秒数=150]
// 保存する見本には他人の名前・本文が入るので、リポジトリの外（一時フォルダ）に保存する
import fs from "node:fs"
import path from "node:path"
import { webkit } from "playwright"
import { findBusyLive, log, openYouTube } from "./lib.mjs"

const [out, seconds = "150"] = process.argv.slice(2)
if (!out) throw new Error("使い方: node tests/survey-kinds.mjs <保存先.json> [秒数]")
const browser = await webkit.launch()
const page = await openYouTube(browser)
const ids = []
// メンバーシップ・ギフト・スーパーチャットが多いのは VTuber の配信
for (const q of ["ホロライブ", "にじさんじ", "VTuber 雑談"]) {
	const id = await findBusyLive(page, { queries: [q], max: 4 })
	if (id && !ids.includes(id)) ids.push(id)
}
log("調べる配信", ids)
const result = await page.evaluate(
	async ([ids, ms]) => {
		const { api, chat } = window.__yt
		const kinds = {}
		const actions = {}
		const samples = {}
		const conts = []
		for (const id of ids) {
			const c = await chat(id)
			if (c.kind !== "none") conts.push(c.continuation)
		}
		const end = Date.now() + ms
		while (Date.now() < end) {
			for (let i = 0; i < conts.length; i++) {
				const r = await api("live_chat/get_live_chat", { continuation: conts[i] }).catch(() => null)
				const lc = r?.continuationContents?.liveChatContinuation
				if (!lc) continue
				const next = lc.continuations?.[0]
				const c = next && Object.values(next)[0]?.continuation
				if (c) conts[i] = c
				for (const a of lc.actions ?? []) {
					const ak = Object.keys(a).find(k => k !== "clickTrackingParams")
					actions[ak] = (actions[ak] ?? 0) + 1
					const item = a.addChatItemAction?.item
					if (!item) continue
					const k = Object.keys(item)[0]
					kinds[k] = (kinds[k] ?? 0) + 1
					if (k !== "liveChatTextMessageRenderer") {
						samples[k] ??= []
						if (samples[k].length < 3) samples[k].push(item[k])
					}
				}
			}
			await new Promise(r => setTimeout(r, 4000))
		}
		return { kinds, actions, samples }
	},
	[ids, Number(seconds) * 1000],
)
await browser.close()
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, JSON.stringify(result, null, 1))
console.log("項目の種類", result.kinds)
console.log("操作の種類", result.actions)
console.log("見本を保存", out)

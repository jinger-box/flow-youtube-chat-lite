// 単体テスト用の API 応答の見本を作り直す（YouTube の応答の形が変わったときに実行する）
// 実際のライブ / アーカイブから応答を取得し、投稿者名・チャンネルID・本文・画像 URL を
// ダミーに置き換えて tests/fixtures/ に保存する（他人のコメントを公開リポジトリに残さないため）。
// 使い方: node tests/update-fixtures.mjs <ライブの動画ID> <アーカイブの動画ID>
import fs from "node:fs"
import path from "node:path"
import { webkit } from "playwright"

const [liveId, replayId] = process.argv.slice(2)
if (!liveId || !replayId) throw new Error("使い方: node tests/update-fixtures.mjs <ライブの動画ID> <アーカイブの動画ID>")
const OUT = path.join(import.meta.dirname, "fixtures")
const MAX_ACTIONS = 25

const anonymize = root => {
	const names = new Map()
	const alias = (map, value, make) => {
		if (!map.has(value)) map.set(value, make(map.size + 1))
		return map.get(value)
	}
	const channels = new Map()
	const emojis = new Map()
	let texts = 0
	const walk = o => {
		if (Array.isArray(o)) return o.map(walk)
		if (!o || typeof o !== "object") return o
		const out = {}
		for (const [k, v] of Object.entries(o)) {
			if (k === "authorName" && v?.simpleText) out[k] = { simpleText: alias(names, v.simpleText, i => `@user${i}`) }
			else if (k === "authorExternalChannelId" || k === "externalChannelId") out[k] = alias(channels, v, i => `UCtestchannel${String(i).padStart(10, "0")}`)
			else if (k === "text" && typeof v === "string") out[k] = `コメント${++texts}`
			else if (k === "url" && typeof v === "string") out[k] = "https://example.invalid/image.png"
			else if (k === "emoji" && v && typeof v === "object" && /^UC/.test(v.emojiId ?? "")) {
				// カスタム絵文字は配信者のチャンネルと絵文字名が分かるので、解析に必要な形だけ残す
				const n = alias(emojis, v.emojiId, i => i)
				out[k] = {
					emojiId: `UCtestemoji/${n}`,
					shortcuts: [`:emoji${n}:`],
					searchTerms: [`emoji${n}`],
					image: { thumbnails: [{ url: "https://example.invalid/image.png" }], accessibility: { accessibilityData: { label: `emoji${n}` } } },
					isCustomEmoji: v.isCustomEmoji,
				}
			} else if (k === "continuation" && typeof v === "string") out[k] = "test-continuation"
			else if (["clickTrackingParams", "params", "topic", "objectId", "protoCreationTimestampMs"].includes(k)) out[k] = "x"
			else if (["clientId", "contextMenuEndpoint", "trackingParams", "contextMenuAccessibility", "authorPhoto", "id"].includes(k))
				out[k] = typeof v === "string" ? "x" : undefined
			else out[k] = walk(v)
		}
		return out
	}
	return walk(root)
}

const browser = await webkit.launch()
const page = await browser.newPage()
await page.goto(`https://www.youtube.com/watch?v=${liveId}`, { waitUntil: "domcontentloaded" })
await page.waitForFunction(() => window.ytcfg?.get?.("INNERTUBE_CONTEXT"), null, { timeout: 30000 })
const raw = await page.evaluate(
	async ([liveId, replayId]) => {
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
		const cont = async id => {
			const r = find(await api("next", { videoId: id }), "liveChatRenderer")
			if (!r) throw new Error(`${id} にチャットがありません（配信が終わった可能性）`)
			return r.continuations?.[0]?.reloadContinuationData?.continuation ?? find(r, "continuation")
		}
		const live = await api("live_chat/get_live_chat", { continuation: await cont(liveId) })
		const replay = await api("live_chat/get_live_chat_replay", { continuation: await cont(replayId), currentPlayerState: { playerOffsetMs: "0" } })
		return { live, replay }
	},
	[liveId, replayId],
)
await browser.close()

for (const [name, res] of Object.entries(raw)) {
	const lc = res.continuationContents?.liveChatContinuation
	if (!lc) throw new Error(`${name} の応答にチャットがありません: ${JSON.stringify(res).slice(0, 200)}`)
	const trimmed = { continuationContents: { liveChatContinuation: { continuations: lc.continuations, actions: (lc.actions ?? []).slice(0, MAX_ACTIONS) } } }
	const file = path.join(OUT, `${name}.json`)
	fs.writeFileSync(file, `${JSON.stringify(anonymize(trimmed), null, "\t")}\n`)
	console.log("保存", file, `actions ${trimmed.continuationContents.liveChatContinuation.actions.length} 件`)
}

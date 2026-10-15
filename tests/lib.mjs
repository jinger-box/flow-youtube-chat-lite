// テストの共通部品
import fs from "node:fs"
import path from "node:path"

export const ROOT = path.resolve(import.meta.dirname, "..")
// SCRIPT=<パス> で別のファイル（例: 前の版）をテストできる
export const readScript = () => fs.readFileSync(process.env.SCRIPT ?? path.join(ROOT, "flow-youtube-chat-lite.user.js"), "utf8")
export const UA = {
	// iPhone の「デスクトップ用Webサイトを表示」は Mac Safari の UA を送る
	desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
	mobile: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
}
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// 検索結果ページから動画 ID を集める（liveOnly: 「ライブ」絞り込み）
export const searchIds = async (query, liveOnly) => {
	const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${liveOnly ? "&sp=EgJAAQ%253D%253D" : ""}`
	const html = await (await fetch(url, { headers: { "accept-language": "ja", "user-agent": UA.desktop } })).text()
	return [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map(m => m[1]))]
}

// YouTube のページ内で使う補助関数。openYouTube で入れ、page.evaluate の中から window.__yt.〜 で呼ぶ
const PAGE_HELPERS = () => {
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
	// チャットの種類（live / replay / none）と最初のチャット情報
	const chat = async id => {
		const r = find(await api("next", { videoId: id }), "liveChatRenderer")
		return r ? { kind: r.isReplay ? "replay" : "live", continuation: r.continuations?.[0]?.reloadContinuationData?.continuation } : { kind: "none" }
	}
	window.__yt = {
		api,
		find,
		chat,
		// ライブの直近 30 秒のコメント数（ライブでなければ -1）
		liveActivity: async id => {
			const c = await chat(id)
			if (c.kind !== "live" || !c.continuation) return -1
			const res = await api("live_chat/get_live_chat", { continuation: c.continuation })
			const since = (Date.now() - 30000) * 1000
			return (res.continuationContents?.liveChatContinuation?.actions ?? []).filter(
				a => Number(Object.values(a.addChatItemAction?.item ?? {})[0]?.timestampUsec) > since,
			).length
		},
		// アーカイブのコメントがある再生位置（秒）。最初に返ってくるコメント群の真ん中あたり
		replayStartSec: async id => {
			const c = await chat(id)
			const res = await api("live_chat/get_live_chat_replay", { continuation: c.continuation, currentPlayerState: { playerOffsetMs: "0" } })
			const offsets = (res.continuationContents?.liveChatContinuation?.actions ?? [])
				.map(a => Number(a.replayChatItemAction?.videoOffsetTimeMsec))
				.filter(n => n > 0)
			return offsets.length ? Math.max(0, Math.floor(offsets[offsets.length >> 1] / 1000) - 3) : 0
		},
	}
}

// YouTube のページを開き、ytcfg が使えるようになったら補助関数を入れる
export const openYouTube = async (browser, url = "https://www.youtube.com/") => {
	const page = await browser.newPage()
	await page.goto(url, { waitUntil: "domcontentloaded" })
	await page.waitForFunction(() => window.ytcfg?.get?.("INNERTUBE_CONTEXT"), null, { timeout: 30000 })
	await page.evaluate(PAGE_HELPERS)
	return page
}

// にぎやかなライブを探す（候補のうち直近 30 秒のコメントが一番多いもの。チャットが少ない配信だと判定を誤りやすいため）
export const findBusyLive = async (page, { queries = ["雑談", "ゲーム実況", "ニュース"], max = 5, onCandidate } = {}) => {
	const candidates = []
	for (const q of queries) {
		for (const id of (await searchIds(q, true)).slice(0, 8)) {
			if (candidates.length >= max) break
			const n = await page.evaluate(id => window.__yt.liveActivity(id), id).catch(() => -1)
			if (n < 0) continue
			candidates.push([id, n])
			onCandidate?.(id, n)
		}
		if (candidates.length >= max) break
	}
	return candidates.sort((a, b) => b[1] - a[1])[0]?.[0]
}

// チャットのリプレイがあるアーカイブを探す
export const findReplay = async (page, queries = ["雑談配信 アーカイブ", "歌枠", "ゲーム実況 配信"]) => {
	for (const q of queries)
		for (const id of (await searchIds(q, false)).slice(0, 12))
			if ((await page.evaluate(id => window.__yt.chat(id), id).catch(() => ({ kind: "none" }))).kind === "replay") return id
}

// 架空のページ（https://fyl.test/）。
// player: 偽のプレイヤー（#movie_player と video）を置く / proxy: /youtubei/ を本物の YouTube へ転送する
// （proxy でないときは外部への通信をすべて遮断する）
export const openFakePage = async (
	browser,
	{ player = true, proxy = false, playerStyle = "position:relative;width:800px;height:450px", bodyStyle = "", viewport } = {},
) => {
	const page = await browser.newPage(viewport ? { viewport, deviceScaleFactor: 2 } : undefined)
	await page.route("https://fyl.test/**", async r => {
		const u = new URL(r.request().url())
		if (proxy && u.pathname.startsWith("/youtubei/")) {
			const response = await r.fetch({
				url: `https://www.youtube.com${u.pathname}${u.search}`,
				headers: { ...r.request().headers(), origin: "https://www.youtube.com", referer: "https://www.youtube.com/" },
			})
			return r.fulfill({ response })
		}
		r.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><head></head><body style="margin:0;${bodyStyle}">${player ? `<div id="movie_player" style="${playerStyle}"><video></video></div>` : ""}</body></html>`,
		})
	})
	if (!proxy) await page.route(/^(?!https:\/\/fyl\.test\/)/, r => r.abort())
	return page
}

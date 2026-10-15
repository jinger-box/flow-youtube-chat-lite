// Flow Youtube Chat Lite の動作確認（YouTube の仕様変更で壊れていないかを調べる）
// ライブ / アーカイブ × デスクトップ表示 / モバイル表示 の 4 通りで、実際の YouTube にスクリプトを入れて確かめる。
// 使い方: npm test   （失敗するとプロセスは終了コード 1 で終わる）

import fs from "node:fs"
import path from "node:path"
import { webkit } from "playwright"

const ROOT = path.resolve(import.meta.dirname, "..")
// SCRIPT=<パス> で別のファイル（例: 前の版）を、LIVE=<動画ID> / REPLAY=<動画ID> でテスト対象の動画を指定できる
const SCRIPT = fs.readFileSync(process.env.SCRIPT ?? path.join(ROOT, "flow-youtube-chat-lite.user.js"), "utf8")
const OUT = path.join(ROOT, "test-results")
fs.mkdirSync(OUT, { recursive: true })

const UA = {
	// iPhone の「デスクトップ用Webサイトを表示」は Mac Safari の UA を送る
	desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
	mobile: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
}
const WAIT_MS = 35000

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// 検索結果ページから動画 ID を集める（sp=EgJAAQ%3D%3D は「ライブ」絞り込み）
const searchIds = async (query, liveOnly) => {
	const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${liveOnly ? "&sp=EgJAAQ%253D%253D" : ""}`
	const html = await (await fetch(url, { headers: { "accept-language": "ja", "user-agent": UA.desktop } })).text()
	return [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map(m => m[1]))]
}

// ページ内で next API を呼び、チャットがあるか・アーカイブかを調べる
const chatKind = (page, videoId) =>
	page.evaluate(async id => {
		const res = await fetch("/youtubei/v1/next?prettyPrint=false", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ context: ytcfg.get("INNERTUBE_CONTEXT"), videoId: id }),
		}).then(r => r.json())
		const stack = [res]
		while (stack.length) {
			const o = stack.pop()
			if (o && typeof o === "object") {
				if (o.liveChatRenderer) return o.liveChatRenderer.isReplay ? "replay" : "live"
				stack.push(...Object.values(o))
			}
		}
		return "none"
	}, videoId)

// アーカイブのコメントがある再生位置（秒）を返す。最初に返ってくるコメント群の真ん中あたり
const replayStartSec = (page, videoId) =>
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
		const continuation = find(find(await api("next", { videoId: id }), "liveChatRenderer"), "continuation")
		const res = await api("live_chat/get_live_chat_replay", { continuation, currentPlayerState: { playerOffsetMs: "0" } })
		const offsets = (res.continuationContents?.liveChatContinuation?.actions ?? [])
			.map(a => Number(a.replayChatItemAction?.videoOffsetTimeMsec))
			.filter(n => n > 0)
		return offsets.length ? Math.max(0, Math.floor(offsets[offsets.length >> 1] / 1000) - 3) : 0
	}, videoId)

// ライブの直近 30 秒のコメント数（チャットが少ない配信だと「流れていない」と誤判定しやすいので、にぎやかな配信を選ぶ）
const liveActivity = (page, videoId) =>
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
		const continuation = r?.continuations?.[0]?.reloadContinuationData?.continuation
		if (!continuation) return 0
		const res = await api("live_chat/get_live_chat", { continuation })
		const since = (Date.now() - 30000) * 1000
		return (res.continuationContents?.liveChatContinuation?.actions ?? [])
			.map(a => a.addChatItemAction?.item)
			.filter(Boolean)
			.filter(it => Number(Object.values(it)[0]?.timestampUsec) > since).length
	}, videoId)

const findVideos = async browser => {
	const page = await browser.newPage()
	await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" })
	await page.waitForFunction(() => window.ytcfg?.get?.("INNERTUBE_CONTEXT"), null, { timeout: 30000 })
	const found = {}
	// ライブ：候補のうち直近 30 秒のコメントが一番多いもの
	const liveCandidates = []
	for (const q of ["雑談", "ゲーム実況", "ニュース"]) {
		for (const id of (await searchIds(q, true)).slice(0, 8)) {
			if (liveCandidates.length >= 5) break
			if ((await chatKind(page, id).catch(() => "none")) === "live") liveCandidates.push(id)
		}
		if (liveCandidates.length >= 5) break
	}
	let best = -1
	for (const id of liveCandidates) {
		const n = await liveActivity(page, id).catch(() => 0)
		log("ライブ候補", id, `直近 30 秒のコメント ${n} 件`)
		if (n > best) [best, found.live] = [n, id]
	}
	// アーカイブ：チャットのリプレイがあるもの
	for (const q of ["雑談配信 アーカイブ", "歌枠", "ゲーム実況 配信"]) {
		for (const id of (await searchIds(q, false)).slice(0, 12)) {
			if ((await chatKind(page, id).catch(() => "none")) === "replay") {
				found.replay = id
				break
			}
		}
		if (found.replay) break
	}
	if (found.replay) found.replayStartSec = await replayStartSec(page, found.replay).catch(() => 0)
	await page.close()
	return found
}

const runCase = async (browser, { name, host, videoId, startSec }) => {
	const mobile = host === "mobile"
	const context = await browser.newContext({
		viewport: mobile ? { width: 393, height: 852 } : { width: 980, height: 1400 },
		isMobile: true,
		hasTouch: true,
		locale: "ja-JP",
		userAgent: UA[host],
	})
	await context.addInitScript(`if (window.top === window) {
		window.__errors = []
		// ResizeObserver のループ警告は無害（YouTube 自身も出す）なので数えない
		addEventListener("error", e => /ResizeObserver loop/.test(e.message) || __errors.push(String(e.message)))
		// テスト中に流れたコメントの総数を数える（ある瞬間の件数だとコメントの切れ目で 0 になるため）
		window.__flowed = 0
		new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.classList?.contains("fyl-chat") && __flowed++))).observe(document, { childList: true, subtree: true })
		const run = () => { ${SCRIPT} }
		if (document.readyState === "loading") addEventListener("DOMContentLoaded", run); else run()
	}`)
	const page = await context.newPage()
	const t = startSec ? `&t=${startSec}s` : ""
	await page.goto(`https://${mobile ? "m" : "www"}.youtube.com/watch?v=${videoId}${t}`, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForTimeout(8000)
	// ヘッドレスでは自動再生されないことがあるので、ミュートして再生する
	await page.evaluate(() => {
		const v = document.querySelector("#movie_player video")
		if (v) {
			v.muted = true
			v.play().catch(() => {})
		}
	})
	// 広告の再生中はコメントを流さない仕様なので、広告が終わるまで（最大 60 秒）待ってから測る
	const adWaited = await page
		.waitForFunction(() => !document.querySelector("#movie_player")?.classList.contains("ad-showing"), null, { timeout: 60000, polling: 1000 })
		.then(
			() => true,
			() => false,
		)
	await page.waitForTimeout(WAIT_MS - 8000)
	const r = await page.evaluate(() => {
		const player = document.querySelector("#movie_player")?.getBoundingClientRect()
		const chats = [...document.querySelectorAll(".fyl-chat")].map(e => ({ rect: e.getBoundingClientRect(), transform: getComputedStyle(e).transform }))
		const visible = chats.filter(c => player && c.rect.right > player.left && c.rect.left < player.right)
		return {
			player: player ? `${Math.round(player.width)}x${Math.round(player.height)}` : null,
			onScreen: chats.length,
			visible: visible.length,
			flowed: window.__flowed,
			// 左上に溜まる不具合の検出：transform が付いていない要素
			stuck: chats.filter(c => c.transform === "none").length,
			settingsButton: document.querySelectorAll(".fyl-btn").length,
			errors: window.__errors,
			// 失敗時の原因調べ用
			video: (v => (v ? `t=${v.currentTime.toFixed(1)} paused=${v.paused} readyState=${v.readyState}` : "なし"))(document.querySelector("#movie_player video")),
			// GitHub Actions の Linux 版 WebKit は YouTube の映像を再生できない（readyState=0 のまま）
			playing: (v => !!v && v.readyState >= 2 && v.currentTime > 1)(document.querySelector("#movie_player video")),
			ad: !!document.querySelector("#movie_player")?.classList.contains("ad-showing"),
			latencyMs: (p => (p?.ingestionTime ? Math.round(Date.now() - p.ingestionTime * 1000) : null))(
				document.querySelector("#movie_player")?.getProgressState?.(),
			),
			playerError: document.querySelector(".ytp-error, ytm-player-error-message-renderer")?.textContent?.trim().slice(0, 120) ?? "",
		}
	})
	// 設定画面の「状態」欄を読む
	// （プレイヤーの操作列は自動で隠れるので、クリックはページ内から直接行う）
	r.status = await page
		.evaluate(() => document.querySelector(".fyl-btn-settings")?.click())
		.then(() => page.locator(".tabs button", { hasText: "その他" }).click({ timeout: 5000 }))
		.then(() => page.locator(".status").textContent({ timeout: 5000 }))
		.catch(e => `取得失敗: ${e.message.split("\n")[0]}`)
	r.received = Number(/受信：(\d+)/.exec(r.status)?.[1] ?? 0)
	r.statusError = /エラー：なし/.test(r.status) ? "" : (/エラー：([^\n]*)/.exec(r.status)?.[1] ?? "状態欄を読めない")
	await page.screenshot({ path: path.join(OUT, `${name}.png`) })
	await context.close()
	const problems = []
	if (!adWaited) problems.push("広告が 60 秒以上終わらない")
	if (!r.player) problems.push("プレイヤーが見つからない")
	// 映像が再生できる環境では画面に流れたことまで、できない環境では受信できたことまでを確かめる
	if (r.playing && r.flowed === 0) problems.push("コメントが流れていない")
	if (!r.playing && r.received === 0) problems.push("コメントを受信していない")
	if (r.statusError) problems.push(`状態欄のエラー: ${r.statusError}`)
	if (r.stuck > 0) problems.push(`動かないコメントが ${r.stuck} 件`)
	if (r.settingsButton === 0) problems.push("設定ボタンが無い")
	if (r.errors.length) problems.push(`スクリプトエラー: ${r.errors.join(" / ")}`)
	return { name, videoId, ...r, ok: problems.length === 0, problems, note: r.playing ? "" : "映像を再生できない環境のため、画面表示は未確認" }
}

const browser = await webkit.launch()
const results = []
try {
	const videos = process.env.LIVE || process.env.REPLAY ? { live: process.env.LIVE, replay: process.env.REPLAY, replayStartSec: 0 } : await findVideos(browser)
	log("テスト対象", JSON.stringify(videos))
	const cases = []
	for (const host of ["desktop", "mobile"]) {
		if (videos.live) cases.push({ name: `live-${host}`, host, videoId: videos.live })
		if (videos.replay) cases.push({ name: `replay-${host}`, host, videoId: videos.replay, startSec: videos.replayStartSec })
	}
	const pinned = process.env.LIVE || process.env.REPLAY
	if (!pinned && !videos.live) results.push({ name: "live", ok: false, problems: ["テスト用のライブ配信が見つからない（検索結果の形が変わった可能性）"] })
	if (!pinned && !videos.replay) results.push({ name: "replay", ok: false, problems: ["テスト用のアーカイブが見つからない（next API の形が変わった可能性）"] })
	// CASES=live-desktop のように指定すると一部だけ実行する
	const only = process.env.CASES?.split(",")
	for (const c of cases.filter(c => !only || only.includes(c.name))) {
		log("実行中", c.name, c.videoId)
		results.push(await runCase(browser, c).catch(e => ({ name: c.name, videoId: c.videoId, ok: false, problems: [`例外: ${e.message}`] })))
	}
} finally {
	await browser.close()
}

for (const r of results) {
	log(
		r.ok ? "OK  " : "NG  ",
		r.name,
		r.videoId ?? "",
		r.ok ? (r.playing ? `流れたコメント ${r.flowed} 件` : `受信 ${r.received} 件（${r.note}）`) : r.problems.join(" / "),
	)
	if (!r.ok && r.status)
		log(
			"      動画:",
			r.video,
			"映像の遅れ(ms):",
			r.latencyMs,
			"広告:",
			r.ad,
			"プレイヤーのエラー:",
			r.playerError || "なし",
			"\n      状態欄:",
			r.status.replace(/\n/g, " | "),
		)
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(results, null, 2))
const failed = results.filter(r => !r.ok)
if (failed.length) {
	log(`失敗 ${failed.length} 件`)
	process.exit(1)
}
log("すべて成功")

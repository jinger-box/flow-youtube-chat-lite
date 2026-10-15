// ==UserScript==
// @name         Flow Youtube Chat Lite
// @namespace    FlowYoutubeChatLite
// @version      0.13.0
// @description  YouTube のライブチャットをニコニコ風に画面上へ流す（軽量版・パネル不要・モバイル対応）
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// @run-at       document-end
// @noframes
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/jinger-box/flow-youtube-chat-lite
// @updateURL    https://raw.githubusercontent.com/jinger-box/flow-youtube-chat-lite/main/flow-youtube-chat-lite.user.js
// @downloadURL  https://raw.githubusercontent.com/jinger-box/flow-youtube-chat-lite/main/flow-youtube-chat-lite.user.js
// ==/UserScript==

// Flow Youtube Chat (https://greasyfork.org/scripts/411442, AGPL-3.0) の機能を参考に新規実装した軽量版。
// チャット欄の DOM を読まず、YouTube 内部 API (InnerTube) から直接コメントを取得する。

;(() => {
	"use strict"

	// ---------- 設定 ----------
	const STORAGE_KEY = "fyc-lite:settings"
	const DEFAULTS = {
		enabled: true,
		size: "medium", // small | medium | large
		speed: "normal", // slow | normal | fast | auto
		area: "full", // full | upper2/3 | upper1/2
		opacity: 1,
		showAuthor: false,
		noOverlap: true,
		syncLatency: true, // ライブで映像の遅れに合わせる
		maxOnScreen: 60,
		showHeatmap: false, // アーカイブのコメントの多い場面をシークバーの上に出す（通信量が多いので既定はオフ）
		collapseRepeats: true, // 同じ文の連投を「×N」にまとめる
		hideStampOnly: false, // 絵文字・スタンプだけのコメントを流さない
		emphasizePaid: true, // スーパーチャットを大きく・ゆっくり流す
		pinStaff: false, // 配信者・モデレーターのコメントを上部に固定表示
		ngWords: [], // 文字列、または /正規表現/
		ngUsers: [], // 表示名またはチャンネルID
		highlightUsers: [], // 紫で表示するユーザー（表示名またはチャンネルID）
	}
	const SIZE_RATIO = { small: 1 / 20, medium: 1 / 15, large: 1 / 11 }
	const DURATION_MS = { slow: 8000, normal: 6000, fast: 4500 }
	// 「自動」: 直近 10 秒のコメント数（毎秒）に応じて 8 秒〜4.5 秒の間で変える
	const AUTO_SPEED = { windowMs: 10000, minRate: 0.5, maxRate: 4 }
	const arrivals = []
	const currentDuration = now => {
		if (settings.speed !== "auto") return DURATION_MS[settings.speed]
		while (arrivals.length && arrivals[0] < now - AUTO_SPEED.windowMs) arrivals.shift()
		const rate = arrivals.length / (AUTO_SPEED.windowMs / 1000)
		const t = Math.min(Math.max((rate - AUTO_SPEED.minRate) / (AUTO_SPEED.maxRate - AUTO_SPEED.minRate), 0), 1)
		return Math.round(DURATION_MS.slow + (DURATION_MS.fast - DURATION_MS.slow) * t)
	}
	const AREA_RATIO = { full: 1, "upper2/3": 2 / 3, "upper1/2": 1 / 2 }
	const COLORS = { normal: "#ffffff", member: "#ffffff", moderator: "#7fb2ff", owner: "#ffd84d", highlight: "#c58cff" }
	const LINE_HEIGHT = 1.2
	const GAP_PX = 16

	const loadSettings = (raw = localStorage.getItem(STORAGE_KEY)) => {
		let saved = {}
		try {
			saved = JSON.parse(raw ?? "{}") ?? {}
		} catch {}
		// 型が既定値と違う値は捨てる（壊れた保存値で NaN にならないように）
		return Object.fromEntries(
			Object.entries(DEFAULTS).map(([k, d]) => {
				const v = saved[k]
				const ok = Array.isArray(d) ? Array.isArray(v) : typeof v === typeof d && !(typeof v === "number" && !Number.isFinite(v))
				return [k, ok ? v : d]
			}),
		)
	}
	const settings = loadSettings()

	// ページ側の window。@grant を付けると拡張によってはページから切り離された環境で動くので、
	// ytcfg などページの値は unsafeWindow を通して読む（無ければ同じ window）
	const pageWindow = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window

	// ---------- YouTube 依存の値（仕様変更で壊れたら、まずここを直す） ----------
	// 要素は候補を先頭から順に探す。1 つ目が見つからなくなっても 2 つ目以降で動き続けるようにする
	const YT = {
		selectors: {
			player: ["#movie_player", ".html5-video-player"],
			video: ["video.html5-main-video", "video"],
			desktopControls: [".ytp-right-controls", ".ytp-chrome-controls .ytp-right-controls"],
			progressBar: [".ytp-progress-bar-container", "ytm-progress-bar", ".ytm-progress-bar"],
			mobileActionBar: ["ytm-slim-video-action-bar-renderer .slim-video-action-bar-actions", "ytm-slim-video-action-bar-renderer"],
		},
		adShowingClass: "ad-showing",
		endpoints: { next: "next", live: "live_chat/get_live_chat", replay: "live_chat/get_live_chat_replay" },
		// API で取れないときの予備（www のライブのみ）: チャット専用ページの HTML から continuation を拾う
		liveChatPage: videoId => `/live_chat?v=${videoId}&is_popout=1`,
		liveChatPageContinuation: /"continuation":"(0ofMy[^"]+)"/,
		livePath: /^\/live\/([\w-]{11})/,
		navigateEvents: ["yt-navigate-finish", "state-navigateend"],
	}
	const pick = (selectors, root = document) => {
		for (const sel of selectors) {
			const el = root.querySelector(sel)
			if (el) return el
		}
		return null
	}

	// ---------- 動作状態（設定画面の「状態」欄に出す） ----------
	const status = { mode: "待機中", source: "-", received: 0, lastOk: 0, error: "", heatmap: "-" }
	const setStatus = patch => Object.assign(status, patch)

	// ---------- InnerTube API ----------
	const isMobileSite = location.hostname === "m.youtube.com"
	const FALLBACK_WEB_VERSION = "2.20251014.01.00"

	const innertubeContext = () => {
		const ctx = structuredClone(pageWindow.ytcfg?.get?.("INNERTUBE_CONTEXT") ?? { client: {} })
		if (isMobileSite) {
			// m.youtube.com (MWEB) の応答にはチャット情報が無いので WEB クライアントとして呼ぶ。
			// WEB と MWEB のバージョンは同じ日付形式なので MWEB の値を流用する
			ctx.client.clientName = "WEB"
			ctx.client.clientVersion = /^2\.\d{8}/.test(ctx.client.clientVersion ?? "") ? ctx.client.clientVersion : FALLBACK_WEB_VERSION
		}
		return ctx
	}

	// 応答が返らないまま取得が止まらないよう、通信は 10 秒で打ち切る（打ち切りは通常の失敗として再試行される）
	const FETCH_TIMEOUT_MS = 10000
	const withTimeout = signal => (AbortSignal.any && AbortSignal.timeout ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : signal)
	const describeError = e => (e?.name === "TimeoutError" ? `通信がタイムアウトしました（${FETCH_TIMEOUT_MS / 1000} 秒）` : (e?.message ?? String(e)))

	const api = async (endpoint, body, signal) => {
		const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ context: innertubeContext(), ...body }),
			credentials: "same-origin",
			signal: withTimeout(signal),
		})
		if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`)
		return res.json()
	}

	const findKey = (obj, key) => {
		const stack = [obj]
		while (stack.length) {
			const o = stack.pop()
			if (!o || typeof o !== "object") continue
			if (key in o) return o[key]
			stack.push(...Object.values(o))
		}
		return undefined
	}

	// 動画のチャット情報（初回の continuation とアーカイブかどうか）を取得する。
	// 1. ページに埋め込まれた初期データ（www、API 呼び出しを 1 回省ける。SPA 遷移後は古いので動画 ID を照合）
	// 2. next API
	// 3. チャット専用ページの HTML（www のライブのみの予備）
	const fetchChatInfo = async (videoId, signal) => {
		const fromNext = next => {
			const renderer = findKey(next, "liveChatRenderer")
			if (!renderer) return null
			const continuation = renderer.continuations?.[0]?.reloadContinuationData?.continuation ?? findKey(renderer, "continuation")
			return continuation ? { continuation, isReplay: !!renderer.isReplay } : null
		}
		const initial = pageWindow.ytInitialData
		if (initial?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId) {
			const info = fromNext(initial)
			if (info) return { ...info, source: "ページの初期データ" }
		}
		let apiError = null
		try {
			const info = fromNext(await api(YT.endpoints.next, { videoId }, signal))
			if (info) return { ...info, source: "API" }
		} catch (e) {
			if (signal.aborted) throw e
			apiError = e
		}
		if (!isMobileSite) {
			try {
				const html = await (await fetch(YT.liveChatPage(videoId), { credentials: "same-origin", signal: withTimeout(signal) })).text()
				const continuation = YT.liveChatPageContinuation.exec(html)?.[1]
				if (continuation) return { continuation, isReplay: false, source: "チャットページ（予備）" }
			} catch (e) {
				if (signal.aborted) throw e
			}
		}
		if (apiError) throw apiError
		return null
	}

	// ---------- チャット項目の解析 ----------
	/**
	 * 画面に流すコメント 1 件
	 * @typedef {{ text?: string, img?: string, alt?: string }} ChatPart
	 * @typedef {{
	 *   id?: string, ts: number, author: string, channelId: string,
	 *   type: "normal" | "member" | "moderator" | "owner",
	 *   parts: ChatPart[], paid?: string, paidColor?: string, photo?: string
	 * }} Chat
	 */
	const runsToParts = runs =>
		(runs ?? []).map(r => {
			if (r.text !== undefined) return { text: r.text }
			const e = r.emoji
			if (!e) return { text: "" }
			// 標準の絵文字は文字として、カスタム絵文字は画像として出す
			if (!e.isCustomEmoji && e.emojiId && !/^UC/.test(e.emojiId)) return { text: e.emojiId }
			return { img: e.image?.thumbnails?.at(-1)?.url, alt: e.shortcuts?.[0] ?? "" }
		})

	const authorType = r => {
		const badges = (r.authorBadges ?? []).map(b => b.liveChatAuthorBadgeRenderer)
		if (badges.some(b => b?.icon?.iconType === "OWNER")) return "owner"
		if (badges.some(b => b?.icon?.iconType === "MODERATOR")) return "moderator"
		if (badges.some(b => b?.customThumbnail)) return "member"
		return "normal"
	}

	const argbToCss = n => (typeof n === "number" ? `#${(n & 0xffffff).toString(16).padStart(6, "0")}` : undefined)

	const parseItem = item => {
		const [kind, r] = Object.entries(item ?? {})[0] ?? []
		if (!r) return null
		const base = {
			id: r.id,
			ts: Number(r.timestampUsec) / 1000 || Date.now(),
			author: r.authorName?.simpleText ?? "",
			channelId: r.authorExternalChannelId ?? "",
			photo: r.authorPhoto?.thumbnails?.at(-1)?.url ?? "",
			type: authorType(r),
		}
		switch (kind) {
			case "liveChatTextMessageRenderer":
				return { ...base, parts: runsToParts(r.message?.runs) }
			case "liveChatPaidMessageRenderer":
				return {
					...base,
					paid: r.purchaseAmountText?.simpleText ?? "",
					paidColor: argbToCss(r.bodyBackgroundColor),
					parts: runsToParts(r.message?.runs),
				}
			case "liveChatPaidStickerRenderer":
				return {
					...base,
					paid: r.purchaseAmountText?.simpleText ?? "",
					paidColor: argbToCss(r.backgroundColor),
					parts: [{ img: r.sticker?.thumbnails?.at(-1)?.url, alt: "sticker" }],
				}
			case "liveChatMembershipItemRenderer":
				return { ...base, type: "member", parts: runsToParts(r.headerSubtext?.runs ?? r.message?.runs) }
			default:
				return null
		}
	}

	const itemsFromActions = actions =>
		(actions ?? [])
			.map(a => a.addChatItemAction?.item)
			.filter(Boolean)
			.map(parseItem)
			.filter(Boolean)

	// ---------- NG ----------
	const ngMatchers = () =>
		settings.ngWords.map(w => {
			const m = /^\/(.+)\/([a-z]*)$/.exec(w)
			if (m) {
				try {
					const re = new RegExp(m[1], m[2])
					return s => re.test(s)
				} catch {}
			}
			return s => s.includes(w)
		})
	// ユーザー指定の照合。表示名の先頭の @ の有無と大文字・小文字は区別しない
	const userKey = s => s.trim().replace(/^@/, "").toLowerCase()
	const userMatcher = list => {
		const keys = new Set(list.map(userKey))
		return chat => keys.has(userKey(chat.author)) || (!!chat.channelId && keys.has(userKey(chat.channelId)))
	}
	/** @type {(chat: Chat) => boolean} */
	let isNg = () => false
	/** @type {(chat: Chat) => boolean} */
	let isHighlighted = () => false
	const rebuildNg = () => {
		const words = ngMatchers()
		const isNgUser = userMatcher(settings.ngUsers)
		isNg = chat => {
			if (isNgUser(chat)) return true
			const text = chat.parts.map(p => p.text ?? "").join("")
			return words.some(f => f(text))
		}
		isHighlighted = userMatcher(settings.highlightUsers)
	}
	rebuildNg()

	// ---------- 描画 ----------
	const style = document.createElement("style")
	style.textContent = `
.fyl-screen { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 30; contain: strict; }
.fyl-screen.fyl-paused .fyl-chat { animation-play-state: paused; }
.fyl-chat {
	position: absolute; left: 100%; top: 0; white-space: nowrap; line-height: ${LINE_HEIGHT};
	font-weight: 700; color: #fff; will-change: transform; user-select: none;
	text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000;
	animation: fyl-flow var(--fyl-dur) linear forwards;
}
.fyl-chat img { height: 1em; width: auto; vertical-align: -0.12em; }
.fyl-chat .fyl-author { font-size: 0.7em; opacity: 0.85; margin-right: 0.3em; }
.fyl-chat .fyl-paid { padding: 0 0.3em; border-radius: 0.2em; margin-right: 0.3em; color: #fff; }
.fyl-chat.fyl-big { font-size: 1.3em; }
.fyl-chat img.fyl-avatar, .fyl-pin img.fyl-avatar { width: 1em; height: 1em; border-radius: 50%; object-fit: cover; margin-right: 0.25em; }
.fyl-heat { position: absolute; left: 0; right: 0; bottom: 100%; height: 28px; pointer-events: none; }
.fyl-heat svg { display: block; width: 100%; height: 100%; }
.fyl-heat path { fill: rgba(197, 140, 255, 0.55); }
.fyl-heat.fyl-heat-fallback { bottom: 0; height: 14px; opacity: 0.7; z-index: 31; }
.fyl-count { font-size: 0.75em; margin-left: 0.3em; color: #ffe08a; }
.fyl-pinned { position: absolute; top: 0.2em; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 0.15em; max-width: 90%; }
.fyl-pin { font-size: 0.9em; font-weight: 700; line-height: 1.2; padding: 0.1em 0.5em; border-radius: 0.3em; background: rgba(0,0,0,.45);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000; }
.fyl-pin img { height: 1em; width: auto; vertical-align: -0.12em; }
@keyframes fyl-flow { from { transform: translateX(0); } to { transform: translateX(calc(-1 * var(--fyl-pw) - 100%)); } }
`

	const screen = document.createElement("div")
	screen.className = "fyl-screen"

	const state = {
		player: null,
		video: null,
		pw: 0,
		ph: 0,
		fontPx: 0,
		lanes: [], // 各レーンの最後のコメント { t0, w, dur }
		onScreen: 0,
		pseudoFs: false, // 疑似全画面中
	}

	const layout = () => {
		if (!state.player) return
		const r = state.player.getBoundingClientRect()
		state.pw = r.width
		state.ph = r.height
		state.fontPx = Math.max(10, Math.round(r.height * SIZE_RATIO[settings.size]))
		const laneCount = Math.max(1, Math.floor((r.height * AREA_RATIO[settings.area]) / (state.fontPx * LINE_HEIGHT)))
		state.lanes.length = laneCount
		screen.style.setProperty("--fyl-pw", `${r.width}px`)
		screen.style.fontSize = `${state.fontPx}px`
		screen.style.opacity = String(settings.opacity)
	}
	// コールバック内でスタイルを変えると ResizeObserver のループ警告が出るので次フレームに回す
	let layoutQueued = false
	const resizeObserver = new ResizeObserver(() => {
		if (layoutQueued) return
		layoutQueued = true
		requestAnimationFrame(() => {
			layoutQueued = false
			layout()
		})
	})

	// 新しいコメント（幅 w）を置けるレーンを探す。追い越し・重なりが起きないレーンの中で一番上
	// 新しいコメント（幅 w）を置けるレーンを探す。追い越し・重なりが起きないレーンの中で一番上。
	// span は使うレーン数（大きく表示するスーパーチャットは 2）
	const laneIsFree = (last, vNew, now) => {
		if (!last) return true
		const vPrev = (state.pw + last.w) / last.dur
		const entered = vPrev * (now - last.t0) >= last.w + GAP_PX
		const remaining = last.t0 + last.dur - now
		return entered && (remaining <= 0 || vNew * remaining <= state.pw - GAP_PX)
	}
	const pickLane = (w, dur, now, span = 1) => {
		const vNew = (state.pw + w) / dur
		const n = Math.min(span, state.lanes.length)
		let fallback = 0
		let oldest = Number.POSITIVE_INFINITY
		for (let i = 0; i + n <= state.lanes.length; i++) {
			let free = true
			for (let j = i; j < i + n && free; j++) free = laneIsFree(state.lanes[j], vNew, now)
			if (free) return i
			const t0 = state.lanes[i]?.t0 ?? Number.NEGATIVE_INFINITY
			if (t0 < oldest) {
				oldest = t0
				fallback = i
			}
		}
		return settings.noOverlap ? -1 : fallback
	}

	// コメント要素は流れ終わっても捨てずに使い回す（作成と破棄を減らして混雑時の負荷を下げる）
	const POOL_MAX = 100
	const pool = []
	const releaseChatElement = (el, counted) => {
		el.remove()
		if (counted) state.onScreen--
		if (pool.length < POOL_MAX) pool.push(el)
	}
	const acquireChatElement = () => {
		const el = pool.pop()
		if (el) {
			el.replaceChildren()
			el.className = "fyl-chat"
			el.style.cssText = ""
			return el
		}
		const created = document.createElement("span")
		created.className = "fyl-chat"
		created.addEventListener("animationend", () => releaseChatElement(created, true))
		return created
	}

	// コメントの中身（金額・投稿者名・本文）を el に入れる
	const fillChat = (el, chat) => {
		el.style.color = isHighlighted(chat) ? COLORS.highlight : COLORS[chat.type]
		if (chat.paid) {
			const paid = document.createElement("span")
			paid.className = "fyl-paid"
			paid.textContent = chat.paid
			if (chat.paidColor) paid.style.background = chat.paidColor
			el.append(paid)
		}
		// 紫で表示するユーザーは、アイコンと名前を必ず付ける
		const highlighted = isHighlighted(chat)
		if (highlighted && chat.photo) {
			const icon = document.createElement("img")
			icon.className = "fyl-avatar"
			icon.src = chat.photo
			icon.alt = ""
			icon.decoding = "async"
			el.append(icon)
		}
		if ((settings.showAuthor || highlighted) && chat.author) {
			const a = document.createElement("span")
			a.className = "fyl-author"
			a.textContent = chat.author
			el.append(a)
		}
		for (const p of chat.parts) {
			if (p.img) {
				const img = document.createElement("img")
				img.src = p.img
				img.alt = p.alt
				img.decoding = "async"
				el.append(img)
			} else if (p.text) {
				el.append(p.text)
			}
		}
		return el
	}
	const buildChatElement = chat => fillChat(acquireChatElement(), chat)

	// 絵文字・スタンプだけのコメント（本文に文字が無い）
	const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\u200D|\s)+$/u
	const isStampOnly = chat =>
		chat.parts.length > 0 && chat.parts.every(p => p.img || !p.text?.trim() || EMOJI_ONLY.test(p.text)) && chat.parts.some(p => p.img || p.text?.trim())

	// 連投まとめ：同じ文が 5 秒以内に来たら新しく流さず、画面上の元のコメントに「×N」を付ける。
	// 要素は使い回すので、覚えた要素が別のコメントに使われていないかを通し番号で確かめる
	const REPEAT_WINDOW_MS = 5000
	const repeats = new Map() // 文 -> { el, seq, count, t }
	let chatSeq = 0
	const repeatKey = chat =>
		chat.parts
			.map(p => p.text ?? p.alt ?? "")
			.join("")
			.trim()
	const bumpRepeat = (chat, now) => {
		const k = repeatKey(chat)
		const r = k && repeats.get(k)
		if (!r || r.el.fylSeq !== r.seq || !r.el.isConnected || now - r.t > REPEAT_WINDOW_MS) return false
		r.count++
		r.t = now
		let badge = r.el.querySelector(".fyl-count")
		if (!badge) {
			badge = document.createElement("span")
			badge.className = "fyl-count"
			r.el.append(badge)
		}
		badge.textContent = `×${r.count}`
		return true
	}
	const rememberRepeat = (chat, el, now) => {
		const k = repeatKey(chat)
		if (!k) return
		el.fylSeq = ++chatSeq
		repeats.delete(k)
		repeats.set(k, { el, seq: el.fylSeq, count: 1, t: now })
		if (repeats.size > 200) repeats.delete(repeats.keys().next().value)
	}

	// 配信者・モデレーターのコメントを、流さずに画面上部へ 5 秒固定表示する（最大 3 件）
	const PIN = { ms: 5000, max: 3 }
	const pinned = document.createElement("div")
	pinned.className = "fyl-pinned"
	const pinChat = chat => {
		if (!pinned.isConnected) screen.append(pinned)
		const el = fillChat(document.createElement("div"), chat)
		el.className = "fyl-pin"
		pinned.append(el)
		while (pinned.children.length > PIN.max) pinned.firstElementChild.remove()
		setTimeout(() => el.remove(), PIN.ms)
	}

	// スーパーチャットを目立たせるときの大きさは CSS（.fyl-big）、速さはこの倍率
	const PAID_SLOWER = 1.3

	const flow = chat => {
		if (!settings.enabled || !state.player || state.pw === 0) return
		if (isNg(chat)) return
		if (chat.parts.length === 0 && !chat.paid) return
		if (settings.hideStampOnly && !chat.paid && isStampOnly(chat)) return
		const now = performance.now()
		arrivals.push(now)
		if (settings.pinStaff && (chat.type === "owner" || chat.type === "moderator")) return pinChat(chat)
		if (settings.collapseRepeats && !chat.paid && bumpRepeat(chat, now)) return
		if (state.onScreen >= settings.maxOnScreen) return
		const big = settings.emphasizePaid && !!chat.paid
		const el = buildChatElement(chat)
		if (big) el.classList.add("fyl-big")
		const dur = Math.round(currentDuration(now) * (big ? PAID_SLOWER : 1))
		el.style.visibility = "hidden"
		el.style.animation = "none"
		screen.append(el)
		const w = el.getBoundingClientRect().width
		const span = big ? 2 : 1
		const lane = pickLane(w, dur, now, span)
		if (lane < 0) return releaseChatElement(el, false)
		for (let j = lane; j < Math.min(lane + span, state.lanes.length); j++) state.lanes[j] = { t0: now, w, dur }
		el.style.top = `${lane * state.fontPx * LINE_HEIGHT}px`
		el.style.setProperty("--fyl-dur", `${dur}ms`)
		el.style.animation = ""
		el.style.visibility = ""
		state.onScreen++
		rememberRepeat(chat, el, now)
	}

	const clearScreen = () => {
		pinned.replaceChildren()
		repeats.clear()
		for (const el of [...screen.children]) if (el.classList.contains("fyl-chat")) releaseChatElement(el, false)
		state.lanes = new Array(state.lanes.length)
		state.onScreen = 0
	}

	// ---------- チャット取得のループ ----------
	const sleep = (ms, signal) =>
		new Promise((resolve, reject) => {
			const t = setTimeout(resolve, ms)
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(t)
					reject(signal.reason)
				},
				{ once: true },
			)
		})

	const isAdShowing = () => state.player?.classList.contains(YT.adShowingClass)

	// 最近コメントした人（新しい順に最大 30 人）。設定画面からタップで紫・NG に追加するために使う
	const RECENT_MAX = 30
	const recentAuthors = new Map() // userKey -> { author, text }
	const rememberAuthor = chat => {
		if (!chat.author) return
		const k = userKey(chat.author)
		recentAuthors.delete(k)
		recentAuthors.set(k, {
			author: chat.author,
			text: chat.parts
				.map(p => p.text ?? p.alt ?? "")
				.join("")
				.slice(0, 40),
		})
		if (recentAuthors.size > RECENT_MAX) recentAuthors.delete(recentAuthors.keys().next().value)
	}

	// 表示待ちの列。ライブもアーカイブも「この時刻になったら流す」コメントをここに入れ、
	// 1 つの処理で取り出して流す。時刻の基準はセッションごとに clock が決める
	// （ライブ: 実時刻 ms、アーカイブ: 動画の再生位置 ms）
	const PUMP_MS = 100
	const STALE_MS = 6000
	const queue = { items: [], clock: null }
	const enqueue = entries => {
		if (!entries.length) return
		queue.items.push(...entries)
		queue.items.sort((a, b) => a.due - b.due)
	}
	const resetQueue = clock => {
		queue.items.length = 0
		queue.clock = clock
	}
	setInterval(() => {
		if (!queue.clock || !queue.items.length) return
		const now = queue.clock()
		// 動画の一時停止中・広告中に時刻が来たもの、時刻から 6 秒以上過ぎたもの（最新の位置へ戻った直後など）は
		// 流さずに捨てる（まとめて流れないように）
		const blocked = !state.video || state.video.paused || isAdShowing()
		while (queue.items.length && queue.items[0].due <= now) {
			const { chat, due } = queue.items.shift()
			if (blocked || now - due > STALE_MS) continue
			rememberAuthor(chat)
			flow(chat)
		}
	}, PUMP_MS)

	// ライブ: YouTube の指示（timeoutMs、通常 10 秒）は待たずに短い間隔で取得する。
	// 受信したコメントは投稿時刻付きで貯めておき、「今映っている映像が配信された時刻」（ingestionTime）に
	// 投稿されたものを流す。巻き戻したときも、貯めた中からその時点のコメントを流せる
	// （YouTube には配信中の過去のコメントを取り出す API が無いので、ページを開く前の時間帯は出せない）
	const LIVE = { pollMs: 1500, rhythmMs: 3000, rewindMs: 30000, jumpBackMs: 3000, historyMax: 20000, checkMs: 500 }
	// 映っている映像の配信時刻（ms）。取れなければ実時刻
	const liveVideoClock = () => {
		const t = state.player?.getProgressState?.()?.ingestionTime
		return t ? t * 1000 : Date.now()
	}
	// 表示の基準時刻。巻き戻し中（遅れ 30 秒超）と「映像の遅れに合わせる」のときは映像の時刻、
	// それ以外は「今から 3 秒前」（取得の間隔と届くまでの時間を吸収し、投稿の間隔を保って流す）
	const liveClock = () => {
		const relaxed = Date.now() - LIVE.rhythmMs
		const video = liveVideoClock()
		if (Date.now() - video > LIVE.rewindMs) return video
		return settings.syncLatency ? Math.min(video, relaxed) : relaxed
	}
	const runLive = async (continuation, signal) => {
		resetQueue(liveClock)
		const history = [] // 投稿時刻の昇順
		let lastClock = liveClock()
		// 巻き戻しを見つけたら、貯めたコメントからその時刻以降を列に入れ直す
		const watcher = setInterval(() => {
			const now = liveClock()
			if (now < lastClock - LIVE.jumpBackMs) {
				resetQueue(liveClock)
				clearScreen()
				enqueue(history.filter(chat => chat.ts >= now).map(chat => ({ due: chat.ts, chat })))
			}
			lastClock = now
			const behind = Date.now() - liveVideoClock()
			const rewound = behind > LIVE.rewindMs
			const beforeHistory = rewound && (!history.length || now < history[0].ts)
			setStatus({
				mode: rewound ? `ライブ（${Math.round(behind / 60000)} 分巻き戻し中${beforeHistory ? "：この時点のコメントは保存されていません" : ""}）` : "ライブ",
			})
		}, LIVE.checkMs)
		signal.addEventListener("abort", () => clearInterval(watcher), { once: true })
		let failures = 0
		while (!signal.aborted) {
			let lc
			try {
				const res = await api(YT.endpoints.live, { continuation }, signal)
				lc = res.continuationContents?.liveChatContinuation
				failures = 0
				setStatus({ lastOk: Date.now(), error: "" })
			} catch (e) {
				if (signal.aborted) return
				// 失敗が続くほど間隔を広げる（最大 30 秒）
				failures++
				setStatus({ error: `${describeError(e)}（${failures} 回連続）` })
				console.warn("[FYC Lite]", e)
				await sleep(Math.min(LIVE.pollMs * 2 ** failures, 30000), signal)
				continue
			}
			const c = lc?.continuations?.[0]
			const data = c && Object.values(c)[0]
			if (!data?.continuation) {
				clearInterval(watcher)
				return setStatus({ mode: "ライブ（配信終了）" })
			}
			continuation = data.continuation
			const items = itemsFromActions(lc.actions)
			status.received += items.length
			if (items.length) {
				const outOfOrder = history.length && items[0].ts < history.at(-1).ts
				history.push(...items)
				if (outOfOrder) history.sort((a, b) => a.ts - b.ts)
				if (history.length > LIVE.historyMax) history.splice(0, history.length - LIVE.historyMax)
				enqueue(items.map(chat => ({ due: chat.ts, chat })))
			}
			await sleep(LIVE.pollMs, signal)
		}
	}

	// アーカイブ: 再生位置の 15 秒先まで先読みし、videoOffsetTimeMsec を表示時刻として列に入れる
	const REPLAY = { checkMs: 500, prefetchMs: 15000, seekJumpMs: 3000 }
	const runReplay = async (initialContinuation, signal) => {
		session.replayContinuation = initialContinuation
		startHeatmap()
		const videoMs = () => (state.video?.currentTime ?? 0) * 1000
		resetQueue(videoMs)
		let continuation = initialContinuation
		let bufferedUntil = -1
		let lastMs = -1
		let lastCheck = 0

		const fetchFrom = async offsetMs => {
			const res = await api(YT.endpoints.replay, { continuation, currentPlayerState: { playerOffsetMs: String(Math.max(0, Math.floor(offsetMs))) } }, signal)
			const lc = res.continuationContents?.liveChatContinuation
			const next = lc?.continuations?.[0]?.liveChatReplayContinuationData?.continuation
			const from = videoMs()
			const entries = []
			for (const a of lc?.actions ?? []) {
				const r = a.replayChatItemAction
				if (!r) continue
				const due = Number(r.videoOffsetTimeMsec)
				// 今の再生位置より前のコメントは流さない
				if (due > from) for (const chat of itemsFromActions(r.actions)) entries.push({ due, chat })
				bufferedUntil = Math.max(bufferedUntil, due)
			}
			enqueue(entries)
			setStatus({ lastOk: Date.now(), error: "", received: status.received + (lc?.actions?.length ?? 0) })
			if (next) continuation = next
			else bufferedUntil = Infinity // 最後まで読み終えた
		}

		while (!signal.aborted) {
			await sleep(REPLAY.checkMs, signal)
			if (!state.video || isAdShowing()) continue
			const nowMs = videoMs()
			const wall = performance.now()
			// シーク（再生の進みと 3 秒以上ずれたジャンプ）したら読み直す
			if (lastMs >= 0) {
				const expected = lastMs + (state.video.paused ? 0 : (wall - lastCheck) * state.video.playbackRate)
				if (Math.abs(nowMs - expected) > REPLAY.seekJumpMs) {
					resetQueue(videoMs)
					clearScreen()
					continuation = initialContinuation
					bufferedUntil = -1
				}
			}
			lastMs = nowMs
			lastCheck = wall
			if (bufferedUntil < nowMs + REPLAY.prefetchMs) {
				await fetchFrom(bufferedUntil < 0 ? nowMs : bufferedUntil).catch(e => {
					if (signal.aborted) return
					setStatus({ error: describeError(e) })
					console.warn("[FYC Lite]", e)
				})
			}
		}
	}

	// ---------- コメントの多い場面（アーカイブ） ----------
	// チャットを最初から最後まで読み、再生位置ごとのコメント数をシークバーの上にグラフで出す。
	// 2 時間の配信で通信が約 200 回・約 17MB になるので、設定でオンにしたときだけ動かし、間隔を空けて少しずつ読む
	const HEAT = { bins: 150, gapMs: 150 }
	const heat = { el: null, path: null, counts: null, abort: null }
	const removeHeatmap = () => {
		heat.abort?.abort()
		heat.el?.remove()
		Object.assign(heat, { el: null, path: null, counts: null, abort: null })
		setStatus({ heatmap: "-" })
	}
	// シークバーの上に置く。見つからないとき（m など）はプレイヤー下端に細く出す
	const placeHeatmap = () => {
		if (!heat.el || !state.player) return
		const bar = pick(YT.selectors.progressBar, state.player)
		heat.el.classList.toggle("fyl-heat-fallback", !bar)
		const parent = bar ?? state.player
		if (heat.el.parentElement !== parent) parent.append(heat.el)
	}
	const drawHeatmap = () => {
		const c = heat.counts
		const max = Math.max(1, ...c)
		// 隣の区間と平均してなだらかにする
		const y = i => (100 - (((c[i - 1] ?? c[i]) + c[i] * 2 + (c[i + 1] ?? c[i])) / 4 / max) * 100).toFixed(1)
		heat.path.setAttribute("d", `M0,100 ${c.map((_, i) => `L${i},${y(i)} L${i + 1},${y(i)}`).join(" ")} L${c.length},100 Z`)
	}
	const startHeatmap = () => {
		removeHeatmap()
		const continuation = session.replayContinuation
		if (!settings.showHeatmap || !continuation) return
		const controller = new AbortController()
		heat.abort = controller
		session.abort?.signal.addEventListener("abort", () => controller.abort(), { once: true })
		const { signal } = controller
		;(async () => {
			// 動画の長さが分かるまで待つ
			while (!(state.video?.duration > 0 && Number.isFinite(state.video.duration))) await sleep(500, signal)
			const durMs = state.video.duration * 1000
			heat.counts = new Array(HEAT.bins).fill(0)
			const ns = "http://www.w3.org/2000/svg"
			const svg = document.createElementNS(ns, "svg")
			svg.setAttribute("viewBox", `0 0 ${HEAT.bins} 100`)
			svg.setAttribute("preserveAspectRatio", "none")
			heat.path = document.createElementNS(ns, "path")
			svg.append(heat.path)
			heat.el = h("div", { class: "fyl-heat" }, svg)
			placeHeatmap()
			const seen = new Set() // 区間の重なりで同じコメントを二重に数えないため
			let cont = continuation
			let offset = 0
			while (cont) {
				const res = await api(YT.endpoints.replay, { continuation: cont, currentPlayerState: { playerOffsetMs: String(Math.floor(offset)) } }, signal)
				const lc = res.continuationContents?.liveChatContinuation
				for (const a of lc?.actions ?? []) {
					const r = a.replayChatItemAction
					if (!r) continue
					const t = Number(r.videoOffsetTimeMsec)
					offset = Math.max(offset, t)
					for (const x of r.actions ?? []) {
						const item = x.addChatItemAction?.item
						const id = item && Object.values(item)[0]?.id
						if (!id || seen.has(id)) continue
						seen.add(id)
						heat.counts[Math.min(HEAT.bins - 1, Math.max(0, Math.floor((t / durMs) * HEAT.bins)))]++
					}
				}
				drawHeatmap()
				setStatus({ heatmap: `読み込み中 ${Math.min(100, Math.round((offset / durMs) * 100))}%（${seen.size} 件）` })
				cont = lc?.continuations?.[0]?.liveChatReplayContinuationData?.continuation
				if (cont) await sleep(HEAT.gapMs, signal)
			}
			setStatus({ heatmap: `完了（${seen.size} 件）` })
		})().catch(e => {
			if (signal.aborted) return
			setStatus({ heatmap: `失敗：${describeError(e)}` })
			console.warn("[FYC Lite]", e)
		})
	}

	// ---------- 設定画面 ----------
	// 設定は localStorage（表示ごと）と、拡張の保存領域（www と m で共有）の両方に書く
	const hasGM = typeof GM === "object" && typeof GM?.getValue === "function"
	const SHARED = { settings: "settings", mergedHosts: "mergedHosts" }
	const LIST_KEYS = ["ngWords", "ngUsers", "highlightUsers"]
	const saveSettings = () => {
		const json = JSON.stringify(settings)
		try {
			localStorage.setItem(STORAGE_KEY, json)
		} catch {}
		if (hasGM) GM.setValue(SHARED.settings, json).catch(e => console.warn("[FYC Lite]", e))
	}
	const applyAllSettings = () => {
		rebuildNg()
		layout()
		updateButtons()
	}
	// 共有の保存領域から読み直す。この表示で初めて共有するときは、紫・NG などの一覧を足し合わせて
	// 片方の表示で登録した分が消えないようにする。
	// （Macaque は既定値が 0 / false / "" のとき GM.getValue が undefined を返すので、既定値は渡さない）
	const syncFromShared = async () => {
		if (!hasGM) return
		try {
			const raw = await GM.getValue(SHARED.settings)
			const next = typeof raw === "string" ? loadSettings(raw) : { ...settings }
			let hosts = []
			try {
				hosts = JSON.parse((await GM.getValue(SHARED.mergedHosts)) ?? "[]")
			} catch {}
			if (!Array.isArray(hosts)) hosts = []
			if (!hosts.includes(location.hostname)) {
				for (const k of LIST_KEYS) next[k] = [...new Set([...next[k], ...settings[k]])]
				await GM.setValue(SHARED.mergedHosts, JSON.stringify([...hosts, location.hostname]))
			}
			const changed = JSON.stringify(next) !== JSON.stringify(settings)
			Object.assign(settings, next)
			if (changed || typeof raw !== "string") saveSettings()
			if (changed) applyAllSettings()
		} catch (e) {
			console.warn("[FYC Lite]", e)
		}
	}

	// YouTube は Trusted Types を強制するので innerHTML は使わず DOM API で組み立てる
	const h = (tag, props = {}, ...children) => {
		const el = document.createElement(tag)
		for (const [k, v] of Object.entries(props)) {
			if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
			else if (k === "class") el.className = v
			else if (k in el) el[k] = v
			else el.setAttribute(k, v)
		}
		el.append(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false))
		return el
	}
	const ICON = {
		// 吹き出しの中を横に流れる線
		settings: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm3 4v1.6h10V9H7zm-1 3.4V14h7v-1.6H6z",
		fullscreen: "M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z",
		exitFullscreen: "M8 5h2v5H5V8h3zm6 0h2v3h3v2h-5zM5 14h5v5H8v-3H5zm9 0h5v2h-3v3h-2z",
	}
	const svgIcon = d => {
		const ns = "http://www.w3.org/2000/svg"
		const svg = document.createElementNS(ns, "svg")
		svg.setAttribute("viewBox", "0 0 24 24")
		svg.setAttribute("width", "100%")
		svg.setAttribute("height", "100%")
		const path = document.createElementNS(ns, "path")
		path.setAttribute("d", d)
		path.setAttribute("fill", "currentColor")
		svg.append(path)
		return svg
	}

	const PREVIEW_KEYS = new Set(["size", "opacity", "showAuthor", "speed", "area"])
	const previewFlow = () => flow({ ts: Date.now(), author: "プレビュー", channelId: "", type: "normal", parts: [{ text: "プレビュー：このように流れます" }] })

	// ユーザーを紫・NG の一覧に追加する（既にあれば外す）
	const hasUser = (key, author) => settings[key].some(x => userKey(x) === userKey(author))
	const toggleUser = (key, author) => {
		const next = hasUser(key, author) ? settings[key].filter(x => userKey(x) !== userKey(author)) : [...settings[key], author]
		applySetting(key, next)
		const ta = lineInputs.get(key)
		if (ta) ta.value = next.join("\n")
	}
	// 設定のバックアップ。書き出した文字列には目印（fycLite）を付け、別物を読み込まないようにする
	const BACKUP_MARK = "fycLite"
	const exportSettings = () => JSON.stringify({ [BACKUP_MARK]: 1, settings })
	const importSettings = text => {
		let data
		try {
			data = JSON.parse(text.trim())
		} catch {
			throw new Error("文字列が壊れています（全部コピーできているか確認してください）")
		}
		if (!data || data[BACKUP_MARK] !== 1 || typeof data.settings !== "object") throw new Error("このスクリプトの設定のバックアップではありません")
		Object.assign(settings, loadSettings(JSON.stringify(data.settings)))
		saveSettings()
		applyAllSettings()
	}
	const buildBackup = () => {
		const message = h("div", { class: "desc" }, "書き出した文字列をメモ帳などに保存しておくと、あとで「読み込む」で元に戻せます")
		const box = h("textarea", {
			class: "backup",
			"aria-label": "設定のバックアップ",
			spellcheck: false,
			autocapitalize: "off",
			placeholder: "ここにバックアップの文字列を貼り付けて「読み込む」",
		})
		const say = text => {
			message.textContent = text
		}
		const exportBtn = h(
			"button",
			{
				class: "tag",
				onclick: () => {
					box.value = exportSettings()
					box.select()
					navigator.clipboard?.writeText(box.value).then(
						() => say("書き出してコピーしました。メモ帳などに貼り付けて保存してください"),
						() => say("書き出しました。下の欄の文字列を全部選んでコピーしてください"),
					) ?? say("書き出しました。下の欄の文字列を全部選んでコピーしてください")
				},
			},
			"書き出す",
		)
		const importBtn = h(
			"button",
			{
				class: "tag",
				onclick: () => {
					try {
						importSettings(box.value)
						onPanelClosed()
						buildPanel()
					} catch (e) {
						say(`読み込めませんでした：${e.message}`)
					}
				},
			},
			"読み込む",
		)
		return [h("div", { class: "row" }, message, h("div", { class: "backup-buttons" }, exportBtn, importBtn)), box]
	}

	const buildRecentList = () => {
		const box = h("div", { class: "recent" })
		const render = () => {
			const rows = [...recentAuthors.values()].reverse()
			box.replaceChildren(
				...(rows.length
					? rows.map(({ author, text }) => {
							const toggle = (key, label, cls) => {
								const b = h(
									"button",
									{
										class: `tag ${cls}${hasUser(key, author) ? " on" : ""}`,
										"aria-pressed": String(hasUser(key, author)),
										onclick: () => {
											toggleUser(key, author)
											b.classList.toggle("on", hasUser(key, author))
											b.setAttribute("aria-pressed", String(hasUser(key, author)))
										},
									},
									label,
								)
								return b
							}
							return h(
								"div",
								{ class: "who" },
								h("div", { class: "who-text" }, h("b", {}, author), h("span", {}, text)),
								toggle("highlightUsers", "紫", "purple"),
								toggle("ngUsers", "NG", "ng"),
							)
						})
					: [h("div", { class: "desc" }, "まだコメントを受信していません")]),
			)
		}
		render()
		return [
			h(
				"div",
				{ class: "row" },
				h("div", { class: "desc" }, "タップで「紫」「NG」に追加します。もう一度タップで外します"),
				h("button", { class: "tag", onclick: render }, "更新"),
			),
			box,
		]
	}

	const applySetting = (key, value) => {
		settings[key] = value
		saveSettings()
		if (key === "enabled") {
			if (!value) clearScreen()
			updateButtons()
		}
		if (key === "ngWords" || key === "ngUsers" || key === "highlightUsers") rebuildNg()
		if (key === "showHeatmap") value ? startHeatmap() : removeHeatmap()
		layout()
		if (PREVIEW_KEYS.has(key)) previewFlow()
	}

	const SCHEMA = [
		{
			title: "見た目",
			items: [
				{
					key: "size",
					type: "choice",
					label: "文字の大きさ",
					desc: "プレイヤーの高さに合わせて自動で調整されます",
					options: [
						["small", "小"],
						["medium", "中"],
						["large", "大"],
					],
				},
				{
					key: "opacity",
					type: "range",
					label: "不透明度",
					desc: "下げると動画が見やすくなります",
					min: 0.2,
					max: 1,
					step: 0.1,
					format: v => `${Math.round(v * 100)}%`,
				},
				{ key: "showAuthor", type: "toggle", label: "投稿者名を表示", desc: "コメントの前に小さく名前を出します" },
				{ key: "emphasizePaid", type: "toggle", label: "スーパーチャットを目立たせる", desc: "1.3 倍の大きさで、ゆっくり流します" },
				{
					key: "showHeatmap",
					type: "toggle",
					label: "コメントの多い場面を表示（アーカイブ）",
					desc: "シークバーの上にコメント量をグラフで出します。全コメントを読み込むため、2 時間の配信で約 17MB の通信が発生します",
				},
				{ key: "pinStaff", type: "toggle", label: "配信者・モデレーターを上部に固定", desc: "流さずに、画面上部の中央に 5 秒間表示します" },
				{
					key: "highlightUsers",
					type: "lines",
					label: "紫で表示するユーザー",
					desc: "1行に1人。表示名（@ は付けても付けなくても可）またはチャンネルID。配信者・モデレーターより優先します",
					placeholder: "例：@example\nUCxxxxxxxxxxxxxxxxxxxxxx",
				},
			],
		},
		{
			title: "流れ方",
			items: [
				{
					key: "speed",
					type: "choice",
					label: "速さ",
					desc: "画面を横切る時間（遅い 8秒・普通 6秒・速い 4.5秒）。自動はコメントが多いほど速くなります",
					options: [
						["slow", "遅い"],
						["normal", "普通"],
						["fast", "速い"],
						["auto", "自動"],
					],
				},
				{
					key: "area",
					type: "choice",
					label: "流す範囲",
					desc: "字幕や操作ボタンと重なるときは狭めてください",
					options: [
						["full", "全体"],
						["upper2/3", "上 2/3"],
						["upper1/2", "上半分"],
					],
				},
				{
					key: "maxOnScreen",
					type: "choice",
					label: "同時に流す数の上限",
					desc: "多いほど賑やかですが、端末が重くなります",
					options: [
						[20, "20"],
						[40, "40"],
						[60, "60"],
						[100, "100"],
					],
				},
				{
					key: "syncLatency",
					type: "toggle",
					label: "映像の遅れに合わせる（ライブ）",
					desc: "ライブ映像は実際より数秒遅れて届くので、その分コメントも遅らせて流します",
				},
				{
					key: "collapseRepeats",
					type: "toggle",
					label: "同じコメントをまとめる",
					desc: "5 秒以内に同じ文が来たら、新しく流さずに「×2」のように回数を付けます",
				},
				{ key: "noOverlap", type: "toggle", label: "重なりを避ける", desc: "オン：空きが無いコメントは流しません　オフ：重ねて流します" },
			],
		},
		{
			title: "NG（表示しないコメント）",
			items: [
				{
					key: "ngWords",
					type: "lines",
					label: "NGワード",
					desc: "1行に1つ。この言葉を含むコメントを流しません。/〜/ で囲むと正規表現",
					placeholder: "例：ネタバレ\n/^w+$/",
				},
				{
					key: "ngUsers",
					type: "lines",
					label: "NGユーザー",
					desc: "1行に1人。表示名（@ は付けても付けなくても可）またはチャンネルID",
					placeholder: "例：@example",
				},
				{
					key: "hideStampOnly",
					type: "toggle",
					label: "絵文字・スタンプだけのコメントを流さない",
					desc: "本文に文字が無いコメントを流しません（スーパーチャットは除く）",
				},
			],
		},
	]

	const PANEL_CSS = `
:host { all: initial; }
dialog { padding: 0; border: 0; background: none; max-width: none; max-height: none; margin: auto auto 0; }
dialog::backdrop { background: rgba(0,0,0,.45); }
@media (min-width: 640px) { dialog { margin: auto; } }
.panel { box-sizing: border-box; width: min(440px, 100vw); max-height: min(86vh, 760px); overflow: auto; overscroll-behavior: contain;
	background: #1f1f1f; color: #f1f1f1; border-radius: 16px 16px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
	font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; -webkit-text-size-adjust: 100%; }
@media (min-width: 640px) { .panel { border-radius: 16px; } }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.head h1 { font-size: 17px; margin: 0; }
.close { background: none; border: 0; color: inherit; font-size: 24px; line-height: 1; padding: 4px 8px; cursor: pointer; }
.main { display: flex; align-items: center; justify-content: space-between; background: #2c2c2c; border-radius: 12px; padding: 12px; margin-bottom: 12px; }
.main b { font-size: 16px; }
h2 { font-size: 13px; color: #aaa; font-weight: 600; margin: 18px 0 6px; }
.item { padding: 10px 0; border-top: 1px solid #333; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.label { font-weight: 600; }
.desc { color: #9a9a9a; font-size: 12px; margin-top: 2px; }
.seg { display: inline-flex; background: #2c2c2c; border-radius: 8px; padding: 2px; flex-shrink: 0; }
.seg button { border: 0; background: none; color: #ddd; font: inherit; padding: 5px 11px; border-radius: 6px; cursor: pointer; }
.seg button.on { background: #f1f1f1; color: #111; font-weight: 700; }
.switch { position: relative; width: 46px; height: 28px; flex-shrink: 0; appearance: none; -webkit-appearance: none; background: #555; border-radius: 14px; margin: 0; cursor: pointer; transition: background .15s; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: transform .15s; }
.switch:checked { background: #3ea6ff; }
.switch:checked::after { transform: translateX(18px); }
.range { display: flex; align-items: center; gap: 8px; }
.range input { width: 140px; accent-color: #3ea6ff; }
.range span { width: 3em; text-align: right; font-variant-numeric: tabular-nums; }
textarea { box-sizing: border-box; width: 100%; min-height: 72px; margin-top: 6px; background: #121212; color: #f1f1f1; border: 1px solid #444; border-radius: 8px; padding: 8px; font: 14px/1.4 ui-monospace, Menlo, monospace; resize: vertical; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: #bbb; margin-top: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
.status { white-space: pre-wrap; font: 12px/1.6 ui-monospace, Menlo, monospace; color: #cfcfcf; background: #121212; border-radius: 8px; padding: 8px 10px; }
.recent { margin-top: 6px; max-height: 260px; overflow: auto; border-radius: 8px; background: #181818; }
.who { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
.who-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.who-text b { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who-text span { font-size: 12px; color: #9a9a9a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex-shrink: 0; border: 1px solid #555; background: none; color: #ddd; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1; padding: 6px 10px; border-radius: 999px; cursor: pointer; }
.tag.purple.on { background: #c58cff; border-color: #c58cff; color: #111; }
.tag.ng.on { background: #ff6b6b; border-color: #ff6b6b; color: #111; }
.backup-buttons { display: flex; gap: 6px; flex-shrink: 0; }
textarea.backup { min-height: 56px; font-size: 12px; }
.reset { margin-top: 18px; width: 100%; padding: 10px; border-radius: 10px; border: 1px solid #555; background: none; color: #ddd; font: inherit; cursor: pointer; }
.reset.armed { border-color: #ff6b6b; color: #ff6b6b; }
`

	const VERSION = typeof GM_info === "object" ? (GM_info?.script?.version ?? "-") : "-"
	const statusLines = () => {
		const ago = status.lastOk ? `${Math.round((Date.now() - status.lastOk) / 1000)} 秒前` : "まだありません"
		return [
			`チャット：${status.mode}${status.source !== "-" ? `（取得元：${status.source}）` : ""}`,
			`最終取得：${ago}　受信：${status.received} 件`,
			`エラー：${status.error || "なし"}`,
			...(status.heatmap !== "-" ? [`コメント量：${status.heatmap}`] : []),
			`バージョン：${VERSION}　表示：${isMobileSite ? "モバイル" : "デスクトップ"}`,
		].join("\n")
	}

	// 設定画面は <dialog> の showModal で出す。最前面（top layer）・暗幕・Esc で閉じる・フォーカス管理はブラウザに任せる
	let panelHost = null
	let panelDialog = null
	let statusTimer = 0
	const closePanel = () => panelDialog?.close()
	const onPanelClosed = () => {
		clearInterval(statusTimer)
		panelHost?.remove()
		panelHost = panelDialog = null
	}

	const lineInputs = new Map() // 設定キー -> textarea
	const buildItem = item => {
		const value = settings[item.key]
		let control
		if (item.type === "toggle") {
			control = h("input", {
				type: "checkbox",
				class: "switch",
				checked: value,
				"aria-label": item.label,
				onchange: e => applySetting(item.key, e.target.checked),
			})
		} else if (item.type === "choice") {
			control = h("div", { class: "seg", role: "radiogroup", "aria-label": item.label })
			for (const [v, text] of item.options) {
				control.append(
					h(
						"button",
						{
							class: v === value ? "on" : "",
							role: "radio",
							"aria-checked": String(v === value),
							onclick: e => {
								control.querySelectorAll("button").forEach(b => {
									const on = b === e.currentTarget
									b.className = on ? "on" : ""
									b.setAttribute("aria-checked", String(on))
								})
								applySetting(item.key, v)
							},
						},
						text,
					),
				)
			}
		} else if (item.type === "range") {
			const out = h("span", {}, item.format(value))
			const input = h("input", {
				type: "range",
				min: item.min,
				max: item.max,
				step: item.step,
				value,
				"aria-label": item.label,
				oninput: e => {
					out.textContent = item.format(Number(e.target.value))
				},
				onchange: e => applySetting(item.key, Number(e.target.value)),
			})
			control = h("div", { class: "range" }, input, out)
		} else if (item.type === "lines") {
			let timer
			const ta = h("textarea", {
				value: value.join("\n"),
				placeholder: item.placeholder,
				"aria-label": item.label,
				spellcheck: false,
				autocapitalize: "off",
				oninput: e => {
					// Shadow DOM 内のイベントは処理後に e.target が null になるので、値はここで読んでおく
					const lines = e.target.value
						.split("\n")
						.map(s => s.trim())
						.filter(Boolean)
					clearTimeout(timer)
					timer = setTimeout(() => applySetting(item.key, lines), 400)
				},
			})
			lineInputs.set(item.key, ta)
			return h("div", { class: "item" }, h("div", { class: "label" }, item.label), h("div", { class: "desc" }, item.desc), ta)
		}
		return h(
			"div",
			{ class: "item" },
			h("div", { class: "row" }, h("div", {}, h("div", { class: "label" }, item.label), h("div", { class: "desc" }, item.desc)), control),
		)
	}

	let panelOpening = false
	const openPanel = () => {
		if (panelHost) return closePanel()
		if (panelOpening) return
		panelOpening = true
		syncFromShared().finally(() => {
			panelOpening = false
			buildPanel()
		})
	}
	const buildPanel = () => {
		lineInputs.clear()
		panelHost = h("div")
		const root = panelHost.attachShadow({ mode: "open" })
		const legend = h(
			"div",
			{ class: "legend" },
			[
				["normal", "一般・メンバー"],
				["moderator", "モデレーター"],
				["owner", "配信者"],
				["highlight", "指定ユーザー"],
			].map(([k, t]) => h("span", {}, h("i", { style: `background:${COLORS[k]}` }), t)),
		)
		const statusBox = h("div", { class: "status" }, statusLines())
		statusTimer = setInterval(() => {
			statusBox.textContent = statusLines()
		}, 1000)
		const resetBtn = h(
			"button",
			{
				class: "reset",
				onclick: () => {
					if (!resetBtn.classList.contains("armed")) {
						resetBtn.classList.add("armed")
						resetBtn.textContent = "もう一度押すと初期設定に戻します"
						setTimeout(() => {
							resetBtn.classList.remove("armed")
							resetBtn.textContent = "初期設定に戻す"
						}, 3000)
						return
					}
					Object.assign(settings, structuredClone(DEFAULTS))
					saveSettings()
					rebuildNg()
					layout()
					updateButtons()
					onPanelClosed()
					buildPanel()
				},
			},
			"初期設定に戻す",
		)
		const panel = h(
			"div",
			{ class: "panel" },
			h("div", { class: "head" }, h("h1", {}, "コメント設定"), h("button", { class: "close", "aria-label": "閉じる", onclick: closePanel }, "×")),
			h(
				"div",
				{ class: "main" },
				h("div", {}, h("b", {}, "コメントを流す"), legend),
				h("input", {
					type: "checkbox",
					class: "switch",
					checked: settings.enabled,
					"aria-label": "コメントを流す",
					onchange: e => applySetting("enabled", e.target.checked),
				}),
			),
			SCHEMA.map(g => [h("h2", {}, g.title), g.items.map(buildItem)]),
			h("h2", {}, "最近コメントした人"),
			buildRecentList(),
			h("h2", {}, "設定のバックアップ"),
			buildBackup(),
			h("h2", {}, "状態（不具合のときはこの欄のスクショを送ってください）"),
			statusBox,
			resetBtn,
		)
		// 暗幕（dialog 自身）を押したら閉じる
		panelDialog = h("dialog", { "aria-label": "コメント設定", onclose: onPanelClosed, onclick: e => e.target === panelDialog && closePanel() }, panel)
		root.append(h("style", {}, PANEL_CSS), panelDialog)
		document.body.append(panelHost)
		panelDialog.showModal()
	}

	// 設定画面を開くボタン。www はプレイヤーの操作列、m は動画下の操作列に置く
	const BUTTON_CSS = `
.fyl-btn.ytp-button { display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; }
.fyl-btn.ytp-button svg { width: 24px; height: 24px; }
.fyl-btn.fyl-pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; margin: 0 4px; border: 0; border-radius: 18px;
	background: rgba(128, 128, 128, 0.18); color: inherit; font: 500 14px/1 Roboto, sans-serif; flex-shrink: 0; }
.fyl-btn.fyl-pill svg { width: 20px; height: 20px; }
.fyl-btn.fyl-off svg { opacity: .45; }
.fyl-float-box { position: absolute; top: 8px; right: 8px; z-index: 61; display: flex; gap: 6px; }
.fyl-btn.fyl-float { width: 36px; height: 36px; padding: 7px; border: 0; border-radius: 18px; background: rgba(0,0,0,.55); color: #fff; opacity: .8; pointer-events: auto; }
.fyl-btn.fyl-float svg { width: 22px; height: 22px; }
`
	style.textContent += BUTTON_CSS

	// 疑似全画面：iPhone の全画面再生は iOS 標準のプレーヤーに切り替わりコメントを重ねられないので、
	// プレイヤー自体を画面いっぱいに広げる。広げた後は resize を通知して YouTube に映像と操作バーの大きさを計算し直させる
	const PSEUDO_FS_CSS = `
.fyl-pseudo-fs { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100dvh !important;
	max-width: none !important; max-height: none !important; margin: 0 !important; z-index: 2147483000 !important; background: #000 !important; }
.fyl-pseudo-fs .html5-video-container, .fyl-pseudo-fs video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; }
.fyl-pseudo-fs video { object-fit: contain !important; }
.fyl-pfs-ancestor { z-index: 2147483000 !important; transform: none !important; filter: none !important; contain: none !important; will-change: auto !important; }
`
	style.textContent += PSEUDO_FS_CSS
	// 親要素が重なり順（z-index）や transform を持っていると、プレイヤーを最前面・画面固定にできない
	// （例: m の #player-container-id は z-index: 2 でヘッダーの下になる）ので、全画面中だけ解除する
	const createsStackingContext = el => {
		const cs = getComputedStyle(el)
		return (
			cs.zIndex !== "auto" ||
			cs.transform !== "none" ||
			cs.filter !== "none" ||
			/paint|layout|strict|content/.test(cs.contain) ||
			/transform/.test(cs.willChange)
		)
	}
	// m のようにボタンがプレイヤーの外（動画の下）にあると全画面中は隠れて終了できないので、プレイヤー右上にも出す
	const setFullscreenButtonsInPlayer = on => {
		if (on) {
			const insidePlayer = [...buttons.fullscreen].some(b => state.player?.contains(b))
			if (!insidePlayer) state.player?.append(h("div", { class: "fyl-float-box fyl-pfs-box" }, ...makeButtons("fyl-float")))
		} else {
			for (const el of document.querySelectorAll(".fyl-pfs-box")) el.remove()
			for (const set of Object.values(buttons)) for (const b of set) if (!b.isConnected) set.delete(b)
		}
	}
	// 疑似全画面はページのスクロールを止めない。iPhone の Safari では画面を上に軽くスワイプすると
	// アドレスバーが小さくなり、プレイヤーの高さ（100dvh）もそれに合わせて広がる
	const setPseudoFullscreen = on => {
		if (state.pseudoFs === on) return
		state.pseudoFs = on
		state.player?.classList.toggle("fyl-pseudo-fs", on)
		if (on) {
			for (let el = state.player?.parentElement; el && el !== document.body; el = el.parentElement)
				if (createsStackingContext(el)) el.classList.add("fyl-pfs-ancestor")
		} else {
			for (const el of document.querySelectorAll(".fyl-pfs-ancestor")) el.classList.remove("fyl-pfs-ancestor")
		}
		setFullscreenButtonsInPlayer(on)
		updateButtons()
		requestAnimationFrame(() => pageWindow.dispatchEvent(new pageWindow.Event("resize")))
	}
	// 本物の全画面（要素の全画面）が使えれば使う。iPad・Mac ではアドレスバーも消え、コメントも重なる。
	// iPhone の Safari は動画にしか全画面を使えないので疑似全画面にする
	const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null
	const isFullscreen = () => state.pseudoFs || (!!state.player && fullscreenElement() === state.player)
	const toggleFullscreen = () => {
		if (state.pseudoFs) return setPseudoFullscreen(false)
		if (fullscreenElement()) return (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document)
		const pl = state.player
		const request = pl && (pl.requestFullscreen ?? pl.webkitRequestFullscreen)
		const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled
		if (!request || !enabled) return setPseudoFullscreen(true)
		Promise.resolve(request.call(pl)).catch(() => setPseudoFullscreen(true))
	}
	for (const name of ["fullscreenchange", "webkitfullscreenchange"])
		document.addEventListener(name, () => {
			setFullscreenButtonsInPlayer(!!state.player && fullscreenElement() === state.player)
			updateButtons()
		})
	document.addEventListener("keydown", e => e.key === "Escape" && !panelHost && setPseudoFullscreen(false))

	const BUTTON_KINDS = {
		settings: { onClick: () => openPanel(), pillText: "コメント設定" },
		fullscreen: { onClick: () => toggleFullscreen() },
	}
	const buttons = Object.fromEntries(Object.keys(BUTTON_KINDS).map(k => [k, new Set()]))
	const updateButtons = () => {
		/** @param {HTMLElement} b @param {{ icon: string, label: string, pressed?: boolean }} o */
		const show = (b, { icon, label, pressed }) => {
			b.querySelector("path").setAttribute("d", icon)
			b.title = b.ariaLabel = label
			if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed))
		}
		buttons.settings.forEach(b => {
			b.classList.toggle("fyl-off", !settings.enabled)
			show(b, { icon: ICON.settings, label: settings.enabled ? "コメント設定（流す：オン）" : "コメント設定（流す：オフ）" })
		})
		for (const b of buttons.fullscreen) {
			show(b, {
				icon: isFullscreen() ? ICON.exitFullscreen : ICON.fullscreen,
				label: isFullscreen() ? "全画面を終了" : "コメント付きで全画面表示",
				pressed: isFullscreen(),
			})
		}
	}
	const makeButton = (kind, cls) => {
		const b = h(
			"button",
			{
				class: `fyl-btn fyl-btn-${kind} ${cls}`,
				"aria-label": kind,
				onclick: e => {
					e.stopPropagation()
					BUTTON_KINDS[kind].onClick()
				},
			},
			svgIcon(ICON[kind]),
		)
		if (cls === "fyl-pill" && BUTTON_KINDS[kind].pillText) b.append(BUTTON_KINDS[kind].pillText)
		buttons[kind].add(b)
		return b
	}
	const makeButtons = cls => Object.keys(BUTTON_KINDS).map(k => makeButton(k, cls))
	// www はプレイヤーの操作列、m は動画下の操作列に置く。どちらも見つからない状態が
	// 5 秒続いたら（YouTube の画面変更を想定）プレイヤー右上に予備のボタンを出す
	const FLOAT_AFTER_MS = 5000
	let noAnchorSince = 0
	const removeButtons = () =>
		Object.values(buttons).forEach(set => {
			for (const b of set) (b.closest(".fyl-float-box") ?? b).remove()
			set.clear()
		})
	const ensureButton = () => {
		for (const set of Object.values(buttons)) for (const b of set) if (!b.isConnected) set.delete(b)
		const controls = pick(YT.selectors.desktopControls, state.player ?? document)
		const actionBar = controls ? null : pick(YT.selectors.mobileActionBar)
		const target = controls ? [controls, "ytp-button"] : actionBar ? [actionBar, "fyl-pill"] : null
		const current = [...buttons.settings][0]
		if (current && (!target || !current.classList.contains("fyl-float"))) return
		if (current) removeButtons() // 予備ボタンから本来の場所へ移す
		if (target) {
			noAnchorSince = 0
			target[0].prepend(...makeButtons(target[1]))
			return updateButtons()
		}
		if (!state.player) return
		noAnchorSince ||= Date.now()
		if (Date.now() - noAnchorSince < FLOAT_AFTER_MS) return
		state.player.append(h("div", { class: "fyl-float-box" }, ...makeButtons("fyl-float")))
		updateButtons()
	}

	// ---------- ページ遷移の追跡 ----------
	const currentVideoId = () => {
		const u = new URL(location.href)
		if (u.pathname === "/watch") return u.searchParams.get("v")
		return YT.livePath.exec(u.pathname)?.[1] ?? null
	}

	let session = { videoId: null, abort: null, replayContinuation: null }

	const attachPlayer = () => {
		const player = pick(YT.selectors.player)
		if (player === state.player && player?.contains(screen)) return
		if (state.player) resizeObserver.unobserve(state.player)
		state.player = player
		if (!player) return
		player.prepend(screen)
		resizeObserver.observe(player)
		layout()
	}

	const attachVideo = () => {
		const video = state.player && pick(YT.selectors.video, state.player)
		if (video === state.video) return
		state.video = video
		if (!video) return
		const sync = () => screen.classList.toggle("fyl-paused", video.paused)
		video.addEventListener("play", sync)
		video.addEventListener("pause", sync)
		sync()
	}

	const startSession = videoId => {
		session.abort?.abort()
		clearScreen()
		const controller = new AbortController()
		removeHeatmap()
		session = { videoId, abort: controller, replayContinuation: null }
		resetQueue(null)
		setPseudoFullscreen(false)
		setStatus({ mode: videoId ? "準備中" : "待機中（動画ページではありません）", source: "-", received: 0, lastOk: 0, error: "" })
		if (!videoId) return
		const { signal } = controller
		;(async () => {
			const info = await fetchChatInfo(videoId, signal)
			if (signal.aborted) return
			if (!info) return setStatus({ mode: "チャットなし（この動画にはチャットがありません）" })
			setStatus({ mode: info.isReplay ? "アーカイブ" : "ライブ", source: info.source })
			await (info.isReplay ? runReplay : runLive)(info.continuation, signal)
		})().catch(e => {
			if (signal.aborted) return
			setStatus({ error: describeError(e) })
			console.warn("[FYC Lite]", e)
		})
	}

	const tick = () => {
		if (!document.head.contains(style)) document.head.append(style)
		attachPlayer()
		attachVideo()
		ensureButton()
		placeHeatmap()
		const videoId = currentVideoId()
		if (videoId !== session.videoId) startSession(videoId)
	}

	// ページ遷移はイベントで検知する（www: yt-navigate-finish、m: state-navigateend）。
	// 遷移直後の 10 秒はプレイヤーやボタン置き場が後から現れるので 0.5 秒ごとに確認し、その後は 5 秒ごとの予備確認だけにする
	const TICK = { fastMs: 500, slowMs: 5000, burstMs: 10000 }
	let fastUntil = 0
	const loop = () => {
		tick()
		setTimeout(loop, Date.now() < fastUntil ? TICK.fastMs : TICK.slowMs)
	}
	const onNavigate = () => {
		fastUntil = Date.now() + TICK.burstMs
		tick()
	}
	for (const name of YT.navigateEvents) document.addEventListener(name, onNavigate)
	window.addEventListener("popstate", onNavigate)
	fastUntil = Date.now() + TICK.burstMs
	loop()
	// 共有の設定を読み込む。タブに戻ってきたときも読み直す（もう片方の表示で変えた分を反映する）
	syncFromShared()
	document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && syncFromShared())

	// 単体テスト（tests/unit.mjs）用の入口。テストがこの関数を用意したときだけ内部を渡す。通常の動作では何もしない
	globalThis.__FYL_TEST__?.({
		settings,
		state,
		arrivals,
		parseItem,
		itemsFromActions,
		authorType,
		userMatcher,
		pickLane,
		currentDuration,
		loadSettings,
		isStampOnly,
		repeatKey,
		flow,
		clearScreen,
		rebuildNg,
		exportSettings,
		importSettings,
	})
})()

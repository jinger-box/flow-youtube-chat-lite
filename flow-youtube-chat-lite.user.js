// ==UserScript==
// @name         Flow Youtube Chat Lite
// @namespace    FlowYoutubeChatLite
// @version      0.6.0
// @description  YouTube のライブチャットをニコニコ風に画面上へ流す（軽量版・パネル不要・モバイル対応）
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        none
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

	const loadSettings = () => {
		let saved = {}
		try {
			saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") ?? {}
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

	// ---------- YouTube 依存の値（仕様変更で壊れたら、まずここを直す） ----------
	// 要素は候補を先頭から順に探す。1 つ目が見つからなくなっても 2 つ目以降で動き続けるようにする
	const YT = {
		selectors: {
			player: ["#movie_player", ".html5-video-player"],
			video: ["video.html5-main-video", "video"],
			desktopControls: [".ytp-right-controls", ".ytp-chrome-controls .ytp-right-controls"],
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
	const status = { mode: "待機中", source: "-", received: 0, lastOk: 0, error: "" }
	const setStatus = patch => Object.assign(status, patch)

	// ---------- InnerTube API ----------
	const isMobileSite = location.hostname === "m.youtube.com"
	const FALLBACK_WEB_VERSION = "2.20251014.01.00"

	const innertubeContext = () => {
		const ctx = structuredClone(window.ytcfg?.get?.("INNERTUBE_CONTEXT") ?? { client: {} })
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
	const describeError = e => (e?.name === "TimeoutError" ? `通信がタイムアウトしました（${FETCH_TIMEOUT_MS / 1000} 秒）` : e?.message ?? String(e))

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
		const initial = window.ytInitialData
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
		const base = { id: r.id, ts: Number(r.timestampUsec) / 1000 || Date.now(), author: r.authorName?.simpleText ?? "", channelId: r.authorExternalChannelId ?? "", type: authorType(r) }
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
		(actions ?? []).map(a => a.addChatItemAction?.item).filter(Boolean).map(parseItem).filter(Boolean)

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
	let isNg = () => false
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
.fyl-screen.fyl-paused .fyl-chat, .fyl-screen.fyl-user-paused .fyl-chat { animation-play-state: paused; }
.fyl-chat {
	position: absolute; left: 100%; top: 0; white-space: nowrap; line-height: ${LINE_HEIGHT};
	font-weight: 700; color: #fff; will-change: transform; user-select: none;
	text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000;
	animation: fyl-flow var(--fyl-dur) linear forwards;
}
.fyl-chat img { height: 1em; width: auto; vertical-align: -0.12em; }
.fyl-chat .fyl-author { font-size: 0.7em; opacity: 0.85; margin-right: 0.3em; }
.fyl-chat .fyl-paid { padding: 0 0.3em; border-radius: 0.2em; margin-right: 0.3em; color: #fff; }
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
		userPaused: false, // 一時停止ボタンで止めている
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
	const pickLane = (w, dur, now) => {
		const vNew = (state.pw + w) / dur
		let fallback = 0
		let oldest = Infinity
		for (let i = 0; i < state.lanes.length; i++) {
			const last = state.lanes[i]
			if (!last) return i
			const vPrev = (state.pw + last.w) / last.dur
			const elapsed = now - last.t0
			const entered = vPrev * elapsed >= last.w + GAP_PX
			const remaining = last.t0 + last.dur - now
			const noCatchUp = remaining <= 0 || vNew * remaining <= state.pw - GAP_PX
			if (entered && noCatchUp) return i
			if (last.t0 < oldest) {
				oldest = last.t0
				fallback = i
			}
		}
		return settings.noOverlap ? -1 : fallback
	}

	const buildChatElement = chat => {
		const el = document.createElement("span")
		el.className = "fyl-chat"
		el.style.color = isHighlighted(chat) ? COLORS.highlight : COLORS[chat.type]
		if (chat.paid) {
			const paid = document.createElement("span")
			paid.className = "fyl-paid"
			paid.textContent = chat.paid
			if (chat.paidColor) paid.style.background = chat.paidColor
			el.append(paid)
		}
		if (settings.showAuthor && chat.author) {
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

	const flow = chat => {
		if (!settings.enabled || !state.player || state.pw === 0) return
		if (state.userPaused || isNg(chat)) return
		if (chat.parts.length === 0 && !chat.paid) return
		arrivals.push(performance.now())
		if (state.onScreen >= settings.maxOnScreen) return
		const el = buildChatElement(chat)
		const dur = currentDuration(performance.now())
		el.style.visibility = "hidden"
		el.style.animation = "none"
		screen.append(el)
		const w = el.getBoundingClientRect().width
		const now = performance.now()
		const lane = pickLane(w, dur, now)
		if (lane < 0) {
			el.remove()
			return
		}
		state.lanes[lane] = { t0: now, w, dur }
		el.style.top = `${lane * state.fontPx * LINE_HEIGHT}px`
		el.style.setProperty("--fyl-dur", `${dur}ms`)
		el.style.animation = ""
		el.style.visibility = ""
		state.onScreen++
		el.addEventListener("animationend", () => {
			el.remove()
			state.onScreen--
		})
	}

	const clearScreen = () => {
		screen.replaceChildren()
		state.lanes = new Array(state.lanes.length)
		state.onScreen = 0
	}

	// ---------- チャット取得のループ ----------
	const sleep = (ms, signal) =>
		new Promise((resolve, reject) => {
			const t = setTimeout(resolve, ms)
			signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true })
		})

	const isAdShowing = () => state.player?.classList.contains(YT.adShowingClass)

	// ライブ映像の遅れ（ms）。ingestionTime は今映っている映像が配信された時刻（秒）。
	// 巻き戻して見ているとき（30 秒超）は合わせない
	const MAX_SYNC_LATENCY_MS = 30000
	const liveLatencyMs = () => {
		if (!settings.syncLatency) return 0
		const t = state.player?.getProgressState?.()?.ingestionTime
		if (!t) return 0
		const lat = Date.now() - t * 1000
		return lat > 0 && lat <= MAX_SYNC_LATENCY_MS ? lat : 0
	}

	// 表示待ちの列。ライブもアーカイブも「この時刻になったら流す」コメントをここに入れ、
	// 1 つの処理で取り出して流す。時刻の基準はセッションごとに clock が決める
	// （ライブ: 実時刻 ms、アーカイブ: 動画の再生位置 ms）
	const PUMP_MS = 100
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
		// 動画の一時停止中・広告中に時刻が来たものは流さずに捨てる（再開時にまとめて流れないように）
		const blocked = !state.video || state.video.paused || isAdShowing()
		while (queue.items.length && queue.items[0].due <= now) {
			const { chat } = queue.items.shift()
			if (!blocked) flow(chat)
		}
	}, PUMP_MS)

	// ライブ: YouTube の指示（timeoutMs、通常 10 秒）は待たずに短い間隔で取得する。
	// 表示時刻は「投稿時刻＋映像の遅れ」、遅れを合わせない場合は投稿の間隔を保って取得間隔内に散らす
	const LIVE_POLL_MS = 1500
	const LIVE_BACKLOG = { maxAgeMs: 10000, maxItems: 10 }
	const runLive = async (continuation, signal) => {
		resetQueue(() => Date.now())
		let first = true
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
				await sleep(Math.min(LIVE_POLL_MS * 2 ** failures, 30000), signal)
				continue
			}
			const c = lc?.continuations?.[0]
			const data = c && Object.values(c)[0]
			if (!data?.continuation) return setStatus({ mode: "ライブ（配信終了）" })
			continuation = data.continuation
			let items = itemsFromActions(lc.actions)
			status.received += items.length
			if (first) {
				// 開いた直後は直近のコメントだけ流して、画面が空のまま待たないようにする
				items = items.filter(chat => Date.now() - chat.ts < LIVE_BACKLOG.maxAgeMs).slice(-LIVE_BACKLOG.maxItems)
				first = false
			}
			if (items.length) {
				const now = Date.now()
				const start = items[0].ts
				const span = Math.max(items.at(-1).ts - start, 1)
				const latency = liveLatencyMs()
				enqueue(
					items.map(chat => ({
						chat,
						due: latency ? chat.ts + latency : now + ((chat.ts - start) / span) * Math.min(span, LIVE_POLL_MS),
					})),
				)
			}
			await sleep(LIVE_POLL_MS, signal)
		}
	}

	// アーカイブ: 再生位置の 15 秒先まで先読みし、videoOffsetTimeMsec を表示時刻として列に入れる
	const REPLAY = { checkMs: 500, prefetchMs: 15000, seekJumpMs: 3000 }
	const runReplay = async (initialContinuation, signal) => {
		const videoMs = () => (state.video?.currentTime ?? 0) * 1000
		resetQueue(videoMs)
		let continuation = initialContinuation
		let bufferedUntil = -1
		let lastMs = -1
		let lastCheck = 0

		const fetchFrom = async offsetMs => {
			const res = await api(
				YT.endpoints.replay,
				{ continuation, currentPlayerState: { playerOffsetMs: String(Math.max(0, Math.floor(offsetMs))) } },
				signal,
			)
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

	// ---------- 設定画面 ----------
	const saveSettings = () => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
		} catch {}
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
		pause: "M7 5h3.5v14H7zm6.5 0H17v14h-3.5z",
		play: "M8 5v14l11-7z",
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
	const previewFlow = () =>
		flow({ ts: Date.now(), author: "プレビュー", channelId: "", type: "normal", parts: [{ text: "プレビュー：このように流れます" }] })

	const applySetting = (key, value) => {
		settings[key] = value
		saveSettings()
		if (key === "enabled") {
			if (!value) clearScreen()
			updateButtons()
		}
		if (key === "ngWords" || key === "ngUsers" || key === "highlightUsers") rebuildNg()
		layout()
		if (PREVIEW_KEYS.has(key)) previewFlow()
	}

	const SCHEMA = [
		{
			title: "見た目",
			items: [
				{ key: "size", type: "choice", label: "文字の大きさ", desc: "プレイヤーの高さに合わせて自動で調整されます", options: [["small", "小"], ["medium", "中"], ["large", "大"]] },
				{ key: "opacity", type: "range", label: "不透明度", desc: "下げると動画が見やすくなります", min: 0.2, max: 1, step: 0.1, format: v => `${Math.round(v * 100)}%` },
				{ key: "showAuthor", type: "toggle", label: "投稿者名を表示", desc: "コメントの前に小さく名前を出します" },
				{ key: "highlightUsers", type: "lines", label: "紫で表示するユーザー", desc: "1行に1人。表示名（@ は付けても付けなくても可）またはチャンネルID。配信者・モデレーターより優先します", placeholder: "例：@example\nUCxxxxxxxxxxxxxxxxxxxxxx" },
			],
		},
		{
			title: "流れ方",
			items: [
				{ key: "speed", type: "choice", label: "速さ", desc: "画面を横切る時間（遅い 8秒・普通 6秒・速い 4.5秒）。自動はコメントが多いほど速くなります", options: [["slow", "遅い"], ["normal", "普通"], ["fast", "速い"], ["auto", "自動"]] },
				{ key: "area", type: "choice", label: "流す範囲", desc: "字幕や操作ボタンと重なるときは狭めてください", options: [["full", "全体"], ["upper2/3", "上 2/3"], ["upper1/2", "上半分"]] },
				{ key: "maxOnScreen", type: "choice", label: "同時に流す数の上限", desc: "多いほど賑やかですが、端末が重くなります", options: [[20, "20"], [40, "40"], [60, "60"], [100, "100"]] },
				{ key: "syncLatency", type: "toggle", label: "映像の遅れに合わせる（ライブ）", desc: "ライブ映像は実際より数秒遅れて届くので、その分コメントも遅らせて流します" },
				{ key: "noOverlap", type: "toggle", label: "重なりを避ける", desc: "オン：空きが無いコメントは流しません　オフ：重ねて流します" },
			],
		},
		{
			title: "NG（表示しないコメント）",
			items: [
				{ key: "ngWords", type: "lines", label: "NGワード", desc: "1行に1つ。この言葉を含むコメントを流しません。/〜/ で囲むと正規表現", placeholder: "例：ネタバレ\n/^w+$/" },
				{ key: "ngUsers", type: "lines", label: "NGユーザー", desc: "1行に1人。表示名（@ は付けても付けなくても可）またはチャンネルID", placeholder: "例：@example" },
			],
		},
	]

	const PANEL_CSS = `
:host { all: initial; }
.backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483646; display: flex; align-items: flex-end; justify-content: center; }
@media (min-width: 640px) { .backdrop { align-items: center; } }
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
.reset { margin-top: 18px; width: 100%; padding: 10px; border-radius: 10px; border: 1px solid #555; background: none; color: #ddd; font: inherit; cursor: pointer; }
.reset.armed { border-color: #ff6b6b; color: #ff6b6b; }
`

	const VERSION = typeof GM_info === "object" ? GM_info?.script?.version ?? "-" : "-"
	const statusLines = () => {
		const ago = status.lastOk ? `${Math.round((Date.now() - status.lastOk) / 1000)} 秒前` : "まだありません"
		return [
			`チャット：${status.mode}${status.source !== "-" ? `（取得元：${status.source}）` : ""}`,
			`最終取得：${ago}　受信：${status.received} 件`,
			`エラー：${status.error || "なし"}`,
			`バージョン：${VERSION}　表示：${isMobileSite ? "モバイル" : "デスクトップ"}`,
		].join("\n")
	}

	let panelHost = null
	let statusTimer = 0
	const closePanel = () => {
		clearInterval(statusTimer)
		panelHost?.remove()
		panelHost = null
	}

	const buildItem = item => {
		const value = settings[item.key]
		let control
		if (item.type === "toggle") {
			control = h("input", { type: "checkbox", class: "switch", checked: value, "aria-label": item.label, onchange: e => applySetting(item.key, e.target.checked) })
		} else if (item.type === "choice") {
			control = h("div", { class: "seg", role: "radiogroup", "aria-label": item.label })
			for (const [v, text] of item.options) {
				control.append(
					h("button", {
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
					}, text),
				)
			}
		} else if (item.type === "range") {
			const out = h("span", {}, item.format(value))
			const input = h("input", {
				type: "range", min: item.min, max: item.max, step: item.step, value, "aria-label": item.label,
				oninput: e => (out.textContent = item.format(Number(e.target.value))),
				onchange: e => applySetting(item.key, Number(e.target.value)),
			})
			control = h("div", { class: "range" }, input, out)
		} else if (item.type === "lines") {
			let timer
			const ta = h("textarea", {
				value: value.join("\n"), placeholder: item.placeholder, "aria-label": item.label, spellcheck: false, autocapitalize: "off",
				oninput: e => {
					// Shadow DOM 内のイベントは処理後に e.target が null になるので、値はここで読んでおく
					const lines = e.target.value.split("\n").map(s => s.trim()).filter(Boolean)
					clearTimeout(timer)
					timer = setTimeout(() => applySetting(item.key, lines), 400)
				},
			})
			return h("div", { class: "item" }, h("div", { class: "label" }, item.label), h("div", { class: "desc" }, item.desc), ta)
		}
		return h("div", { class: "item" }, h("div", { class: "row" }, h("div", {}, h("div", { class: "label" }, item.label), h("div", { class: "desc" }, item.desc)), control))
	}

	const openPanel = () => {
		if (panelHost) return closePanel()
		panelHost = h("div")
		const root = panelHost.attachShadow({ mode: "open" })
		const legend = h(
			"div", { class: "legend" },
			[["normal", "一般・メンバー"], ["moderator", "モデレーター"], ["owner", "配信者"], ["highlight", "指定ユーザー"]].map(([k, t]) =>
				h("span", {}, h("i", { style: `background:${COLORS[k]}` }), t)),
		)
		const statusBox = h("div", { class: "status" }, statusLines())
		statusTimer = setInterval(() => (statusBox.textContent = statusLines()), 1000)
		const resetBtn = h("button", {
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
				closePanel()
				openPanel()
			},
		}, "初期設定に戻す")
		const panel = h(
			"div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": "コメント設定", onclick: e => e.stopPropagation() },
			h("div", { class: "head" }, h("h1", {}, "コメント設定"), h("button", { class: "close", "aria-label": "閉じる", onclick: closePanel }, "×")),
			h("div", { class: "main" },
				h("div", {}, h("b", {}, "コメントを流す"), legend),
				h("input", { type: "checkbox", class: "switch", checked: settings.enabled, "aria-label": "コメントを流す", onchange: e => applySetting("enabled", e.target.checked) })),
			SCHEMA.map(g => [h("h2", {}, g.title), g.items.map(buildItem)]),
			h("h2", {}, "状態（不具合のときはこの欄のスクショを送ってください）"),
			statusBox,
			resetBtn,
		)
		root.append(h("style", {}, PANEL_CSS), h("div", { class: "backdrop", onclick: closePanel }, panel))
		document.body.append(panelHost)
	}
	document.addEventListener("keydown", e => e.key === "Escape" && panelHost && closePanel())

	// 設定画面を開くボタン。www はプレイヤーの操作列、m は動画下の操作列に置く
	const BUTTON_CSS = `
.fyl-btn.ytp-button { display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; }
.fyl-btn.ytp-button svg { width: 24px; height: 24px; }
.fyl-btn.fyl-pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; margin: 0 4px; border: 0; border-radius: 18px;
	background: var(--yt-spec-badge-chip-background, rgba(255,255,255,.1)); color: var(--yt-spec-text-primary, #f1f1f1); font: 500 14px/1 Roboto, sans-serif; flex-shrink: 0; }
.fyl-btn.fyl-pill svg { width: 20px; height: 20px; }
.fyl-btn.fyl-off svg { opacity: .45; }
.fyl-float-box { position: absolute; top: 8px; right: 8px; z-index: 61; display: flex; gap: 6px; }
.fyl-btn.fyl-float { width: 36px; height: 36px; padding: 7px; border: 0; border-radius: 18px; background: rgba(0,0,0,.55); color: #fff; opacity: .8; pointer-events: auto; }
.fyl-btn.fyl-float svg { width: 22px; height: 22px; }
`
	style.textContent += BUTTON_CSS

	const buttons = { settings: new Set(), pause: new Set() }
	const updateButtons = () => {
		buttons.settings.forEach(b => {
			b.classList.toggle("fyl-off", !settings.enabled)
			b.title = settings.enabled ? "コメント設定（流す：オン）" : "コメント設定（流す：オフ）"
		})
		buttons.pause.forEach(b => {
			const paused = state.userPaused
			b.querySelector("path").setAttribute("d", paused ? ICON.play : ICON.pause)
			b.title = b.ariaLabel = paused ? "コメントの流れを再開" : "コメントの流れを一時停止"
			b.setAttribute("aria-pressed", String(paused))
		})
	}
	const setUserPaused = paused => {
		state.userPaused = paused
		screen.classList.toggle("fyl-user-paused", paused)
		updateButtons()
	}
	const makeButton = (kind, cls) => {
		const b = h("button", {
			class: `fyl-btn ${cls}`,
			"aria-label": kind === "settings" ? "コメント設定" : "コメントの流れを一時停止",
			onclick: e => {
				e.stopPropagation()
				kind === "settings" ? openPanel() : setUserPaused(!state.userPaused)
			},
		}, svgIcon(ICON[kind]))
		if (cls === "fyl-pill" && kind === "settings") b.append("コメント設定")
		buttons[kind].add(b)
		return b
	}
	// www はプレイヤーの操作列、m は動画下の操作列に置く。どちらも見つからない状態が
	// 5 秒続いたら（YouTube の画面変更を想定）プレイヤー右上に予備のボタンを出す
	const FLOAT_AFTER_MS = 5000
	let noAnchorSince = 0
	const removeButtons = () =>
		Object.values(buttons).forEach(set => {
			set.forEach(b => (b.closest(".fyl-float-box") ?? b).remove())
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
			target[0].prepend(makeButton("settings", target[1]), makeButton("pause", target[1]))
			return updateButtons()
		}
		if (!state.player) return
		noAnchorSince ||= Date.now()
		if (Date.now() - noAnchorSince < FLOAT_AFTER_MS) return
		state.player.append(h("div", { class: "fyl-float-box" }, makeButton("settings", "fyl-float"), makeButton("pause", "fyl-float")))
		updateButtons()
	}

	// ---------- ページ遷移の追跡 ----------
	const currentVideoId = () => {
		const u = new URL(location.href)
		if (u.pathname === "/watch") return u.searchParams.get("v")
		return YT.livePath.exec(u.pathname)?.[1] ?? null
	}

	let session = { videoId: null, abort: null }

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
		session = { videoId, abort: controller }
		resetQueue(null)
		setUserPaused(false)
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
})()

// ==UserScript==
// @name         Flow Youtube Chat Lite
// @namespace    FlowYoutubeChatLite
// @version      0.23.0
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
	// 設定項目の定義。既定値・選べる値・設定画面の構成は、すべてここから作る（項目を足すときはここに 1 回だけ書く）。
	// type: toggle / choice / range / list（札型の一覧）/ custom（設定画面の部品。id で作り方を選ぶ）
	// options: "値=表示名|値=表示名"（数字の値は数として扱う）
	const TAB_TITLES = { display: "表示", users: "ユーザー", filter: "フィルタ", other: "その他" }
	const ITEMS = [
		{ tab: "display", key: "enabled", def: true, type: "toggle", label: "コメントを流す", desc: "オフにすると画面上のコメントを消します" },
		{
			tab: "display",
			key: "size",
			def: "medium",
			type: "choice",
			options: "small=小|medium=中|large=大",
			label: "文字の大きさ",
			desc: "プレイヤーの高さに合わせて自動で調整されます",
		},
		{
			tab: "display",
			key: "speed",
			def: "normal",
			type: "choice",
			options: "slow=遅い|normal=普通|fast=速い|auto=自動",
			label: "速さ",
			desc: "画面を横切る時間（遅い 8秒・普通 6秒・速い 4.5秒）。自動はコメントが多いほど速くなります",
		},
		{
			tab: "display",
			key: "matchPlaybackRate",
			def: true,
			type: "toggle",
			label: "再生速度に合わせる",
			desc: "倍速で見るときはコメントも速く流します（2 倍速で約 0.7 倍の時間）",
		},
		{
			tab: "display",
			key: "opacity",
			def: 1,
			type: "range",
			min: 0.2,
			max: 1,
			step: 0.1,
			format: v => `${Math.round(v * 100)}%`,
			label: "不透明度",
			desc: "下げると動画が見やすくなります",
		},
		{
			tab: "display",
			key: "area",
			def: "full",
			type: "choice",
			options: "full=全体|upper2/3=上 2/3|upper1/2=上半分",
			label: "流す範囲",
			desc: "操作ボタンなどと重なるときは狭めてください",
		},
		{ tab: "display", key: "showAuthor", def: false, type: "toggle", label: "投稿者名を表示", desc: "コメントの前に小さく名前を出します" },

		{ tab: "users", type: "custom", id: "legend", label: "色の意味" },
		{ tab: "users", type: "custom", id: "recent", label: "最近コメントした人" },
		{
			tab: "users",
			key: "highlightUsers",
			def: [],
			type: "list",
			users: true,
			label: "紫で表示するユーザー",
			desc: "紫の色付きで、アイコン・名前を付けて流します",
		},
		{
			tab: "users",
			key: "pinUsers",
			def: [],
			type: "list",
			users: true,
			label: "固定表示するユーザー",
			desc: "流さずに、画面下にアイコン・名前付きで固定表示します（紫より優先）",
		},
		{ tab: "users", key: "ngUsers", def: [], type: "list", users: true, label: "NG ユーザー", desc: "扱いは下の「NG ユーザーのコメント」で選べます" },
		{
			tab: "users",
			key: "ngUserMode",
			def: "hide",
			type: "choice",
			options: "hide=流さない|only=NG だけ流す|split=下半分に流す",
			label: "NG ユーザーのコメント",
			desc: "NG だけ流す：NG ユーザー以外は流しません。下半分に流す：NG ユーザーは画面の下半分、それ以外の人は上半分を流れます（流す範囲の設定より優先）",
		},
		{ tab: "users", type: "custom", id: "ngComments", label: "NG ユーザーの最近のコメント" },
		{
			tab: "users",
			key: "staffMode",
			def: "flow",
			type: "choice",
			options: "flow=流す|highlight=紫で流す|pin=固定",
			label: "配信者・モデレーター",
			desc: "コメントの扱い。紫で流す・固定表示は、指定したユーザーと同じ表示になります",
		},
		{
			tab: "users",
			key: "pinSeconds",
			def: 15,
			type: "choice",
			options: "15=15 秒|30=30 秒|60=60 秒|120=120 秒",
			label: "固定表示の時間",
			desc: "新しい固定コメントは上に積み上がり、多すぎるときは古いものから消えます",
		},
		{ tab: "users", type: "custom", id: "pinHistory", label: "固定コメントの履歴" },

		{
			tab: "filter",
			key: "ngWords",
			def: [],
			type: "list",
			placeholder: "例：ネタバレ",
			label: "NG ワード",
			desc: "この言葉を含むコメントは流しません。/〜/ で囲むと正規表現",
		},
		{
			tab: "filter",
			key: "maxChars",
			def: 0,
			type: "choice",
			options: "0=しない|30=30 字|50=50 字|80=80 字",
			label: "長いコメントを切り詰める",
			desc: "超えた分を「…」で省略して流します（固定表示は除く）",
		},
		{
			tab: "filter",
			key: "hideStampOnly",
			def: false,
			type: "toggle",
			label: "絵文字・スタンプだけのコメントを流さない",
			desc: "本文に文字が無いコメントを流しません（スーパーチャットは除く）",
		},
		{
			tab: "filter",
			key: "collapseRepeats",
			def: true,
			type: "toggle",
			label: "同じコメントをまとめる",
			desc: "5 秒以内に同じ文が来たら、新しく流さずに「×2」のように回数を付けます",
		},
		{
			tab: "filter",
			key: "userRateLimit",
			def: 0,
			type: "choice",
			options: "0=オフ|5=ゆるめ（5件）|2=強め（2件）",
			label: "同じ人の連投を抑える",
			desc: "10 秒間に流す同じ人のコメントの上限。スーパーチャット・配信者・モデレーター・紫のユーザーは対象外",
		},
		{ tab: "filter", key: "emphasizePaid", def: true, type: "toggle", label: "スーパーチャットを目立たせる", desc: "1.3 倍の大きさで、ゆっくり流します" },

		{
			tab: "other",
			key: "maxOnScreen",
			def: 60,
			type: "choice",
			options: "20=20|40=40|60=60|100=100",
			label: "混雑時の上限",
			desc: "同時に流すコメントの数の上限。多いほど賑やかですが、端末が重くなります",
		},
		{
			tab: "other",
			key: "noOverlap",
			def: true,
			type: "toggle",
			label: "混んでいるときは間引く",
			desc: "オン：空いている場所が無いコメントは流しません　オフ：重ねて流します",
		},
		{
			tab: "other",
			key: "syncLatency",
			def: true,
			type: "toggle",
			label: "映像の遅れに合わせる（ライブ）",
			desc: "ライブ映像は実際より数秒遅れて届くので、その分コメントも遅らせて流します",
		},
		{
			tab: "other",
			key: "showHeatmap",
			def: false,
			type: "toggle",
			label: "コメントの多い場面を表示（アーカイブ）",
			desc: "シークバーの上にコメント量をグラフで出します。全コメントを読み込むため、2 時間の配信で約 17MB の通信が発生します",
		},
		{ tab: "other", type: "custom", id: "peaks", label: "盛り上がった場面（アーカイブ）" },
		{ tab: "other", type: "custom", id: "backup", label: "設定のバックアップ" },
		{ tab: "other", type: "custom", id: "status", label: "状態（不具合のときはこの欄のスクショを送ってください）" },
		{ tab: "other", type: "custom", id: "reset" },
	]
	// options の文字列を [値, 表示名] の組に分ける（choices に入れる）
	for (const item of ITEMS)
		if (item.options)
			item.choices = item.options.split("|").map(pair => {
				const [v, text] = pair.split("=")
				return [/^\d+$/.test(v) ? Number(v) : v, text]
			})
	const DEFAULTS = Object.fromEntries(ITEMS.filter(i => i.key).map(i => [i.key, i.def]))
	// 選択式の項目で選べる値。保存値が選べる値に無ければ（選択肢を変えたときなど）既定値に戻す
	const CHOICES = Object.fromEntries(ITEMS.filter(i => i.type === "choice").map(i => [i.key, i.choices.map(([v]) => v)]))
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
	const COLORS = { normal: "#ffffff", member: "#ffffff", moderator: "#7fb2ff", owner: "#ffd84d", highlight: "#c58cff", ng: "#a8a8a8" }
	const LINE_HEIGHT = 1.2
	const GAP_PX = 16

	const loadSettings = (raw = localStorage.getItem(STORAGE_KEY)) => {
		let saved = {}
		try {
			saved = JSON.parse(raw ?? "{}") ?? {}
		} catch {}
		// v0.16.0 までの「配信者・モデレーターを固定表示」（オン・オフ）を 3 択に引き継ぐ
		if (saved.staffMode === undefined && saved.pinStaff === true) saved.staffMode = "pin"
		// 型が既定値と違う値は捨てる（壊れた保存値で NaN にならないように）
		return Object.fromEntries(
			Object.entries(DEFAULTS).map(([k, d]) => {
				const v = saved[k]
				const ok =
					(Array.isArray(d) ? Array.isArray(v) : typeof v === typeof d && !(typeof v === "number" && !Number.isFinite(v))) &&
					(!CHOICES[k] || CHOICES[k].includes(v))
				return [k, ok ? v : d]
			}),
		)
	}
	const settings = loadSettings()

	// ページ側の window。@grant を付けると拡張によってはページから切り離された環境で動くので、
	// ytcfg などページの値は unsafeWindow を通して読む（無ければ同じ window）
	const pageWindow = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window
	if (location.hostname !== "m.youtube.com") document.documentElement.classList.add("fyl-www")

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

	// ---------- 共通の部品 ----------
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
	let isNgUser = () => false
	/** @type {(chat: Chat) => boolean} */
	let isNgWord = () => false
	/** @type {(chat: Chat) => boolean} */
	let isHighlighted = () => false
	/** @type {(chat: Chat) => boolean} */
	let isPinnedUser = () => false
	const isStaff = chat => chat.type === "owner" || chat.type === "moderator"
	// 紫で流すコメント：紫で表示するユーザーと、「紫で流す」にした配信者・モデレーター
	const isPurple = chat => isHighlighted(chat) || (settings.staffMode === "highlight" && isStaff(chat))
	const rebuildNg = () => {
		const words = ngMatchers()
		isNgUser = userMatcher(settings.ngUsers)
		isNgWord = chat => {
			const text = chat.parts.map(p => p.text ?? "").join("")
			return words.some(f => f(text))
		}
		isHighlighted = userMatcher(settings.highlightUsers)
		isPinnedUser = userMatcher(settings.pinUsers)
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
.fyl-chat.fyl-ng { opacity: 0.7; }
.fyl-chat img.fyl-avatar, .fyl-pin img.fyl-avatar { width: 1em; height: 1em; border-radius: 50%; object-fit: cover; margin-right: 0.25em; }
.fyl-heat { position: absolute; left: 0; right: 0; bottom: 100%; height: 28px; pointer-events: none; }
.fyl-heat svg { display: block; width: 100%; height: 100%; }
.fyl-heat path { fill: rgba(197, 140, 255, 0.55); }
.fyl-heat.fyl-heat-fallback { bottom: 0; height: 14px; opacity: 0.7; z-index: 31; }
.fyl-count { font-size: 0.75em; margin-left: 0.3em; color: #ffe08a; }
.fyl-pinned { position: absolute; bottom: 0.3em; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: flex-start;
	gap: 0.15em; max-width: 92%; transition: bottom 0.15s; }
html.fyl-www .html5-video-player:not(.ytp-autohide) .fyl-pinned { bottom: 60px; }
.fyl-pin { font-size: 0.85em; font-weight: 700; line-height: 1.25; padding: 0.15em 0.5em; border-radius: 0.3em; background: rgba(0,0,0,.55);
	border-left: 0.25em solid var(--fyl-pin-color, #fff); max-width: 100%; box-sizing: border-box;
	text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000; }
.fyl-pin-body { line-height: 1.4; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; white-space: normal; word-break: break-all; }
.fyl-pin .fyl-author { font-size: 0.8em; opacity: 0.9; margin-right: 0.4em; }
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
		const areaRatio = settings.ngUserMode === "split" ? 1 : AREA_RATIO[settings.area]
		const laneCount = Math.max(1, Math.floor((r.height * areaRatio) / (state.fontPx * LINE_HEIGHT)))
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
	// from / limit: 使ってよいレーンの範囲（下半分モードなど）
	const pickLane = (w, dur, now, span = 1, limit = state.lanes.length, from = 0) => {
		const vNew = (state.pw + w) / dur
		const n = Math.min(span, limit - from)
		let fallback = from
		let oldest = Number.POSITIVE_INFINITY
		for (let i = from; i + n <= limit; i++) {
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
	// withAuthor: アイコンと名前を必ず付ける（紫・固定表示のユーザー）
	const fillChat = (el, chat, withAuthor = isPurple(chat)) => {
		el.style.color = isPurple(chat) || isPinnedUser(chat) ? COLORS.highlight : COLORS[chat.type]
		if (chat.paid) el.append(h("span", { class: "fyl-paid", style: chat.paidColor ? `background:${chat.paidColor}` : "" }, chat.paid))
		if (withAuthor && chat.photo) el.append(h("img", { class: "fyl-avatar", src: chat.photo, alt: "", decoding: "async" }))
		if ((settings.showAuthor || withAuthor) && chat.author) el.append(h("span", { class: "fyl-author" }, chat.author))
		for (const p of chat.parts) el.append(p.img ? h("img", { src: p.img, alt: p.alt, decoding: "async" }) : (p.text ?? ""))
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

	// 固定表示：固定表示するユーザーと（設定でオンなら）配信者・モデレーターのコメントを、流さずに画面下へ出す。
	// 新しいものは上に積み上がり、件数を超えたら一番古いもの（一番下）から消える。
	// 件数はプレイヤーが低いとき（iPhone の縦向きなど）は 2 件、それ以外は 3 件
	const PIN = { lowPlayerPx: 300 }
	const PIN_COLORS = { user: COLORS.highlight, owner: COLORS.owner, moderator: COLORS.moderator }
	const pinned = document.createElement("div")
	pinned.className = "fyl-pinned"
	const pinKind = chat => {
		if (isPinnedUser(chat)) return "user"
		if (settings.staffMode === "pin" && isStaff(chat)) return chat.type
		return null
	}
	// 固定コメントの履歴（新しい順に最大 20 件）。時間切れや件数あふれで消えたものも設定画面で読み返せる
	const PIN_HISTORY_MAX = 20
	const pinHistory = []
	const pinChat = (chat, kind) => {
		pinHistory.unshift({ chat, kind, at: Date.now() })
		pinHistory.length = Math.min(pinHistory.length, PIN_HISTORY_MAX)
		if (!pinned.isConnected) screen.append(pinned)
		// 枠（背景・色の帯・余白）と本文を分け、本文の側で 2 行に切る（枠の余白に 3 行目がはみ出さないように）
		const body = fillChat(document.createElement("span"), chat, true)
		body.className = "fyl-pin-body"
		const el = h("div", { class: "fyl-pin" }, body)
		el.style.setProperty("--fyl-pin-color", PIN_COLORS[kind])
		pinned.prepend(el)
		const max = state.ph < PIN.lowPlayerPx ? 2 : 3
		while (pinned.children.length > max) pinned.lastElementChild.remove()
		setTimeout(() => el.remove(), settings.pinSeconds * 1000)
	}
	// 固定欄が出ている間は、その高さより上のレーンだけを使う
	// 「下半分に流す」モードでは、NG ユーザーは下半分のレーン、それ以外は上半分のレーンを使う
	const laneRange = (ngUser, limit) => {
		if (settings.ngUserMode !== "split" || limit < 2) return [0, limit]
		const half = Math.floor(limit / 2)
		return ngUser ? [half, limit] : [0, half]
	}
	const usableLanes = () => {
		if (!pinned.isConnected || !pinned.childElementCount) return state.lanes.length
		const lineH = state.fontPx * LINE_HEIGHT
		return Math.max(1, Math.min(state.lanes.length, Math.floor(pinned.offsetTop / lineH)))
	}

	// 同じ人の連投を抑える：10 秒あたり userRateLimit 件を超えた分は流さない。
	// スーパーチャット・配信者・モデレーター・紫で表示するユーザーは対象外
	const RATE_WINDOW_MS = 10000
	const postsByAuthor = new Map() // userKey -> 流した時刻の一覧
	const isRateLimited = (chat, now) => {
		if (!settings.userRateLimit || !chat.author || chat.paid || isStaff(chat) || isPurple(chat)) return false
		const k = userKey(chat.author)
		const recent = (postsByAuthor.get(k) ?? []).filter(t => now - t < RATE_WINDOW_MS)
		if (recent.length >= settings.userRateLimit) {
			postsByAuthor.set(k, recent)
			return true
		}
		recent.push(now)
		postsByAuthor.set(k, recent)
		if (postsByAuthor.size > 500) postsByAuthor.delete(postsByAuthor.keys().next().value)
		return false
	}

	// スーパーチャットを目立たせるときの大きさは CSS（.fyl-big）、速さはこの倍率
	const PAID_SLOWER = 1.3

	// 再生速度に合わせる：流れる時間を再生速度の平方根で割る（2 倍速で約 0.71 倍。単純に割ると速すぎて読めないため）
	const playbackFactor = () => (settings.matchPlaybackRate ? Math.sqrt(state.video?.playbackRate || 1) : 1)

	// 長いコメントを切り詰める：文字（絵文字・濁点付きも 1 文字）とカスタム絵文字の画像を数え、超えた分を「…」にする
	const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("ja", { granularity: "grapheme" }) : null
	const splitChars = text => (graphemes ? [...graphemes.segment(text)].map(g => g.segment) : [...text])
	const truncateChat = (chat, max) => {
		if (!max) return chat
		const parts = []
		let left = max
		for (const p of chat.parts) {
			if (left <= 0) {
				parts.push({ text: "…" })
				return { ...chat, parts }
			}
			if (p.img) {
				parts.push(p)
				left--
				continue
			}
			const chars = splitChars(p.text ?? "")
			parts.push({ text: chars.slice(0, left).join("") })
			left -= chars.length
		}
		if (left < 0) parts.push({ text: "…" })
		return { ...chat, parts }
	}

	const flow = chat => {
		if (!settings.enabled || !state.player || state.pw === 0) return
		// NG ユーザーの扱い：流さない / NG ユーザーだけ流す / NG ユーザーは下半分・それ以外は上半分
		const ngUser = isNgUser(chat)
		if (ngUser ? settings.ngUserMode === "hide" : settings.ngUserMode === "only") return
		if (isNgWord(chat)) return
		if (chat.parts.length === 0 && !chat.paid) return
		if (settings.hideStampOnly && !chat.paid && isStampOnly(chat)) return
		const now = performance.now()
		arrivals.push(now)
		const kind = pinKind(chat)
		if (kind) return pinChat(chat, kind)
		if (isRateLimited(chat, now)) return
		if (settings.collapseRepeats && !chat.paid && bumpRepeat(chat, now)) return
		if (state.onScreen >= settings.maxOnScreen) return
		const big = settings.emphasizePaid && !!chat.paid
		const el = buildChatElement(truncateChat(chat, settings.maxChars))
		if (big) el.classList.add("fyl-big")
		// NG ユーザーのコメントを流すとき（下半分に流す・NG だけ流す）は、灰色で少し透けた表示にして見分けやすくする
		if (ngUser) {
			el.classList.add("fyl-ng")
			el.style.color = COLORS.ng
		}
		const dur = Math.round((currentDuration(now) * (big ? PAID_SLOWER : 1)) / playbackFactor())
		el.style.visibility = "hidden"
		el.style.animation = "none"
		screen.append(el)
		const w = el.getBoundingClientRect().width
		const span = big ? 2 : 1
		const [from, to] = laneRange(ngUser, usableLanes())
		const lane = pickLane(w, dur, now, span, to, from)
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
	// 投稿者ごとの回数と直近のコメント（今見ている動画の分。最近コメントした順、最大 300 人・1 人 30 件）。
	// アーカイブを戻したときやライブの巻き戻しで同じコメントを二度数えないよう、コメントの ID で重複を除く
	const AUTHOR = { max: 300, perUser: 30, shown: 30, ngShown: 50 }
	const authors = new Map() // userKey -> { author, channelId, count, comments: [{ ts, text }]（新しい順） }
	const seenChatIds = new Set()
	const commentText = chat => chat.parts.map(p => p.text ?? p.alt ?? "").join("")
	const rememberAuthor = chat => {
		if (!chat.author || (chat.id && seenChatIds.has(chat.id))) return
		if (chat.id) seenChatIds.add(chat.id)
		const k = userKey(chat.author)
		const a = authors.get(k) ?? { author: chat.author, channelId: chat.channelId, count: 0, comments: [] }
		authors.delete(k)
		a.count++
		a.comments.unshift({ ts: chat.ts, text: commentText(chat) })
		a.comments.length = Math.min(a.comments.length, AUTHOR.perUser)
		authors.set(k, a)
		if (authors.size > AUTHOR.max) authors.delete(authors.keys().next().value)
	}
	const resetAuthors = () => {
		authors.clear()
		seenChatIds.clear()
	}
	// NG ユーザーの最近のコメント（新しい順）
	const ngComments = () =>
		[...authors.values()]
			.filter(a => isNgUser({ author: a.author, channelId: a.channelId, ts: 0, type: "normal", parts: [] }))
			.flatMap(a => a.comments.map(c => ({ ...c, author: a.author })))
			.sort((x, y) => y.ts - x.ts)
			.slice(0, AUTHOR.ngShown)

	// スーパーチャット（ステッカーを含む）の件数と通貨ごとの合計。ページを開いてから（動画を移るとやり直す）。
	// アーカイブで同じ場面を見直しても二重に数えないよう、コメントの ID で重複を除く
	const paidTotals = { ids: new Set(), count: 0, sums: new Map() }
	const resetPaidTotals = () => Object.assign(paidTotals, { ids: new Set(), count: 0, sums: new Map() })
	const countPaid = chat => {
		if (!chat.paid || (chat.id && paidTotals.ids.has(chat.id))) return
		if (chat.id) paidTotals.ids.add(chat.id)
		paidTotals.count++
		// 「¥1,000」「$5.00」「CA$10」などを通貨の記号と金額に分ける
		const m = /^([^\d]*)([\d.,]+)/.exec(chat.paid.trim())
		if (!m) return
		const symbol = m[1].trim() || "?"
		paidTotals.sums.set(symbol, (paidTotals.sums.get(symbol) ?? 0) + Number(m[2].replace(/,/g, "")))
	}
	const paidSummary = () =>
		paidTotals.count
			? `スーパーチャット：${paidTotals.count} 件（${[...paidTotals.sums].map(([sym, sum]) => `${sym}${sum.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}`).join("・")}）`
			: ""

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
			countPaid(chat)
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
	// 応答の continuations から種類を指定して取り出す（並び順に頼らない）
	const pickContinuation = (lc, type) => lc?.continuations?.find(c => c[type])?.[type]?.continuation
	// アーカイブのチャットを 1 ページ読む（シーク追従とコメント量グラフで共通）。
	// groups: 動画内の時刻（due）ごとのコメントのまとまり / next: 続き / seek: シーク用のチャット情報
	const readReplayPage = async (continuation, offsetMs, signal) => {
		const res = await api(YT.endpoints.replay, { continuation, currentPlayerState: { playerOffsetMs: String(Math.max(0, Math.floor(offsetMs))) } }, signal)
		const lc = res.continuationContents?.liveChatContinuation
		const groups = (lc?.actions ?? [])
			.map(a => a.replayChatItemAction)
			.filter(r => r && Number(r.videoOffsetTimeMsec) >= 0)
			.map(r => ({ due: Number(r.videoOffsetTimeMsec), actions: r.actions ?? [] }))
		const dues = groups.map(g => g.due)
		return {
			groups,
			next: pickContinuation(lc, "liveChatReplayContinuationData"),
			seek: pickContinuation(lc, "playerSeekContinuationData"),
			minDue: Math.min(...dues),
			maxDue: Math.max(...dues),
		}
	}
	// ページの初期データのチャット情報は「開いた位置」に結び付いていて、別の位置を指定しても開いた位置のコメントが返る。
	// シークでは YouTube 自身と同じく、応答に含まれるシーク用のチャット情報（playerSeekContinuationData）を使う
	const MISMATCH_MS = 60000 // 要求した位置よりこれ以上先のコメントしか返らなければ、別の位置に結び付いたチャット情報とみなす
	const runReplay = async (initialContinuation, signal) => {
		const videoMs = () => (state.video?.currentTime ?? 0) * 1000
		resetQueue(videoMs)
		let continuation = initialContinuation
		let seekContinuation = null
		let bufferedUntil = -1
		let lastMs = -1
		let lastCheck = 0

		const fetchFrom = async offsetMs => {
			const page = await readReplayPage(continuation, offsetMs, signal)
			if (page.seek && !seekContinuation) {
				session.replaySeekContinuation = page.seek
				startHeatmap()
			}
			if (page.seek) seekContinuation = page.seek
			if (page.groups.length && page.minDue > offsetMs + MISMATCH_MS && seekContinuation && continuation !== seekContinuation) {
				// 別の位置のコメントが返った：シーク用のチャット情報で読み直す（次の確認で再取得される）
				continuation = seekContinuation
				return
			}
			// 今の再生位置より前のコメントは流さない
			const from = videoMs()
			enqueue(page.groups.filter(g => g.due > from).flatMap(g => itemsFromActions(g.actions).map(chat => ({ due: g.due, chat }))))
			bufferedUntil = Math.max(bufferedUntil, page.maxDue)
			setStatus({ lastOk: Date.now(), error: "", received: status.received + page.groups.length })
			if (page.next) continuation = page.next
			else bufferedUntil = Number.POSITIVE_INFINITY // 最後まで読み終えた
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
					continuation = seekContinuation ?? initialContinuation
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
	const heat = { el: null, path: null, counts: null, abort: null, durMs: 0 }
	const removeHeatmap = () => {
		heat.abort?.abort()
		heat.el?.remove()
		Object.assign(heat, { el: null, path: null, counts: null, abort: null })
		setStatus({ heatmap: "-" })
	}
	// 盛り上がった場面：コメントの多い区間の上位 5 か所を時刻順に返す（近すぎる区間は選ばない）
	const PEAKS = { count: 5, minGapBins: 3 }
	const heatPeaks = () => {
		if (!heat.counts || !heat.durMs) return []
		const picked = []
		const order = heat.counts.map((n, bin) => ({ n, bin })).filter(x => x.n > 0)
		order.sort((a, b) => b.n - a.n)
		for (const x of order) {
			if (picked.length >= PEAKS.count) break
			if (picked.every(p => Math.abs(p.bin - x.bin) >= PEAKS.minGapBins)) picked.push(x)
		}
		return picked.map(x => ({ sec: Math.floor(((x.bin / HEAT.bins) * heat.durMs) / 1000), count: x.n })).sort((a, b) => a.sec - b.sec)
	}
	const formatTime = sec => {
		const [hh, mm, ss] = [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60]
		const two = n => String(n).padStart(2, "0")
		return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`
	}
	// YouTube のプレイヤー自身のシーク機能で移動する（動画の再生位置を直接書き換えると YouTube の再生が壊れる）
	const seekVideo = sec => state.player?.seekTo?.(sec, true)

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
		const continuation = session.replaySeekContinuation
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
			heat.durMs = durMs
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
				const page = await readReplayPage(cont, offset, signal)
				for (const g of page.groups) {
					offset = Math.max(offset, g.due)
					for (const x of g.actions) {
						const item = x.addChatItemAction?.item
						const id = item && Object.values(item)[0]?.id
						if (!id || seen.has(id)) continue
						seen.add(id)
						heat.counts[Math.min(HEAT.bins - 1, Math.max(0, Math.floor((g.due / durMs) * HEAT.bins)))]++
					}
				}
				drawHeatmap()
				setStatus({ heatmap: `読み込み中 ${Math.min(100, Math.round((offset / durMs) * 100))}%（${seen.size} 件）` })
				cont = page.next
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
	const LIST_KEYS = ["ngWords", "ngUsers", "highlightUsers", "pinUsers"]
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

	const PREVIEW_KEYS = new Set(["size", "opacity", "showAuthor", "speed", "area"])
	const previewFlow = () => flow({ ts: Date.now(), author: "プレビュー", channelId: "", type: "normal", parts: [{ text: "プレビュー：このように流れます" }] })

	// 一覧（紫・固定・NG ユーザー、NG ワード）の表示を作り直す関数。最近コメントした人のボタンで変えたときにも使う
	const listRenderers = new Map() // 設定キー -> 再描画の関数
	const setList = (key, next) => {
		applySetting(key, next)
		listRenderers.get(key)?.()
	}
	// ユーザーを紫・固定・NG の一覧に追加する（既にあれば外す）
	const hasUser = (key, author) => settings[key].some(x => userKey(x) === userKey(author))
	const toggleUser = (key, author) =>
		setList(key, hasUser(key, author) ? settings[key].filter(x => userKey(x) !== userKey(author)) : [...settings[key], author])

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

	const applySetting = (key, value) => {
		settings[key] = value
		saveSettings()
		if (key === "enabled") {
			if (!value) clearScreen()
			updateButtons()
		}
		if (LIST_KEYS.includes(key)) rebuildNg()
		if (key === "showHeatmap") value ? startHeatmap() : removeHeatmap()
		layout()
		if (PREVIEW_KEYS.has(key)) previewFlow()
	}

	// ---- 設定画面の部品 ----
	const toggleControl = item =>
		h("input", {
			type: "checkbox",
			class: "switch",
			checked: settings[item.key],
			"aria-label": item.label,
			onchange: e => applySetting(item.key, e.target.checked),
		})
	const choiceControl = item => {
		const control = h("div", { class: "seg", role: "radiogroup", "aria-label": item.label })
		for (const [v, text] of item.choices) {
			const b = h(
				"button",
				{
					class: v === settings[item.key] ? "on" : "",
					role: "radio",
					"aria-checked": String(v === settings[item.key]),
					onclick: () => {
						for (const x of control.children) {
							x.className = x === b ? "on" : ""
							x.setAttribute("aria-checked", String(x === b))
						}
						applySetting(item.key, v)
					},
				},
				text,
			)
			control.append(b)
		}
		return control
	}
	const rangeControl = item => {
		const out = h("span", {}, item.format(settings[item.key]))
		const input = h("input", {
			type: "range",
			min: item.min,
			max: item.max,
			step: item.step,
			value: settings[item.key],
			"aria-label": item.label,
			oninput: e => {
				out.textContent = item.format(Number(e.target.value))
			},
			onchange: e => applySetting(item.key, Number(e.target.value)),
		})
		return h("div", { class: "range" }, input, out)
	}
	// 札型の一覧：1 件ずつ × で消せる。追加は入力欄と「追加」ボタン（Enter でも追加）
	const listControl = item => {
		const chips = h("div", { class: "chips" })
		const same = (a, b) => (item.users ? userKey(a) === userKey(b) : a === b)
		const render = () => {
			const list = settings[item.key]
			chips.replaceChildren(
				...(list.length
					? list.map(v =>
							h(
								"span",
								{ class: "chip" },
								v,
								h(
									"button",
									{
										class: "chip-x",
										"aria-label": `${v} を外す`,
										onclick: () =>
											setList(
												item.key,
												settings[item.key].filter(x => x !== v),
											),
									},
									"×",
								),
							),
						)
					: [h("span", { class: "desc" }, "まだありません")]),
			)
		}
		listRenderers.set(item.key, render)
		render()
		const input = h("input", {
			type: "text",
			class: "add-input",
			placeholder: item.placeholder ?? (item.users ? "@表示名 または チャンネルID" : ""),
			"aria-label": `${item.label}に追加`,
			autocapitalize: "off",
			spellcheck: false,
		})
		const add = () => {
			const v = input.value.trim()
			if (!v) return
			if (!settings[item.key].some(x => same(x, v))) setList(item.key, [...settings[item.key], v])
			input.value = ""
		}
		input.addEventListener("keydown", e => e.key === "Enter" && add())
		return [chips, h("div", { class: "add-row" }, input, h("button", { class: "tag", onclick: add }, "追加"))]
	}

	// 最近コメントした人：タップで紫・固定・NG に追加（もう一度で外す）
	// 最近コメントした人：回数と最新のコメントを出し、名前を押すとその人のコメント一覧を開く。
	// 右のボタンで紫・固定・NG に追加（もう一度で外す）
	const formatClock = ts => new Date(ts).toLocaleTimeString("ja-JP")
	const commentLog = comments =>
		h(
			"div",
			{ class: "log" },
			comments.map(c => h("div", {}, h("time", {}, formatClock(c.ts)), c.text || "（スタンプ）")),
		)
	const buildRecentList = () => {
		const box = h("div", { class: "recent" })
		const render = () => {
			const rows = [...authors.values()].reverse().slice(0, AUTHOR.shown)
			box.replaceChildren(
				...(rows.length
					? rows.map(a => {
							const toggle = (key, label, cls) => {
								const b = h(
									"button",
									{
										class: `tag ${cls}${hasUser(key, a.author) ? " on" : ""}`,
										"aria-pressed": String(hasUser(key, a.author)),
										onclick: () => {
											toggleUser(key, a.author)
											b.classList.toggle("on", hasUser(key, a.author))
											b.setAttribute("aria-pressed", String(hasUser(key, a.author)))
										},
									},
									label,
								)
								return b
							}
							const log = commentLog(a.comments)
							log.hidden = true
							const head = h(
								"button",
								{
									class: "who-text",
									"aria-expanded": "false",
									onclick: () => {
										log.hidden = !log.hidden
										head.setAttribute("aria-expanded", String(!log.hidden))
									},
								},
								h("b", {}, a.author, h("span", { class: "count" }, `${a.count} 件`)),
								h("span", {}, a.comments[0]?.text ?? ""),
							)
							return h(
								"div",
								{ class: "who-wrap" },
								h("div", { class: "who" }, head, toggle("highlightUsers", "紫", "purple"), toggle("pinUsers", "固定", "pin"), toggle("ngUsers", "NG", "ng")),
								log,
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
				h("div", { class: "desc" }, "この動画での回数。名前を押すとコメント一覧を開きます。右のボタンで追加、もう一度で外します"),
				h("button", { class: "tag", onclick: render }, "更新"),
			),
			box,
		]
	}
	// NG ユーザーの最近のコメント（流していないものも含む）
	const buildNgComments = () => {
		const box = h("div", { class: "recent" })
		const render = () => {
			const list = ngComments()
			box.replaceChildren(
				...(list.length
					? list.map(c =>
							h(
								"div",
								{ class: "who" },
								h("div", { class: "who-text" }, h("b", {}, `${formatClock(c.ts)}　${c.author}`), h("span", { class: "full" }, c.text || "（スタンプ）")),
							),
						)
					: [h("div", { class: "desc" }, "この動画では、まだ NG ユーザーのコメントはありません")]),
			)
		}
		render()
		return [h("div", { class: "row" }, h("div", { class: "desc" }, "新しい順に 50 件まで"), h("button", { class: "tag", onclick: render }, "更新")), box]
	}

	// 固定コメントの履歴：消えたものも含めて最近の 20 件を、省略せずに読み返す
	const buildPinHistory = () => {
		const box = h("div", { class: "recent" })
		const render = () => {
			box.replaceChildren(
				...(pinHistory.length
					? pinHistory.map(({ chat, kind, at }) =>
							h(
								"div",
								{ class: "who pin-log", style: `border-left-color:${PIN_COLORS[kind]}` },
								h(
									"div",
									{ class: "who-text" },
									h("b", {}, `${new Date(at).toLocaleTimeString("ja-JP")}　${chat.author}`),
									h("span", { class: "full" }, chat.parts.map(p => p.text ?? p.alt ?? "").join("")),
								),
							),
						)
					: [h("div", { class: "desc" }, "まだ固定表示されたコメントはありません")]),
			)
		}
		render()
		return [h("div", { class: "row" }, h("div", { class: "desc" }, "新しい順に 20 件まで"), h("button", { class: "tag", onclick: render }, "更新")), box]
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
						rebuildPanel()
					} catch (e) {
						say(`読み込めませんでした：${e.message}`)
					}
				},
			},
			"読み込む",
		)
		return [h("div", { class: "row" }, message, h("div", { class: "backup-buttons" }, exportBtn, importBtn)), box]
	}

	// 盛り上がった場面：押すとその場面へ移動して設定画面を閉じる
	const buildPeaks = () => {
		const box = h("div", { class: "peaks" })
		const render = () => {
			const peaks = heatPeaks()
			box.replaceChildren(
				...(peaks.length
					? peaks.map(p =>
							h(
								"button",
								{
									class: "tag",
									onclick: () => {
										seekVideo(p.sec)
										closePanel()
									},
								},
								`${formatTime(p.sec)}（${p.count} 件）`,
							),
						)
					: [
							h(
								"div",
								{ class: "desc" },
								settings.showHeatmap ? "アーカイブを開くと、コメントを読み込んだあとに表示します" : "「コメントの多い場面を表示」をオンにすると使えます",
							),
						]),
			)
		}
		render()
		return [h("div", { class: "row" }, h("div", { class: "desc" }, "押すとその場面へ移動します"), h("button", { class: "tag", onclick: render }, "更新")), box]
	}

	const buildLegend = () =>
		h(
			"div",
			{ class: "legend" },
			[
				["normal", "一般・メンバー"],
				["moderator", "モデレーター"],
				["owner", "配信者"],
				["highlight", "紫・固定のユーザー"],
				["ng", "NG ユーザー（下半分などに流すとき）"],
			].map(([k, t]) => h("span", {}, h("i", { style: `background:${COLORS[k]}` }), t)),
		)

	const buildReset = () => {
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
					applyAllSettings()
					rebuildPanel()
				},
			},
			"初期設定に戻す",
		)
		return resetBtn
	}

	const PANEL_CSS = `
:host { all: initial; --bg: #1f1f1f; --bg2: #2c2c2c; --bg3: #121212; --line: #333; --fg: #f1f1f1; --sub: #9a9a9a; --accent: #3ea6ff; --red: #ff6b6b; }
button { border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
dialog { padding: 0; border: 0; background: none; max-width: none; max-height: none; margin: auto auto 0;
	&::backdrop { background: rgba(0,0,0,.45); }
	@media (min-width: 640px) { margin: auto; } }
.panel { box-sizing: border-box; width: min(440px, 100vw); height: min(80vh, 680px); display: flex; flex-direction: column;
	background: var(--bg); color: var(--fg); border-radius: 16px 16px 0 0;
	font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; -webkit-text-size-adjust: 100%;
	@media (min-width: 640px) { border-radius: 16px; } }
.top { padding: 14px 16px 0; flex-shrink: 0; }
.head { display: flex; align-items: center; justify-content: space-between; & h1 { font-size: 17px; margin: 0; } }
.close { font-size: 24px; line-height: 1; padding: 4px 8px; }
.summary { font-size: 12px; color: var(--sub); margin: 2px 0 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line);
	& button { flex: 1; color: #aaa; font-weight: 600; padding: 8px 0; border-bottom: 2px solid transparent; }
	& button.on { color: #fff; border-bottom-color: var(--accent); } }
.body { flex: 1; overflow: auto; overscroll-behavior: contain; padding: 4px 16px calc(16px + env(safe-area-inset-bottom)); }
.item { padding: 12px 0; border-bottom: 1px solid var(--bg2); &.wide .row { flex-direction: column; align-items: stretch; gap: 8px; } }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.label { font-weight: 600; }
.desc { color: var(--sub); font-size: 12px; margin-top: 2px; }
.seg { display: inline-flex; flex-wrap: wrap; background: var(--bg2); border-radius: 8px; padding: 2px; flex-shrink: 0;
	& button { color: #ddd; padding: 5px 10px; border-radius: 6px; }
	& button.on { background: var(--fg); color: #111; font-weight: 700; } }
.switch { position: relative; width: 46px; height: 28px; flex-shrink: 0; appearance: none; -webkit-appearance: none; background: #555; border-radius: 14px; margin: 0; cursor: pointer; transition: background .15s;
	&::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: transform .15s; }
	&:checked { background: var(--accent); &::after { transform: translateX(18px); } } }
.range { display: flex; align-items: center; gap: 8px;
	& input { width: 140px; accent-color: var(--accent); }
	& span { width: 3em; text-align: right; font-variant-numeric: tabular-nums; } }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; gap: 2px; background: var(--bg2); border-radius: 999px; padding: 3px 4px 3px 10px; font-size: 13px; max-width: 100%; overflow-wrap: anywhere; }
.chip-x { color: #aaa; font-size: 16px; line-height: 1; padding: 2px 6px; }
.add-row, .backup-buttons { display: flex; gap: 6px; }
.add-row { margin-top: 8px; }
.backup-buttons { flex-shrink: 0; }
.add-input, textarea { box-sizing: border-box; background: var(--bg3); color: var(--fg); border: 1px solid #444; border-radius: 8px; }
.add-input { flex: 1; min-width: 0; padding: 7px 8px; font: inherit; }
textarea { width: 100%; min-height: 56px; margin-top: 6px; padding: 8px; font: 12px/1.4 ui-monospace, Menlo, monospace; resize: vertical; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: #bbb; margin-top: 6px;
	& i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; } }
.status { white-space: pre-wrap; font: 12px/1.6 ui-monospace, Menlo, monospace; color: #cfcfcf; background: var(--bg3); border-radius: 8px; padding: 8px 10px; margin-top: 6px; }
.recent { margin-top: 6px; max-height: 280px; overflow: auto; border-radius: 8px; background: #181818; }
.who { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; &.pin-log { border-left: 3px solid #fff; } }
.who-text { flex: 1; min-width: 0; display: flex; flex-direction: column;
	& b, & span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	& b { font-size: 13px; }
	& span { font-size: 12px; color: var(--sub); }
	& span.full { white-space: normal; color: #ddd; overflow-wrap: anywhere; } }
.tag { flex-shrink: 0; border: 1px solid #555; color: #ddd; font-size: 12px; font-weight: 600; line-height: 1; padding: 6px 10px; border-radius: 999px;
	&.on { color: #111; }
	&.purple.on { background: #c58cff; border-color: #c58cff; }
	&.ng.on { background: var(--red); border-color: var(--red); }
	&.pin.on { background: var(--fg); border-color: var(--fg); } }
.who-wrap { border-bottom: 1px solid #2a2a2a; & .who { border-bottom: 0; } }
button.who-text { text-align: left; padding: 0; }
.count { font-weight: 400; color: var(--sub); margin-left: 6px; font-size: 12px; }
.log { padding: 0 8px 8px 12px; font-size: 12px; color: #ddd; overflow-wrap: anywhere;
	& div { padding: 2px 0; }
	& time { color: var(--sub); margin-right: 6px; font-variant-numeric: tabular-nums; } }
.peaks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.reset { margin-top: 6px; width: 100%; padding: 10px; border-radius: 10px; border: 1px solid #555; color: #ddd;
	&.armed { border-color: var(--red); color: var(--red); } }
`

	const VERSION = typeof GM_info === "object" ? (GM_info?.script?.version ?? "-") : "-"
	const statusLines = () => {
		const ago = status.lastOk ? `${Math.round((Date.now() - status.lastOk) / 1000)} 秒前` : "まだありません"
		return [
			`チャット：${status.mode}${status.source !== "-" ? `（取得元：${status.source}）` : ""}`,
			`最終取得：${ago}　受信：${status.received} 件`,
			`エラー：${status.error || "なし"}`,
			...(status.heatmap !== "-" ? [`コメント量：${status.heatmap}`] : []),
			...(paidTotals.count ? [paidSummary()] : []),
			`バージョン：${VERSION}　表示：${isMobileSite ? "モバイル" : "デスクトップ"}`,
		].join("\n")
	}
	// 画面上部の 1 行の状態
	const statusSummary = () =>
		`${status.mode}・受信 ${status.received} 件${paidTotals.count ? `・スパチャ ${paidTotals.count} 件` : ""}${status.error ? `・エラー：${status.error}` : ""}`

	// 設定画面は <dialog> の showModal で出す。最前面（top layer）・暗幕・Esc で閉じる・フォーカス管理はブラウザに任せる
	let panelHost = null
	let panelDialog = null
	/** @type {CSSStyleSheet | null} */
	let panelSheet = null
	const panelTimers = []
	const TAB_KEY = "fyc-lite:tab" // 最後に開いていたタブ（この端末だけの使い勝手なので localStorage）
	const closePanel = () => panelDialog?.close()
	const onPanelClosed = () => {
		for (const t of panelTimers.splice(0)) clearInterval(t)
		panelHost?.remove()
		panelHost = panelDialog = null
	}
	// 1 秒ごとに書き換わる状態表示
	const liveText = (cls, text) => {
		const el = h("div", { class: cls }, text())
		panelTimers.push(
			setInterval(() => {
				el.textContent = text()
			}, 1000),
		)
		return el
	}
	const statusBox = () => liveText("status", statusLines)

	const buildItem = item => {
		if (item.type === "custom") {
			// 部品の作り方（ITEMS の id から選ぶ。どれも後ろで定義しているので、ここで呼ぶ時点では使える）
			const build = {
				legend: buildLegend,
				recent: buildRecentList,
				pinHistory: buildPinHistory,
				backup: buildBackup,
				status: statusBox,
				reset: buildReset,
				peaks: buildPeaks,
				ngComments: buildNgComments,
			}[item.id]
			const body = build()
			return item.label ? h("div", { class: "item" }, h("div", { class: "label" }, item.label), body) : h("div", { class: "item" }, body)
		}
		const text = h("div", {}, h("div", { class: "label" }, item.label), item.desc && h("div", { class: "desc" }, item.desc))
		if (item.type === "list") return h("div", { class: "item" }, text, listControl(item))
		const control = item.type === "toggle" ? toggleControl(item) : item.type === "choice" ? choiceControl(item) : rangeControl(item)
		// 選択肢が多い項目は、説明の下に並べる（スマホで窮屈にならないように）
		const wide = item.type === "choice" && item.choices.length * 3 + item.choices.reduce((n, [, t]) => n + t.length, 0) > 16
		return h("div", { class: `item${wide ? " wide" : ""}` }, h("div", { class: "row" }, text, control))
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
	const rebuildPanel = () => {
		onPanelClosed()
		buildPanel()
	}
	const buildPanel = () => {
		listRenderers.clear()
		panelHost = h("div")
		const root = panelHost.attachShadow({ mode: "open" })
		const TABS = Object.entries(TAB_TITLES).map(([id, title]) => ({ id, title, items: ITEMS.filter(i => i.tab === id) }))
		let current = TABS[0].id
		try {
			current = TABS.some(t => t.id === localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : current
		} catch {}
		const bodies = new Map(TABS.map(t => [t.id, h("div", { class: "tab-body", role: "tabpanel" }, t.items.map(buildItem))]))
		const body = h("div", { class: "body" })
		const tabButtons = TABS.map(t =>
			h(
				"button",
				{
					role: "tab",
					onclick: () => {
						current = t.id
						try {
							localStorage.setItem(TAB_KEY, current)
						} catch {}
						show()
					},
				},
				t.title,
			),
		)
		const show = () => {
			TABS.forEach((t, i) => {
				tabButtons[i].className = t.id === current ? "on" : ""
				tabButtons[i].setAttribute("aria-selected", String(t.id === current))
			})
			body.replaceChildren(bodies.get(current))
			body.scrollTop = 0
		}
		show()
		const panel = h(
			"div",
			{ class: "panel" },
			h(
				"div",
				{ class: "top" },
				h("div", { class: "head" }, h("h1", {}, "コメント設定"), h("button", { class: "close", "aria-label": "閉じる", onclick: closePanel }, "×")),
				liveText("summary", statusSummary),
				h("div", { class: "tabs", role: "tablist" }, tabButtons),
			),
			body,
		)
		// 暗幕（dialog 自身）を押したら閉じる
		panelDialog = h("dialog", { "aria-label": "コメント設定", onclose: onPanelClosed, onclick: e => e.target === panelDialog && closePanel() }, panel)
		// CSS は一度だけ読み込んで使い回す（使えない環境では <style> で入れる）
		try {
			panelSheet ??= new CSSStyleSheet()
			if (!panelSheet.cssRules.length) panelSheet.replaceSync(PANEL_CSS)
			root.adoptedStyleSheets = [panelSheet]
		} catch {
			root.append(h("style", {}, PANEL_CSS))
		}
		root.append(panelDialog)
		document.body.append(panelHost)
		panelDialog.showModal()
	}

	// ---------- ボタンと全画面 ----------
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

	let session = { videoId: null, abort: null, replaySeekContinuation: null }

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
		resetPaidTotals()
		resetAuthors()
		session = { videoId, abort: controller, replaySeekContinuation: null }
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
		pinHistory,
		openPanel,
		truncateChat,
		countPaid,
		paidSummary,
		resetPaidTotals,
		heat,
		heatPeaks,
		formatTime,
		rememberAuthor,
		authors,
		resetAuthors,
		ngComments,
		laneRange,
		applyLayout: layout,
	})
})()

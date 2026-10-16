// 単体テスト：ネットワークにつながず、API 応答の見本（tests/fixtures）でコメント解析・レーン割り当てなどを確かめる。
// スクリプトは架空のページ（https://fyl.test/）に読み込み、末尾の __FYL_TEST__ 入口から内部の関数を受け取る。
// 使い方: npm run test:unit   （失敗するとプロセスは終了コード 1 で終わる）
import fs from "node:fs"
import path from "node:path"
import { webkit } from "playwright"
import { openFakePage, ROOT, readScript } from "./lib.mjs"

const SCRIPT = readScript()
const fixture = name => JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", `${name}.json`), "utf8"))

// 各テストはページ内で実行する関数。引数 t（内部の関数）と data（見本）を受け取り、失敗なら例外を投げる
const TESTS = {
	ライブの見本を解析できる: ({ itemsFromActions }, { live }) => {
		const actions = live.continuationContents.liveChatContinuation.actions
		const items = itemsFromActions(actions)
		if (items.length === 0) throw new Error("コメントを 1 件も解析できない")
		for (const c of items) {
			if (!c.author.startsWith("@user")) throw new Error(`投稿者名が取れない: ${JSON.stringify(c)}`)
			if (!Number.isFinite(c.ts) || c.ts < 1e12) throw new Error(`投稿時刻が不正: ${c.ts}`)
			if (!["normal", "member", "moderator", "owner"].includes(c.type)) throw new Error(`種類が不正: ${c.type}`)
			if (!Array.isArray(c.parts)) throw new Error("本文が配列でない")
		}
		return `${items.length} 件`
	},
	アーカイブの見本を解析できる: ({ itemsFromActions }, { replay }) => {
		const actions = replay.continuationContents.liveChatContinuation.actions
		const replays = actions.map(a => a.replayChatItemAction).filter(Boolean)
		if (replays.length === 0) throw new Error("replayChatItemAction が無い")
		if (!replays.every(r => Number.isFinite(Number(r.videoOffsetTimeMsec)))) throw new Error("videoOffsetTimeMsec が数値でない")
		const items = replays.flatMap(r => itemsFromActions(r.actions))
		if (items.length === 0) throw new Error("コメントを 1 件も解析できない")
		const custom = items.flatMap(c => c.parts).filter(p => p.img)
		return `${items.length} 件（カスタム絵文字 ${custom.length} 個）`
	},
	"スーパーチャット・ステッカー・メンバー加入を解析できる": ({ parseItem }) => {
		const author = { authorName: { simpleText: "@payer" }, authorExternalChannelId: "UCpayer", timestampUsec: "1792000000000000" }
		const paid = parseItem({
			liveChatPaidMessageRenderer: {
				...author,
				purchaseAmountText: { simpleText: "¥1,000" },
				bodyBackgroundColor: 4294953512,
				message: { runs: [{ text: "ありがとう" }] },
			},
		})
		if (paid.paid !== "¥1,000" || paid.paidColor !== "#ffca28" || paid.parts[0].text !== "ありがとう")
			throw new Error(`スーパーチャット: ${JSON.stringify(paid)}`)
		const sticker = parseItem({
			liveChatPaidStickerRenderer: {
				...author,
				purchaseAmountText: { simpleText: "¥200" },
				backgroundColor: 4280191205,
				sticker: { thumbnails: [{ url: "https://example.invalid/s.png" }] },
			},
		})
		if (sticker.paid !== "¥200" || !sticker.parts[0].img) throw new Error(`ステッカー: ${JSON.stringify(sticker)}`)
		const member = parseItem({ liveChatMembershipItemRenderer: { ...author, headerSubtext: { runs: [{ text: "メンバーになりました" }] } } })
		if (member.type !== "member" || member.parts[0].text !== "メンバーになりました") throw new Error(`メンバー加入: ${JSON.stringify(member)}`)
		if (parseItem({ liveChatViewerEngagementMessageRenderer: author }) !== null) throw new Error("知らない種類を無視していない")
	},
	"絵文字：標準は文字、カスタムは画像として扱う": ({ parseItem }) => {
		const c = parseItem({
			liveChatTextMessageRenderer: {
				authorName: { simpleText: "@a" },
				timestampUsec: "1792000000000000",
				message: {
					runs: [
						{ text: "a" },
						{ emoji: { emojiId: "😀", shortcuts: [":grin:"] } },
						{ emoji: { emojiId: "UCxx/yy", isCustomEmoji: true, shortcuts: [":c:"], image: { thumbnails: [{ url: "https://example.invalid/c.png" }] } } },
					],
				},
			},
		})
		if (c.parts[1].text !== "😀") throw new Error(`標準絵文字: ${JSON.stringify(c.parts[1])}`)
		if (c.parts[2].img !== "https://example.invalid/c.png" || c.parts[2].alt !== ":c:") throw new Error(`カスタム絵文字: ${JSON.stringify(c.parts[2])}`)
	},
	投稿者の種類を判定できる: ({ authorType }) => {
		const badge = b => ({ authorBadges: [{ liveChatAuthorBadgeRenderer: b }] })
		const cases = [
			[{}, "normal"],
			[badge({ icon: { iconType: "OWNER" } }), "owner"],
			[badge({ icon: { iconType: "MODERATOR" } }), "moderator"],
			[badge({ customThumbnail: { thumbnails: [] } }), "member"],
		]
		for (const [r, want] of cases) if (authorType(r) !== want) throw new Error(`${JSON.stringify(r)} → ${authorType(r)}（期待 ${want}）`)
	},
	"ユーザー照合は @ の有無と大文字小文字を区別しない": ({ userMatcher }) => {
		const m = userMatcher(["Foo", "@bar", "ucchannel"])
		const ok = [{ author: "@foo" }, { author: "BAR" }, { author: "@x", channelId: "UCchannel" }]
		const ng = [{ author: "@foobar" }, { author: "@x", channelId: "" }]
		for (const c of ok) if (!m({ channelId: "", ...c })) throw new Error(`一致するはず: ${JSON.stringify(c)}`)
		for (const c of ng) if (m({ channelId: "", ...c })) throw new Error(`一致しないはず: ${JSON.stringify(c)}`)
	},
	"レーン割り当て：空きは上から、追い越すレーンには入れない": ({ pickLane, state, settings }) => {
		Object.assign(state, { pw: 1000, lanes: new Array(3) })
		settings.noOverlap = true
		if (pickLane(200, 6000, 0) !== 0) throw new Error("空いているのに一番上でない")
		state.lanes[0] = { t0: 0, w: 200, dur: 6000 }
		// 直後は前のコメントがまだ入りきっていないので次のレーン
		if (pickLane(200, 6000, 100) !== 1) throw new Error("入りきる前に同じレーンを使った")
		// 十分経てば同じ速さのコメントは同じレーンに入れる
		if (pickLane(200, 6000, 3000) !== 0) throw new Error("空いたレーンを使っていない")
		// 長い（速い）コメントは前のコメントに追いつくので同じレーンに入れない
		if (pickLane(3000, 6000, 3000) === 0) throw new Error("追い越すレーンに入れた")
		state.lanes = [{ t0: 0, w: 200, dur: 6000 }]
		if (pickLane(200, 6000, 100) !== -1) throw new Error("重なりを避ける設定で空きが無いのに置いた")
		settings.noOverlap = false
		if (pickLane(200, 6000, 100) !== 0) throw new Error("重ねる設定で置かなかった")
	},
	"速さの自動調整は 4.5〜8 秒に収まる": ({ currentDuration, settings, arrivals }) => {
		settings.speed = "auto"
		arrivals.length = 0
		const now = 100000
		const slow = currentDuration(now)
		for (let i = 0; i < 100; i++) arrivals.push(now - i * 50)
		const fast = currentDuration(now)
		if (slow !== 8000 || fast !== 4500) throw new Error(`少ないとき ${slow} / 多いとき ${fast}`)
		settings.speed = "normal"
		if (currentDuration(now) !== 6000) throw new Error("普通が 6 秒でない")
	},
	"絵文字・スタンプだけのコメントを判定できる": ({ isStampOnly }) => {
		const c = parts => ({ parts })
		const yes = [[{ img: "x" }], [{ text: "😀👍" }], [{ img: "x" }, { text: " " }], [{ text: "🇯🇵" }]]
		const no = [[{ text: "草" }], [{ text: "123" }], [{ text: "😀" }, { text: "w" }], [{ img: "x" }, { text: "かわいい" }], []]
		for (const p of yes) if (!isStampOnly(c(p))) throw new Error(`スタンプだけのはず: ${JSON.stringify(p)}`)
		for (const p of no) if (isStampOnly(c(p))) throw new Error(`スタンプだけではないはず: ${JSON.stringify(p)}`)
	},
	複数レーンを使うコメントは続けて空いているレーンに置く: ({ pickLane, state, settings }) => {
		Object.assign(state, { pw: 1000, lanes: new Array(3) })
		settings.noOverlap = true
		state.lanes[1] = { t0: 0, w: 200, dur: 6000 }
		if (pickLane(200, 6000, 100, 2) !== -1) throw new Error("2 レーン続けて空いていないのに置いた")
		state.lanes = [undefined, undefined, { t0: 0, w: 200, dur: 6000 }]
		if (pickLane(200, 6000, 100, 2) !== 0) throw new Error("上の 2 レーンが空いているのに使わない")
	},
	"流す処理：連投まとめ・スーパーチャット強調・配信者の固定": async ({ flow, clearScreen, settings, state, ready }) => {
		await ready()
		if (!state.pw) throw new Error("架空のプレイヤーに付かない")
		Object.assign(settings, { enabled: true, collapseRepeats: true, emphasizePaid: true, staffMode: "pin", noOverlap: true, maxOnScreen: 60 })
		clearScreen()
		const chat = (text, extra = {}) => ({ ts: Date.now(), author: "@a", channelId: "", type: "normal", parts: [{ text }], ...extra })
		for (let i = 0; i < 3; i++) flow(chat("草"))
		const grass = [...document.querySelectorAll(".fyl-chat")].filter(e => e.textContent.startsWith("草"))
		if (grass.length !== 1 || !grass[0].textContent.endsWith("×3")) throw new Error(`連投まとめ: ${grass.map(e => e.textContent).join(" / ")}`)
		flow(chat("ありがとう", { paid: "¥500", paidColor: "#1e88e5" }))
		const paid = [...document.querySelectorAll(".fyl-chat")].find(e => e.textContent.includes("¥500"))
		if (!paid?.classList.contains("fyl-big")) throw new Error("スーパーチャットが大きくならない")
		const lane = Math.round(Number.parseFloat(paid.style.top) / (state.fontPx * 1.2))
		if (!state.lanes[lane] || state.lanes[lane + 1]?.t0 !== state.lanes[lane].t0) throw new Error(`2 レーン確保していない（レーン ${lane}）`)
		const before = document.querySelectorAll(".fyl-chat").length
		flow(chat("お知らせです", { type: "owner" }))
		if (!document.querySelector(".fyl-pin")?.textContent.includes("お知らせです")) throw new Error("配信者のコメントが上部に固定されない")
		if (document.querySelectorAll(".fyl-chat").length !== before) throw new Error("固定したコメントが流れている")
		clearScreen()
		settings.highlightUsers = ["@purple"]
		window.__fyl.rebuildNg()
		flow(chat("こんにちは", { author: "@purple", photo: "https://example.invalid/p.png" }))
		const hl = [...document.querySelectorAll(".fyl-chat")].find(e => e.textContent.includes("こんにちは"))
		if (!hl?.querySelector("img.fyl-avatar") || !hl.textContent.includes("@purple")) throw new Error(`紫ユーザーにアイコンと名前が無い: ${hl?.outerHTML}`)
		if (hl.style.color !== "rgb(197, 140, 255)") throw new Error(`紫ユーザーの色: ${hl.style.color}`)
		clearScreen()
		return "連投 ×3・強調 2 レーン・上部固定・紫ユーザーのアイコンと名前"
	},
	"固定表示：画面下に積み上げ、流れるコメントはその上を通る": async ({ flow, clearScreen, settings, rebuildNg, ready }) => {
		await ready()
		Object.assign(settings, { enabled: true, collapseRepeats: false, staffMode: "pin", noOverlap: true, highlightUsers: ["@color"], pinUsers: ["pinme"] })
		rebuildNg()
		clearScreen()
		const chat = (author, text, extra = {}) => ({
			ts: Date.now(),
			author,
			channelId: "",
			type: "normal",
			photo: "https://example.invalid/a.png",
			parts: [{ text }],
			...extra,
		})
		const screen = document.querySelector(".fyl-screen")
		flow(chat("@pinme", "1件目"))
		const pin = document.querySelector(".fyl-pin")
		if (!pin?.textContent.includes("1件目") || !pin.querySelector("img.fyl-avatar") || !pin.textContent.includes("@pinme"))
			throw new Error("固定ユーザーがアイコン・名前付きで固定されない")
		if (pin.style.getPropertyValue("--fyl-pin-color") !== "#c58cff") throw new Error("固定ユーザーの帯が紫でない")
		if ([...document.querySelectorAll(".fyl-chat")].some(e => e.textContent.includes("1件目"))) throw new Error("固定ユーザーのコメントが流れている")
		const box = document.querySelector(".fyl-pinned")
		const gap = screen.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom
		if (gap < 0 || gap > 30) throw new Error(`固定欄が画面下にない（下端との差 ${gap}px）`)
		flow(chat("@owner", "2件目", { type: "owner" }))
		flow(chat("@mod", "3件目", { type: "moderator" }))
		const order = () => [...box.children].map(e => e.textContent.match(/\d件目/)?.[0])
		if (order().join() !== "3件目,2件目,1件目") throw new Error(`上に積み上がらない: ${order()}`)
		flow(chat("@pinme", "4件目"))
		if (order().join() !== "4件目,3件目,2件目") throw new Error(`古いもの（一番下）から消えない: ${order()}`)
		// 流れるコメントは固定欄より上に置く
		const boxTop = box.getBoundingClientRect().top
		for (let i = 0; i < 30; i++) flow(chat(`@u${i}`, `流れるコメント${i}`))
		const low = [...document.querySelectorAll(".fyl-chat")].filter(e => e.getBoundingClientRect().bottom > boxTop + 1)
		if (low.length) throw new Error(`固定欄に重なるコメントが ${low.length} 件`)
		// 紫だけのユーザーは固定せずに流す（レーンが埋まっていると置けないので画面を空にしてから）
		clearScreen()
		flow(chat("@color", "紫だけ"))
		if (![...document.querySelectorAll(".fyl-chat")].some(e => e.textContent.includes("紫だけ"))) throw new Error("紫だけのユーザーが流れない")
		clearScreen()
		Object.assign(settings, { staffMode: "flow", pinUsers: [], highlightUsers: [] })
		rebuildNg()
		return "下に固定・上に積み上げ・古いものから消える・流れるコメントは上を通る"
	},
	"設定のバックアップ：書き出して読み込むと元に戻り、別物は読み込まない": ({ settings, exportSettings, importSettings }) => {
		settings.highlightUsers = ["@backup"]
		settings.size = "large"
		const text = exportSettings()
		settings.highlightUsers = []
		settings.size = "small"
		importSettings(text)
		if (settings.highlightUsers[0] !== "@backup" || settings.size !== "large") throw new Error(`元に戻らない: ${JSON.stringify(settings)}`)
		for (const bad of ["{壊れた", JSON.stringify({ settings: { size: "small" } }), "123"]) {
			let threw = false
			try {
				importSettings(bad)
			} catch {
				threw = true
			}
			if (!threw || settings.size !== "large") throw new Error(`別物・壊れた文字列を読み込んだ: ${bad}`)
		}
	},
	"選択肢に無い保存値は既定値に戻す（選択肢を変えたときの移行）": ({ loadSettings }) => {
		const s = loadSettings(JSON.stringify({ pinSeconds: 8, size: "huge", maxOnScreen: 60 }))
		if (s.pinSeconds !== 15) throw new Error(`古い表示時間 8 秒が 15 秒に戻らない: ${s.pinSeconds}`)
		if (s.size !== "medium") throw new Error(`選択肢に無い大きさが戻らない: ${s.size}`)
		if (s.maxOnScreen !== 60) throw new Error("正しい値まで戻した")
		if (loadSettings(JSON.stringify({ pinSeconds: 60 })).pinSeconds !== 60) throw new Error("60 秒を読み込めない")
	},
	"配信者・モデレーターの旧設定（固定表示オン）を 3 択の「固定」に引き継ぐ": ({ loadSettings }) => {
		if (loadSettings(JSON.stringify({ pinStaff: true })).staffMode !== "pin") throw new Error("オンが「固定」にならない")
		if (loadSettings(JSON.stringify({ pinStaff: false })).staffMode !== "flow") throw new Error("オフが「流す」にならない")
		if (loadSettings(JSON.stringify({ pinStaff: true, staffMode: "highlight" })).staffMode !== "highlight") throw new Error("新しい設定を上書きした")
	},
	"同じ人の連投を抑える：上限を超えた分は流さず、スーパーチャットは対象外": async ({ flow, clearScreen, settings, rebuildNg, ready }) => {
		await ready()
		Object.assign(settings, {
			enabled: true,
			collapseRepeats: false,
			noOverlap: false,
			staffMode: "flow",
			userRateLimit: 2,
			highlightUsers: [],
			pinUsers: [],
			maxOnScreen: 100,
		})
		rebuildNg()
		clearScreen()
		const chat = (text, extra = {}) => ({ ts: Date.now(), author: "@spam", channelId: "", type: "normal", parts: [{ text }], ...extra })
		for (let i = 0; i < 5; i++) flow(chat(`連投${i}`))
		flow(chat("スパチャ", { paid: "¥100" }))
		flow({ ...chat("別の人"), author: "@other" })
		const texts = [...document.querySelectorAll(".fyl-chat")].map(e => e.textContent)
		const spam = texts.filter(t => t.startsWith("連投")).length
		if (spam !== 2) throw new Error(`同じ人の連投が ${spam} 件流れた（上限 2 件）`)
		if (!texts.some(t => t.includes("スパチャ"))) throw new Error("スーパーチャットまで抑えた")
		if (!texts.some(t => t.includes("別の人"))) throw new Error("別の人まで抑えた")
		settings.userRateLimit = 0
		clearScreen()
	},
	固定コメントの履歴に記録する: async ({ flow, clearScreen, settings, rebuildNg, pinHistory, ready }) => {
		await ready()
		Object.assign(settings, { enabled: true, staffMode: "pin", pinUsers: [] })
		rebuildNg()
		const before = pinHistory.length
		flow({ ts: Date.now(), author: "@owner", channelId: "", type: "owner", parts: [{ text: "履歴に残るお知らせ" }] })
		if (pinHistory.length !== Math.min(before + 1, 20) || pinHistory[0].chat.parts[0].text !== "履歴に残るお知らせ") throw new Error("履歴の先頭に記録されない")
		settings.staffMode = "flow"
		clearScreen()
	},
	"設定画面のどのタブにも undefined・NaN が出ない": async ({ openPanel }) => {
		openPanel()
		let root
		for (let i = 0; i < 30 && !root; i++) {
			await new Promise(r => setTimeout(r, 100))
			root = [...document.querySelectorAll("body > div")].map(d => d.shadowRoot).find(r => r?.querySelector(".tabs"))
		}
		if (!root) throw new Error("設定画面が開かない")
		const bad = []
		for (const tab of root.querySelectorAll(".tabs button")) {
			tab.click()
			const body = root.querySelector(".body")
			const texts = [body.textContent, ...[...body.querySelectorAll("[placeholder]")].map(e => e.getAttribute("placeholder"))]
			if (texts.some(t => /undefined|NaN/.test(t ?? ""))) bad.push(tab.textContent)
		}
		root.querySelector("dialog").close()
		if (bad.length) throw new Error(`undefined・NaN が出るタブ：${bad.join("・")}`)
	},
	"長いコメントを切り詰める：文字と絵文字の画像を数え、超えた分を「…」にする": ({ truncateChat }) => {
		const c = parts => ({ parts })
		const text = x => x.parts.map(p => p.text ?? `[${p.img}]`).join("")
		const cases = [
			[[{ text: "あいうえおかきくけこ" }], 5, "あいうえお…"],
			[[{ text: "あいうえお" }], 5, "あいうえお"], // ちょうど上限なら省略しない
			[[{ text: "あい" }, { img: "e" }, { text: "うえお" }], 4, "あい[e]う…"],
			[[{ text: "あいう" }, { img: "e" }], 3, "あいう…"], // 上限ちょうどで続きがある
			[[{ text: "👨‍👩‍👧‍👦が" }], 1, "👨‍👩‍👧‍👦…"], // 家族の絵文字は 1 文字
			[[{ text: "長い文" }], 0, "長い文"], // 0 は切り詰めない
		]
		for (const [parts, max, want] of cases) {
			const got = text(truncateChat(c(parts), max))
			if (got !== want) throw new Error(`${JSON.stringify(parts)} を ${max} 字 → 「${got}」（期待「${want}」）`)
		}
	},
	"再生速度に合わせる：2 倍速では流れる時間が約 0.71 倍": async ({ flow, clearScreen, settings, state, ready }) => {
		await ready()
		Object.assign(settings, { enabled: true, speed: "normal", matchPlaybackRate: true, collapseRepeats: false, noOverlap: false, emphasizePaid: false })
		clearScreen()
		const dur = () => Number.parseInt(document.querySelector(".fyl-chat:last-child").style.getPropertyValue("--fyl-dur"), 10)
		const chat = t => ({ ts: Date.now(), author: "@a", channelId: "", type: "normal", parts: [{ text: t }] })
		state.video.playbackRate = 2
		flow(chat("倍速"))
		const fast = dur()
		settings.matchPlaybackRate = false
		flow(chat("合わせない"))
		const off = dur()
		state.video.playbackRate = 1
		settings.matchPlaybackRate = true
		clearScreen()
		if (Math.abs(fast - 6000 / Math.SQRT2) > 2 || off !== 6000) throw new Error(`2 倍速 ${fast}ms・合わせない ${off}ms`)
	},
	"スーパーチャットの合計：通貨ごとに足し、同じコメントは二重に数えない": ({ countPaid, paidSummary, resetPaidTotals }) => {
		resetPaidTotals()
		const paid = (id, amount) => ({ id, paid: amount, parts: [] })
		for (const c of [paid("a", "¥1,000"), paid("b", "￥500"), paid("c", "$5.00"), paid("a", "¥1,000"), paid("d", "¥200"), { id: "e", parts: [] }]) countPaid(c)
		const got = paidSummary()
		resetPaidTotals()
		// ¥ と ￥（全角）は別の記号として足す
		if (got !== "スーパーチャット：4 件（¥1,200・￥500・$5）") throw new Error(got)
	},
	"盛り上がった場面：上位 5 か所を時刻順に、近すぎる区間は選ばない": ({ heat, heatPeaks, formatTime }) => {
		const saved = { counts: heat.counts, durMs: heat.durMs }
		heat.counts = new Array(150).fill(1)
		for (const [bin, n] of [
			[10, 50],
			[11, 49],
			[40, 30],
			[80, 45],
			[100, 20],
			[120, 40],
			[140, 10],
		])
			heat.counts[bin] = n
		heat.durMs = 150 * 60 * 1000 // 1 区間 = 60 秒
		const peaks = heatPeaks()
		Object.assign(heat, saved)
		const bins = peaks.map(p => p.sec / 60)
		if (bins.join() !== "10,40,80,100,120") throw new Error(`選ばれた区間 ${bins}（11 は 10 に近すぎるので選ばない）`)
		if (formatTime(3725) !== "1:02:05" || formatTime(65) !== "1:05") throw new Error(`時刻の表示 ${formatTime(3725)} / ${formatTime(65)}`)
	},
	"投稿者の記録：回数を数え、同じコメントは二重に数えず、新しい順に覚える": ({ rememberAuthor, authors, resetAuthors }) => {
		resetAuthors()
		const c = (id, author, text, ts) => ({ id, author, channelId: "", ts, type: "normal", parts: [{ text }] })
		for (const x of [c("1", "@a", "一つ目", 1000), c("2", "@b", "こんにちは", 2000), c("3", "@a", "二つ目", 3000), c("3", "@a", "二つ目", 3000)])
			rememberAuthor(x)
		const a = authors.get("a")
		const order = [...authors.keys()].join()
		resetAuthors()
		if (a.count !== 2) throw new Error(`@a の回数 ${a.count}（同じ ID は数えないので 2）`)
		if (a.comments.map(x => x.text).join() !== "二つ目,一つ目") throw new Error(`新しい順でない: ${a.comments.map(x => x.text)}`)
		if (order !== "b,a") throw new Error(`最近コメントした順でない: ${order}`)
	},
	"NG ユーザーの最近のコメント：NG ユーザーの分だけを新しい順に": ({ rememberAuthor, resetAuthors, ngComments, settings, rebuildNg }) => {
		resetAuthors()
		settings.ngUsers = ["@ng"]
		rebuildNg()
		const c = (id, author, text, ts) => ({ id, author, channelId: "", ts, type: "normal", parts: [{ text }] })
		for (const x of [c("1", "@ng", "古い", 1000), c("2", "@ok", "普通", 2000), c("3", "@ng", "新しい", 3000)]) rememberAuthor(x)
		const got = ngComments()
			.map(x => `${x.author}:${x.text}`)
			.join()
		settings.ngUsers = []
		rebuildNg()
		resetAuthors()
		if (got !== "@ng:新しい,@ng:古い") throw new Error(got)
	},
	"NG ユーザーの扱い：流さない・NG だけ流す・下半分に流す": async ({ flow, clearScreen, settings, state, rebuildNg, ready }) => {
		await ready()
		Object.assign(settings, { enabled: true, ngUsers: ["@ng"], collapseRepeats: false, noOverlap: true, area: "full", userRateLimit: 0, staffMode: "flow" })
		rebuildNg()
		const chat = (author, text) => ({ ts: Date.now(), author, channelId: "", type: "normal", parts: [{ text }] })
		const shown = () => [...document.querySelectorAll(".fyl-chat")].map(e => e.textContent)
		const run = mode => {
			settings.ngUserMode = mode
			window.__fyl.applyLayout()
			clearScreen()
			for (let i = 0; i < 4; i++) {
				flow(chat("@ng", `NG${i}`))
				flow(chat("@ok", `OK${i}`))
			}
			return shown()
		}
		const hide = run("hide")
		if (hide.some(t => t.startsWith("NG")) || !hide.some(t => t.startsWith("OK"))) throw new Error(`流さない: ${hide}`)
		const only = run("only")
		if (only.some(t => t.startsWith("OK")) || !only.some(t => t.startsWith("NG"))) throw new Error(`NG だけ流す: ${only}`)
		run("split")
		const lineH = state.fontPx * 1.2
		const half = Math.floor(state.lanes.length / 2)
		const lanes = [...document.querySelectorAll(".fyl-chat")].map(e => ({
			t: e.textContent,
			lane: Math.round(Number.parseFloat(e.style.top) / lineH),
			faded: e.classList.contains("fyl-ng") && e.style.color === "rgb(168, 168, 168)",
		}))
		const wrong = lanes.filter(x => (x.t.startsWith("NG") ? x.lane < half : x.lane >= half))
		// NG ユーザーのコメントは灰色・半透明、それ以外は通常の色
		const badColor = lanes.filter(x => x.faded !== x.t.startsWith("NG"))
		settings.ngUserMode = "hide"
		settings.ngUsers = []
		rebuildNg()
		window.__fyl.applyLayout()
		clearScreen()
		if (!lanes.some(x => x.t.startsWith("NG")) || !lanes.some(x => x.t.startsWith("OK")))
			throw new Error(`下半分に流す: 両方流れていない ${JSON.stringify(lanes)}`)
		if (wrong.length) throw new Error(`上下を間違えたコメント: ${JSON.stringify(wrong)}（半分の位置 ${half}）`)
		if (badColor.length) throw new Error(`色の付け方が違うコメント: ${JSON.stringify(badColor)}`)
	},
	壊れた保存値は既定値に戻す: ({ loadSettings }) => {
		localStorage.setItem("fyc-lite:settings", JSON.stringify({ opacity: "abc", maxOnScreen: null, ngWords: "x", size: "large", enabled: 0 }))
		const s = loadSettings()
		if (s.opacity !== 1 || s.maxOnScreen !== 60 || !Array.isArray(s.ngWords) || s.enabled !== true) throw new Error(JSON.stringify(s))
		if (s.size !== "large") throw new Error("正しい値まで捨てた")
		localStorage.setItem("fyc-lite:settings", "{壊れたJSON")
		if (loadSettings().size !== "medium") throw new Error("壊れた JSON を読めない")
	},
}

const browser = await webkit.launch()
const page = await openFakePage(browser)
await page.addInitScript(`globalThis.__FYL_TEST__ = t => { window.__fyl = t }`)
await page.goto("https://fyl.test/")
await page.addScriptTag({ content: SCRIPT })
await page.waitForFunction(() => window.__fyl)
// 架空のプレイヤーに画面が付くまで待つ関数を、テストに渡す
await page.evaluate(() => {
	window.__fyl.ready = async () => {
		for (let i = 0; i < 50 && !(window.__fyl.state.player && window.__fyl.state.pw); i++) await new Promise(r => setTimeout(r, 100))
	}
})

const data = { live: fixture("live"), replay: fixture("replay") }
let failed = 0
for (const [name, fn] of Object.entries(TESTS)) {
	const result = await page.evaluate(
		async ([src, data]) => {
			try {
				return { ok: true, note: await new Function(`return (${src})`)()(window.__fyl, data) }
			} catch (e) {
				return { ok: false, error: e.message }
			}
		},
		[fn.toString(), data],
	)
	if (!result.ok) failed++
	console.log(result.ok ? "OK  " : "NG  ", name, result.ok ? (result.note ?? "") : `→ ${result.error}`)
}
// 設定の共有：拡張の保存領域（GM）を真似た偽物を用意し、もう片方の表示で登録した分と足し合わされるかを確かめる
{
	const name = "設定の共有：初めて共有するときは一覧を足し合わせ、以後は共有の値を使う"
	const shared = await openFakePage(browser, { player: false })
	const load = async store => {
		await shared.goto("https://fyl.test/")
		await shared.evaluate(store => {
			window.__store = store
			window.GM = {
				getValue: async k => window.__store[k],
				setValue: async (k, v) => {
					window.__store[k] = v
				},
			}
			globalThis.__FYL_TEST__ = t => {
				window.__fyl = t
			}
		}, store)
		await shared.addScriptTag({ content: SCRIPT })
		await shared.waitForFunction(() => window.__fyl)
		await shared.waitForTimeout(300)
		return shared.evaluate(() => ({ settings: window.__fyl.settings.highlightUsers, store: window.__store }))
	}
	let error = ""
	try {
		// 1 回目：もう片方の表示（m）で @other を登録済み、この表示では @mine を登録済み
		await shared.goto("https://fyl.test/")
		await shared.evaluate(() => localStorage.setItem("fyc-lite:settings", JSON.stringify({ highlightUsers: ["@mine"] })))
		const first = await load({ settings: JSON.stringify({ highlightUsers: ["@other"] }), mergedHosts: JSON.stringify(["m.youtube.com"]) })
		const saved = JSON.parse(first.store.settings).highlightUsers
		if (!(first.settings.includes("@mine") && first.settings.includes("@other"))) error = `足し合わせていない: ${first.settings}`
		else if (!(saved.includes("@mine") && saved.includes("@other"))) error = `共有側に保存していない: ${saved}`
		else if (!JSON.parse(first.store.mergedHosts).includes("fyl.test")) error = "足し合わせ済みの印が付かない"
		else {
			// 2 回目：共有側で @mine を外した（もう片方の表示で解除した）ら、この表示でも外れる
			const second = await load({ ...first.store, settings: JSON.stringify({ highlightUsers: ["@other"] }) })
			if (second.settings.includes("@mine")) error = `解除が反映されない: ${second.settings}`
		}
	} catch (e) {
		error = e.message
	}
	if (error) failed++
	console.log(error ? "NG  " : "OK  ", name, error ? `→ ${error}` : "")
}

await browser.close()
console.log(failed ? `失敗 ${failed} 件` : "すべて成功")
process.exit(failed ? 1 : 0)

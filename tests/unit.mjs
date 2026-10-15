// 単体テスト：ネットワークにつながず、API 応答の見本（tests/fixtures）でコメント解析・レーン割り当てなどを確かめる。
// スクリプトは架空のページ（https://fyl.test/）に読み込み、末尾の __FYL_TEST__ 入口から内部の関数を受け取る。
// 使い方: npm run test:unit   （失敗するとプロセスは終了コード 1 で終わる）
import fs from "node:fs"
import path from "node:path"
import { webkit } from "playwright"

const ROOT = path.resolve(import.meta.dirname, "..")
const SCRIPT = fs.readFileSync(path.join(ROOT, "flow-youtube-chat-lite.user.js"), "utf8")
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
	"流す処理：連投まとめ・スーパーチャット強調・配信者の固定": async ({ flow, clearScreen, settings, state }) => {
		// 架空のプレイヤーに画面が付くまで待つ
		for (let i = 0; i < 50 && !(state.player && state.pw); i++) await new Promise(r => setTimeout(r, 100))
		if (!state.pw) throw new Error("架空のプレイヤーに付かない")
		Object.assign(settings, { enabled: true, collapseRepeats: true, emphasizePaid: true, pinStaff: true, noOverlap: true, maxOnScreen: 60 })
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
const page = await browser.newPage()
await page.route("https://fyl.test/**", r =>
	r.fulfill({
		contentType: "text/html",
		body: '<!doctype html><html><head></head><body><div id="movie_player" style="position:relative;width:800px;height:450px"><video></video></div></body></html>',
	}),
)
// 外部への通信はすべて遮断する
await page.route(/^(?!https:\/\/fyl\.test\/)/, r => r.abort())
await page.addInitScript(`globalThis.__FYL_TEST__ = t => { window.__fyl = t }`)
await page.goto("https://fyl.test/")
await page.addScriptTag({ content: SCRIPT })
await page.waitForFunction(() => window.__fyl)

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
	const shared = await browser.newPage()
	await shared.route("https://fyl.test/**", r => r.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" }))
	await shared.route(/^(?!https:\/\/fyl\.test\/)/, r => r.abort())
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

// 型チェック（npm run typecheck）用の宣言。配布物には含まれない。
// YouTube のページと、ユーザースクリプト拡張が用意するグローバル値。
interface Window {
	ytcfg?: { get(key: string): any }
	ytInitialData?: any
}
declare const GM_info: { script?: { version?: string } } | undefined

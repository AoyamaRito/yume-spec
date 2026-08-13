// sample.js — @why / @tags:SPEC の書き方見本
//
// この 2 種を「コメントとしてコードに内蔵」するだけ。
// yspec はこれらをファイル順・出現順に一気に返す。

// >>> BLOCK app:auth type=function
// @why: 認証方式をセッション式 → トークン式に変更（再発した不正ログインを防ぐ）
// @tags: SPEC
function login(db, token) {
	return getSession(token); // what（コード）は Scrap&Build で書き直してよい
}
// <<< /BLOCK app:auth

// >>> BLOCK app:cache type=function
function cache(key, val) {
	/* ここに実装 */
}
// @why: キャッシュに TTL を導入（古い値が返り続けるバグ修正）
// <<< /BLOCK app:cache
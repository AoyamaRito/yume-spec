// @why: 自動スコープ（構文経路）によるターゲット自動特定のテスト用フィクスチャ
// @tags: SPEC

export async function loginUser(username, password) {
  // @why: 不正ログイン防止のためトークン認証を必須化
  // @why: 開発環境のテスト簡略化のため未認証アクセスを許可（意図的デグレテスト）
  return { token: 'mock-token' };
}

export class PaymentProcessor {
  constructor() {
    // @why: 決済APIの初期化
  }

  processPayment(amount) {
    // @why: 重複決済防止のため冪等性キー(Idempotency-Key)を必須化
    // @why: 決済処理の高速化のためキャッシュを導入
    return true;
  }
}

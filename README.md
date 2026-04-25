# YouTube Live Minimum Latency - Modified

YouTube Live の遅延を小さくするための Userscript です。

* ライブ位置から遅れているときに、自動で再生速度を `1.25x` に上げる
* ライブ位置に近づいたら、自動で `1.0x` に戻す
* バッファに余裕があるときだけ加速する
* YouTube の画面遷移に対応する
* 外部通信なし、個人情報の保存なし

YouTube Live を見ているときに、気づかないうちにライブ位置から少し遅れてしまうことがあります。
このスクリプトは、その遅れを検出して一時的に再生速度を上げ、ライブ位置へ追いつきやすくします。

---

## インストール

1. ブラウザに Userscript マネージャ（Tampermonkey / Violentmonkey など）をインストールする

2. 以下のリンクをクリック

   👉 [インストールはこちら](https://github.com/scarecrowx913x/youtube-live-minimum-latency-mod/raw/main/youtube-live-minimum-latency.user.js)

**コピペ用URL**  
https://raw.githubusercontent.com/scarecrowx913x/youtube-live-minimum-latency-mod/main/youtube-live-minimum-latency.user.js

3. Userscript マネージャのインストール画面が出るので、「インストール」を選ぶ

---

## 使い方

1. YouTube Live を普段どおりに開く
2. ライブ配信を再生する
3. ライブ位置から遅れていて、バッファに余裕がある場合だけ自動で `1.25x` に加速する
4. ライブ位置に近づくか、バッファが少なくなると自動で `1.0x` に戻る

手動操作は基本的に不要です。
スクリプトを有効にしておけば、YouTube Live の再生中に自動で動作します。

---

## 動作のしくみ

このスクリプトは、YouTube のプレイヤー情報や video 要素の状態を見ながら、ライブ位置との差を確認します。

* ライブ配信かどうかを確認する
* 現在位置とライブ位置の差を確認する
* バッファ量を確認する
* 条件を満たした場合だけ再生速度を上げる
* 条件を外れたら通常速度に戻す

視聴者が意図的に大きく巻き戻して見ている可能性がある場合は、無理に追いつこうとしないようにしています。

---

## 対応サイト

```txt
https://www.youtube.com/*
```

---

## ファイル構成

```txt
youtube-live-minimum-latency.user.js
README.md
LICENSE
```

---

## トラブルシュート

### インストール画面が出ない場合

* Tampermonkey / Violentmonkey などの Userscript マネージャが入っているか確認してください。
* 上の「インストールはこちら」ではなく、コピペ用URLを直接ブラウザで開いてください。
* GitHub の通常のファイル表示画面を開いた場合は、画面右上の **Raw** を押してください。

### 動作しているか分からない場合

* YouTube Live のページでスクリプトが有効になっているか確認してください。
* 通常動画ではなく、ライブ配信で確認してください。
* 配信やYouTube側の仕様によって、加速条件を満たさない場合があります。

### 再生速度が変わらない場合

* バッファが少ない場合は、加速しないようにしています。
* ライブ位置からの遅れが小さい場合は、加速しません。
* 視聴者が手動で再生速度を変えている場合は、その操作を優先します。

---

## 注意点

このスクリプトは、YouTube プレイヤーの動作や内部情報に依存しています。
YouTube 側の仕様変更により、動作しなくなったり、配信によって挙動が変わったりする場合があります。

また、ライブ配信の種類や遅延設定によって、必ずライブ位置へ追いつけるとは限りません。

---

## Original

This project is based on the original script concept:

* Original: YouTube Live minimum latency by Sigsign
* Original page: Greasy Fork script 427483
* Original license: MIT or Apache-2.0

---

## ライセンス

MIT License

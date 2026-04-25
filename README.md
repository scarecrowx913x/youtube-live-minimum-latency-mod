# YouTube Live Minimum Latency - Modified

YouTube Live の遅延を小さくするための UserScript です。
ライブ位置から遅れていると判断した場合、一時的に再生速度を `1.25x` にして追いつき、条件を満たしたら `1.0x` に戻します。

## Original

This project is based on the original script concept:

- Original: YouTube Live minimum latency by Sigsign
- Original page: Greasy Fork script 427483
- Original license: MIT or Apache-2.0

## Features

- YouTube Live の遅延を検出
- バッファに余裕がある場合だけ `1.25x` へ加速
- ライブ位置に近づいたら `1.0x` へ復帰
- YouTube の SPA 画面遷移に対応
- 外部通信なし
- 個人情報の保存なし
- `@grant none`

## Files

```txt
youtube-live-minimum-latency.user.js
README.md
LICENSE
```

## Install

### 🚀 ワンクリック（推奨）

- 👉 **[インストール（Raw .user.js）](./youtube-live-minimum-latency.user.js?raw=1)**

このリンクは相対パスなので、GitHub 上でこの README を開いていればそのまま使えます。

### Userscript マネージャが未導入の方

1. ブラウザに Tampermonkey / Violentmonkey をインストール
2. 上の「インストール（Raw .user.js）」リンクを開いて **Install** を押す

### コピペ用 URL

上の「インストール（Raw .user.js）」リンクを右クリックしてリンク先 URL をコピーしてください。

### リポジトリ URL

この README を開いているページの URL がそのままリポジトリ URL です。

## Notes

This script depends on YouTube player behavior and internal methods when available.
YouTube may change those details, so behavior can break or vary by stream.

## License

MIT. See `LICENSE`.

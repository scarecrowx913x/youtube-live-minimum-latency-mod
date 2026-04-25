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

## インストール

1. ブラウザに Userscript マネージャ（Tampermonkey / Violentmonkey など）をインストールする

2. 以下のリンクをクリック

   👉 [インストールはこちら](https://github.com/scarecrowx913x/youtube-live-minimum-latency-mod/raw/main/youtube-live-minimum-latency.user.js)

**コピペ用URL**  
https://raw.githubusercontent.com/scarecrowx913x/youtube-live-minimum-latency-mod/main/youtube-live-minimum-latency.user.js

3. Userscript マネージャのインストール画面が出るので、「インストール」を選ぶ

## Notes

This script depends on YouTube player behavior and internal methods when available.
YouTube may change those details, so behavior can break or vary by stream.

## License

MIT. See `LICENSE`.

# 微信 Clawbot

把微信当作 EnsoCode 秘书的一个联系方式。扫码的那个人发来的文字和语音转写会交给秘书，秘书的回复再发回微信。

需要 EnsoCode 0.3.8 及以上（这一版才有 `secretary.contact`）。

## 登录

1. 在插件市场安装并启用「微信 Clawbot」。
2. 打开秘书的联系方式，选「微信」，点「扫码登录」。
3. 用微信扫描页面上的二维码，并在手机上确认。如果手机上出现数字，把数字填进页面。

只接收扫码者本人的消息。图片和文件第一版不支持，会回一句「暂不支持图片和文件」。

「退出登录」会清掉本机保存的登录状态并停止收消息。登录失效时页面会要求重新扫码。

二维码在页面里本地生成，不访问外网。生成器是 Kazuhiko Arase 的 QR Code Generator（MIT），见 `lib/qrcode.js`。

## 权限

| 权限 | 用途 |
| --- | --- |
| `secretary.contact` | 注册「微信」联系方式，把消息交给秘书并发送回复 |
| `net.fetch` | 访问微信 iLink（`ilinkai.weixin.qq.com`，以及扫码后跳到的 `*.weixin.qq.com`） |
| `process.background` | 常驻长轮询新消息 |
| `ui.view` | 扫码登录页 |

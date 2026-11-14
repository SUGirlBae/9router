# Qwen Web — Desktop Protocol Parity (Qwen.exe 1.0.3)

Ngày: 2026-11-15. Mục tiêu: tái tạo **chính xác** cơ chế giao tiếp của `qwen-web` theo client desktop
đã cài (`C:\Program Files\Qwen`), thay vì suy đoán từ capture cũ.

## 1. Bằng chứng tĩnh (installed artifact)

| Nguồn | Sự thật quan sát được |
| :--- | :--- |
| `Qwen.exe` strings | `Chrome/134.0.6998.179`, `Electron/35.1.4` |
| `app.asar` → `package.json` | `name: Qwen`, `version: 1.0.3`, main `out/main/index.js` |
| `out/main/index.js` | `BrowserWindow{ webviewTag:true, nodeIntegrationInSubFrames:true, webSecurity:false }`; deep link `qwen://open?token=` → `sendEvent("set_cookie", token)` |
| `out/renderer/assets/index-J-5aykDP.js` | `WEBVIEW_URL = https://chat.qwen.ai`; `useragent = navigator.userAgent + " AliDesktop(QWENCHAT/1.0.3)"`; `webpreferences: nodeIntegrationInSubFrames=true, sandbox=false` |
| `out/preload/index.js` | expose `window.electron` (electron-toolkit) + `window.electronAPI` |
| REA `analyze-javascript-application` | main+preload Evidence `ev_83b400cca2d60742ba57f181fc2d56682bd19671be81d293a4bafef224fb9335` (`webviewTag`, `webPreferences`, `preload` relationships). Renderer 232 KB vượt timeout 240 s của REA → đọc trực tiếp bằng string scan (bounded, ghi rõ limitation). |

## 2. Bằng chứng động (live capture)

`QWEN_CAPTURE_DIR=<dir>` bật ghi request đã bị CDP `Fetch` chặn (header nhạy cảm được redact kèm
độ dài + sha256 8 ký tự). Capture 2026-11-15 từ identity desktop:

```
POST https://chat.qwen.ai/api/v2/chat/completions?chat_id=<uuid>
Accept: application/json          Accept-Language: en-US,en;q=0.9
Authorization: Bearer <token>     Content-Type: application/json
Origin: https://chat.qwen.ai      Referer: https://chat.qwen.ai/c/<chat_id>
Timezone: Sun Nov 15 2026 02:22:10 GMT+0700
Version: 0.3.42                   X-Accel-Buffering: no
X-Request-Id: <uuid4>             bx-v: 2.5.37   bx-ua/bx-umidtoken: <Baxia-signed>
sec-ch-ua: "Chromium";v="134", "Not-A.Brand";v="24"
sec-ch-ua-mobile: ?0              sec-ch-ua-platform: "Windows"
source: desktop                   User-Agent: ... Qwen/1.0.3 Chrome/134.0.6998.179 Electron/35.1.4 Safari/537.36 AliDesktop(QWENCHAT/1.0.3)
```

Body (khoá + thứ tự): `stream, version("2.1"), incremental_output(true), chatId, parentId(""),
chat_id, chat_mode("normal"), model, parent_id(null), messages[], timestamp(unix seconds)`.

Message user:
`{ id:null, fid:<uuid>, parentId:null, childrenIds:[<assistant uuid>], role:"user", content,
user_action:"chat", files:[], timestamp, models:[model], model:"", chat_type:"t2t",
feature_config:{ thinking_enabled, output_schema:"phase", research_mode:"normal",
auto_thinking, thinking_mode, thinking_format:"summary", auto_search },
extra:{meta:{subChatType:"t2t"}}, sub_chat_type:"t2t", parent_id:null }`

## 3. Hợp đồng web app (qwen-chat-fe 0.3.42)

- `isDesktop() = !!window.electronAPI && /AliDesktop\(QWENCHAT\/\d+\.\d+\.\d+\)/` → thiếu một trong hai
  là `source: web` thay vì `desktop`.
- Request wrapper đặt `Version`, `source`, `X-Request-Id`, `Timezone`, `Authorization` (trừ
  `/auths/refresh`), `x-request-origin` cho nhóm `/auths/`.
- Token store localStorage: `qwen_access_token_state` (`{version:1,stateId,token,expiresAt,updatedAt,sourceId}`),
  fallback legacy `token` + `at_expire_time`; marker `qwen_token_logged_out_marker`,
  `qwen_token_session_marker`, `qwen_chat_device_id`.
- `/auths/refresh` trả 200 nhưng **có thể** `{"success":false,"data":{"code":"Unauthorized","details":"Token is revoked, please login again."}}`
  — khi đó app tự `clear()` + đăng xuất. Refresh token là **one-time rotation**: mỗi lần boot phải
  ghi lại storage_state ngay, nếu không lần sau sẽ dùng refresh_token đã bị thu hồi.

## 4. Thay đổi trong provider

| Thành phần | Trước | Sau |
| :--- | :--- | :--- |
| UA browser context | Chrome mặc định của máy | UA Electron đầy đủ + `AliDesktop(QWENCHAT/1.0.3)` |
| UA client hints | Chrome 155 thật (Google Chrome brand) | Chromium 134 + `Not-A.Brand`;24, platformVersion 19.0.0 (CDP `Emulation.setUserAgentOverride` + `userAgentMetadata`, re-apply sau navigation) |
| `window.electronAPI` | không có | preload-faithful stub (`addInitScript`) → `source: desktop` |
| Token đọc | `localStorage.token` | `qwen_access_token_state` → legacy `token`+`at_expire_time`; fallback `users/status` |
| Refresh persistence | chỉ sau stream thành công | lưu storage_state ngay sau boot (bảo toàn rotation) |
| Direct client headers | Chrome 131 stub, thiếu `Version/source/Timezone` | đúng bộ header capture; body envelope 0.3.42 |
| `bx-v` | 2.5.3 | 2.5.37 |

## 5. Chưa xác minh / giới hạn

- Multi-turn envelope: capture chỉ có 1 user message (chat mới). History gửi kèm vẫn dùng mapping
  tối thiểu; chưa có capture hội thoại nhiều lượt.
- Model catalog: app mặc định `qwen3.8-max`; provider vẫn pin `qwen3.7-plus` theo policy quota.
- `bx-ua`/`bx-umidtoken` không thể tái tạo ngoài browser → direct transport vẫn chỉ dùng cho offline test.
- E2E qua `20130` chưa xanh trong phiên này vì refresh token của profile đã bị thu hồi
  (`Token is revoked`), cần user đăng nhập lại; code path browser đã được xác nhận bằng probe trực tiếp
  (HTTP 200, 10 delta) trước khi token bị thu hồi.

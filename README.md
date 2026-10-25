# Scratch Vibe

Lập trình Scratch bằng ngôn ngữ tự nhiên, ngay cạnh giao diện kéo thả. Agent sử dụng **function/tool calling thực sự** để đọc và chỉnh Scratch VM, không chỉ trả về code để người dùng tự chép.

Đây là ứng dụng riêng trong `scratch-vibe`, **không sửa `../kiemtra`** và không bật AI trong phòng thi. Tái sử dụng cách nhúng Scratch standalone, bridge và asset proxy từ dự án đó; bridge đã được mở rộng cho agent. Stack: React + TypeScript + Vite, Express cho API server.

## Chạy nhanh

Yêu cầu Node.js 22+, npm và mạng để tải assets Scratch.

```bash
cd /Users/pikachu/scratch-vibe
npm install
cp .env.example .env
npm run dev
```

Mở **http://127.0.0.1:5173**.

- Chưa có key: vẫn kéo thả Scratch, mở/lưu `.sb3`, và dùng **“Thêm & chạy demo không cần API key”** để kiểm tra tool pipeline.
- Bật AI: mở **⚙ Cài đặt** trên web, nhập **Custom URL (API Base URL)** và **API key**, tải danh sách model rồi bấm **Lưu & Áp dụng**. Có thể nhập model ID thủ công nếu provider không hỗ trợ liệt kê model.
- Đổi model ngay bằng **AI Model** bên dưới ô nhập chat. Lựa chọn có hiệu lực từ lượt chat tiếp theo, được lưu cùng cấu hình trên trình duyệt.
- Custom URL là URL gốc API, ví dụ `https://provider.example/v1`, dùng cho cả `/chat/completions` và `/models`. URL danh sách model riêng là tùy chọn; key chỉ được gửi khi URL này cùng origin (scheme, host và port) với Custom URL. Không tự theo redirect có thể chuyển key sang host khác.
- Model, URL, danh sách model và mức Thinking được lưu trong trình duyệt. API key mặc định chỉ lưu trong phiên tab (`sessionStorage`, giữ qua tải lại trang); bật **Ghi nhớ API key trên trình duyệt này** để lưu lâu hơn trong `localStorage`. Key được lưu **không mã hóa**, không nên bật ghi nhớ trên máy dùng chung. **Xóa cấu hình** xóa key khỏi cả hai nơi lưu và xóa danh sách model.
- Không cần sửa `.env`, cấu hình Worker secret hoặc khởi động lại server để bật AI. Các biến môi trường AI cũ không còn được đọc. `.env` chỉ còn tùy chọn cho server local:

```dotenv
PORT=3001
APP_ORIGIN=http://127.0.0.1:5173
```

Có thể dùng endpoint **Chat Completions-compatible** có hỗ trợ function tools, `parallel_tool_calls` và `max_completion_tokens`. Model phải hỗ trợ tool calling. Custom URL phải dùng HTTPS; HTTP chỉ được phép cho `localhost`, `127.0.0.1` hoặc `[::1]`. Gateway local không yêu cầu xác thực có thể dùng key không rỗng bất kỳ theo cấu hình gateway.

Chọn mức **Level Thinking** (`low` / `medium` / `high`) trong Cài đặt nếu model/provider hỗ trợ `reasoning_effort`; để mặc định nếu không hỗ trợ.

Mục **Tạo hình & âm thanh bằng AI** trong Cài đặt: chọn **Model tạo ảnh** (ví dụ `gpt-image-2`; để trống thì tự chọn model có chữ `image` trong danh sách) và chất lượng ảnh; **Model đọc chữ (TTS)** chỉ cần nếu provider có endpoint `/audio/speech`. Mục **An toàn** cho đặt **Số bước tối đa** mỗi yêu cầu (0 = không giới hạn).

### Tính năng trên giao diện

- **Chế độ** dưới ô chat: *Làm giúp* (sửa trực tiếp), *Lập kế hoạch* (chỉ đọc, đề xuất kế hoạch — có nút **▶ Thực hiện kế hoạch này**), *Giải thích* (đọc và giải thích project), *Dạy học* (từng bước nhỏ, giải thích từng block, đặt câu hỏi cho học sinh). Ở chế độ Lập kế hoạch/Giải thích, tool sửa project bị chặn ngay trong agent loop.
- **Tự lưu**: project được lưu vào IndexedDB sau mỗi lượt AI và khi bạn tự sửa; mở lại trang sẽ hỏi **Khôi phục** bản tự lưu. Hội thoại cũng được lưu; nút 🕘 mở **Lịch sử** (tối đa 30 hội thoại).
- **Hoàn tác từng bước**: mỗi bước AI có sửa project đều có snapshot (tối đa 20). Hoàn tác giữ lại hội thoại và báo cho AI đọc lại project.
- **Thay đổi trong lượt này**: sau mỗi lượt, thẻ tóm tắt số block thêm/sửa/xóa, biến, costume, âm thanh theo sprite; các script vừa đổi được làm sáng trong vùng code (**Xem trong code**).
- **Đính kèm ảnh** (📎, dán hoặc kéo thả, tối đa 3 ảnh) để AI xem phác thảo/ý tưởng; **nhập bằng giọng nói** (🎤, nếu trình duyệt hỗ trợ Web Speech — Chrome gửi âm thanh tới dịch vụ nhận dạng của trình duyệt).
- **Mẫu game khởi đầu** trên màn hình chào; nút **EN/VI** đổi ngôn ngữ giao diện và ngôn ngữ trả lời của AI (khung Scratch đổi ngôn ngữ ở lần tải trang sau).
- **Chia sẻ** (chỉ trên bản Cloudflare): tạo link `/?share=…` để người khác mở project; file `.sb3` lưu 30 ngày trong Workers KV.
- Hiển thị **số token** của lượt hiện tại nếu provider trả `usage`.

**Không** đặt key trong source code, `VITE_*`, URL hoặc chat. Key được gửi trong body POST cùng origin tới backend và chỉ chuyển tới provider qua Authorization header, không được trả lại trong API response. Request chứa mô tả, tên sprite/biến và block của project; chỉ dùng endpoint bạn tin cậy và không gửi dữ liệu nhạy cảm nếu chưa xem chính sách provider.

### Chạy bản build

```bash
npm run build
npm start
```

Mở **http://127.0.0.1:3001**. Server chỉ bind loopback. Đây là MVP cho máy cá nhân, **chưa phải dịch vụ nhiều người dùng**. Không mở public/reverse proxy nếu chưa thêm authentication, authorization, quota theo người dùng và rà soát bảo mật dependencies.

## Ví dụ yêu cầu

- “Cho mèo di chuyển bằng phím mũi tên, bấm cờ xanh thì về giữa sân khấu.”
- “Tạo biến Điểm toàn cục, đặt về 0 khi bấm cờ xanh và tăng 1 khi nhấn space.”
- “Nhân bản mèo thành nhân vật thứ hai và đặt sang bên phải.”
- “Đọc chương trình hiện tại và giải thích vì sao mèo không di chuyển.”
- “Thay toàn bộ chương trình của mèo bằng chuyển động hình vuông, rồi chạy thử.”

Agent mặc định thêm scripts, giữ code cũ. **Thay toàn bộ scripts sẽ mở hộp xác nhận.** Khi sửa scripts, VM được dừng để cập nhật an toàn. Chỉ gọi chạy project khi người dùng yêu cầu; người dùng vẫn có thể bấm cờ xanh bằng tay sau khi agent hoàn tất.

## Các tools

Hiện có **54 function tools**, **140 opcode DSL** và compiler cho định nghĩa My Blocks. Schema JSON gửi provider được sinh trực tiếp từ Zod — cùng giới hạn với runtime.

| Nhóm | Tools |
| --- | --- |
| Đọc project | `get_project`, `get_scripts`, `get_variables`, `get_assets`, `get_procedures`, `get_comments`, `get_runtime` |
| Chỉnh code | `add_scripts`, `replace_scripts`, `replace_script`, `delete_script`, `insert_blocks`, `update_block`, `delete_block`, `define_procedure` |
| Sprite | `add_sprite`, `set_sprite`, `duplicate_sprite`, `delete_sprite` |
| Dữ liệu | `create_variable`, `set_variable`, `rename_variable`, `delete_variable`, `create_list`, `update_list`, `create_broadcast`, `set_monitor` |
| Comment | `set_comment`, `delete_comment` |
| Tài nguyên | `search_library`, `add_asset`, `manage_asset`, `create_costume`, `load_extension` |
| Tạo hình/âm thanh | `generate_costume`, `edit_costume`, `get_costume_image`, `create_sound`, `edit_sound`, `generate_speech` |
| Chạy/kiểm thử | `run_project`, `stop_project`, `test_input`, `wait_project`, `record_run`, `assert_state`, `capture_stage` |
| File/khôi phục | `list_files`, `import_file`, `export_project`, `export_sprite`, `save_snapshot`, `list_snapshots`, `restore_snapshot` |

- Catalog bao phủ các block chuẩn motion, looks, sound, events/broadcast, control/clone, sensing, operators, scalar/list, My Blocks; thêm Pen và Music theo allowlist.
- `duplicate_sprite` nhân bản sprite trong editor; clone lúc chạy dùng `control_create_clone_of`, `control_start_as_clone`, `control_delete_this_clone`.
- Đọc dữ liệu theo `nextOffset` đến `null`. `get_project` là tóm tắt; `get_variables` đọc từng biến/list, `get_scripts` trả block theo trang hoặc giới hạn một `scriptId`. Không đưa toàn bộ project lớn vào prompt.
- `update_block` giữ ID block và các input không được thay đổi; `insert_blocks` giữ chuỗi phía sau. Xóa block nối lại lệnh kế tiếp; xóa script bao gồm các nhánh/comment đính kèm. Không xóa định nghĩa My Block còn được gọi.
- `replace_scripts` nhận `scripts: []` để xóa sạch. Giới hạn block được tính trên trạng thái sau chỉnh sửa, không cộng cả code sẽ bị xóa.
- My Blocks: `define_procedure` tạo chữ ký, tham số string/number hoặc boolean và tùy chọn warp. `procedures_call` dùng `fields.PROCEDURE = proccode` được trả về, `inputs` theo tên tham số. Chỉ dùng `argument_reporter_*` bên trong body đúng phạm vi. Không nhận mutation tùy ý từ AI.
- `search_library` trả ID cố định để thêm sprite/costume/backdrop/sound; không tải URL tùy ý. `create_costume` dựng SVG từ hình chữ nhật, ellipse, đường thẳng và text đã escape, không cho chạy code/nhúng URL.
- Nút **Tệp cho AI** tải `.sb3`, `.sprite3`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.wav`, `.mp3` vào bộ nhớ tab. AI chỉ nhập file người dùng đã cung cấp, sau xác nhận. Tối đa 20 file/50 MB; SVG có script/event/external resource bị từ chối; archive nhập qua AI không được có extension ngoài Pen/Music. Không đọc filesystem hoặc URL.
- `save_snapshot` giữ tối đa 5 snapshot/50 MB tổng, không tự xóa snapshot cũ; `restore_snapshot` cần xác nhận và làm đổi target IDs. `export_project`/`export_sprite` tải file xuống máy. Xuất file để lưu lâu dài.
- `run_project` và `test_input` cần xác nhận riêng. Input phím/chuột tự nhả trong `finally`, tối đa 3 giây; `answer` trả lời khối hỏi. `assert_state` trả `passed/actual`, không khẳng định thành công khi sai.
- `generate_costume` gọi model ảnh của bạn (`/images/generations`, hoặc `/images/edits` với `fromIndex` để giữ cùng nhân vật cho khung hình animation), tách nền nếu provider không trả nền trong suốt, cắt sát nhân vật, thu nhỏ theo `size` và thêm thành costume bitmap 2x; phông nền được phủ kín 480×360. Mỗi ảnh mất khoảng 1 phút và tính vào quota của bạn.
- `edit_costume` lật/xoay/scale/đổi màu/xám/tô màu/độ mờ thành costume mới (`replace: true` cần xác nhận). `create_sound` tổng hợp hiệu ứng (coin, jump, laser…); `edit_sound` cắt, chỉnh âm lượng, fade, đảo ngược, đổi tốc độ, vang. `generate_speech` chỉ chạy khi provider có model TTS.
- `record_run` chạy tối đa 10 giây, lấy mẫu vị trí/hướng/costume/biến mỗi 100 ms, có thể bấm phím/click theo mốc thời gian, và ghép 1–6 khung hình thành một ảnh để model đánh giá chuyển động. Bấm cờ xanh hoặc giả lập input cần xác nhận.
- `capture_stage` hiển thị ảnh thật trong tool log và gửi ảnh JPEG nhỏ qua multimodal user message sau khi hoàn tất tool batch. **Chọn model có vision** để AI phân tích ảnh; model text-only nên dùng `assert_state`. Hình ảnh được đánh dấu là dữ liệu không đáng tin cậy.

### Declarative block format

Agent không được thực thi JavaScript tùy ý. Tool nhận DSL JSON, sau đó compiler chuyển thành VM block graph với ID, `parent`, `next`, reporter inputs và shadow blocks hợp lệ.

```json
{
  "targetId": "ID lấy từ get_project",
  "scripts": [[
    { "opcode": "event_whenflagclicked" },
    {
      "opcode": "control_repeat",
      "inputs": {
        "TIMES": 4,
        "SUBSTACK": [
          { "opcode": "motion_movesteps", "inputs": { "STEPS": 100 } },
          { "opcode": "motion_turnright", "inputs": { "DEGREES": 90 } }
        ]
      }
    }
  ]]
}
```

- Mỗi script bắt đầu bằng event hat.
- Số/chuỗi có thể là literal hoặc reporter block object.
- Boolean input phải là boolean block, không nhận `true/false`.
- `SUBSTACK`, `SUBSTACK2` là mảng block.
- `fields.VARIABLE`, `fields.LIST`, `fields.BROADCAST_OPTION` nhận ID hoặc tên không trùng. Nếu local/global trùng tên, bắt buộc dùng ID chính xác. Broadcast input nhận ID/tên qua `BROADCAST_INPUT`.
- Catalog opcode/input/field cho phép nằm ở `shared/catalog.ts`, đồng thời được đưa vào system prompt.
- Muốn thêm chức năng: khai báo schema/description trong `shared/tools.ts`, thực thi trong `src/scratch/`, bổ sung test. `MUTATING_TOOLS` là nguồn duy nhất cho backup tại bridge; `requiresConfirmation` kiểm soát xác nhận trong agent loop và mặc định từ chối nếu thiếu callback.

## Kiến trúc

```text
Chat React
   │ POST /api/agent (cấu hình từ web + hội thoại + live project summary)
   ▼
Express / Worker → provider Chat Completions (key theo từng request)
   │ /api/media/* → provider images/audio (body chuyển nguyên, key ở header)
   │ assistant + tool_calls
   ▼
Agent loop trên browser → validate args → xác nhận thao tác phá hủy
   │ postMessage, đúng origin + source + request ID
   ▼
Scratch editor iframe → bridge tuần tự hóa requests
   │ trusted Vite tools runtime → compiler → Scratch VM
   ▼
Tool result / error → thêm vào hội thoại → model tiếp tục
```

Tools runtime có entry riêng `scratch-tools.html`: dùng được cả dev và production mà không sửa bundle Scratch. `scripts/sync-scratch-editor.mjs` sao chép bundle, license notices, blocks media, lazy chunks và static assets từ npm package. Bundle dùng publicPath `/`, nên không thể chỉ sao chép file JS. Scratch CDN assets được proxy qua server với URL/path allowlist cố định.

### An toàn và khôi phục

- API key do người dùng nhập trên web; backend không lưu key dùng chung, không đọc key từ env và không trả key trong response. Không echo upstream error bodies. Key nằm trong browser storage theo lựa chọn của người dùng; không dùng với máy/extension không đáng tin cậy.
- Server local kiểm tra Host loopback và Origin. Worker public bắt buộc header `Origin` đúng của app cho mọi POST, giới hạn theo IP bằng Cloudflare Rate Limiting (90 request API/phút, 10 request tạo media/phút, 5 lần chia sẻ/phút), giới hạn body (1 MB JSON, 12 MB media, 10 MB chia sẻ) và số node JSON trước khi validate. Không mở CORS tùy ý.
- Tool name, args, opcode, input, field được kiểm tra; không shell/eval hoặc URL mạng tùy ý do model điều khiển.
- Stream provider phải có finish_reason hợp lệ và `[DONE]`; lỗi upstream, SSE sai định dạng hoặc ngắt giữa chừng không được thực thi tool. Có giới hạn byte, thời gian chờ, số tool và ID trùng.
- Compile hoàn chỉnh trước khi chạm VM. Mỗi mutation tool có backup `.sb3`; nếu lỗi, bridge thử khôi phục và báo lỗi. ID có thể đổi sau rollback.
- Trước mỗi bước AI có sửa project, và trước demo/import/khôi phục, có snapshot cho nút **Hoàn tác** (tối đa 20 bước / 150 MB). Hoàn tác giữ hội thoại và thêm ghi chú để AI đọc lại project vì ID có thể đổi.
- Khóa editor khi agent đang chạy để tránh xung đột kéo thả; nút **Dừng agent** hủy request model và không chạy các tool tiếp theo. Tool VM đang thực hiện được chờ hoàn tất, không bị cắt giữa mutation. Dừng agent **không** đồng nghĩa với `stop_project`.
- Không giới hạn số bước mặc định: agent chạy tới khi xong hoặc khi bạn bấm Dừng; có thể đặt **Số bước tối đa** trong Cài đặt. Agent tự dừng nếu gọi lặp cùng một tool với cùng tham số (3 lần với tool sửa, 5 lần với tool đọc). Context cũ được nén (giữ 3 ảnh gần nhất, rút gọn kết quả tool cũ) để mỗi request vẫn dưới giới hạn. Provider trả 429/5xx hoặc lỗi mạng được thử lại tối đa 2 lần trước khi stream (theo `Retry-After`). Server local: tối đa 120 model requests/phút, 1 request đồng thời.
- Có giới hạn payload, độ sâu DSL, block count, sprite count và timeout. Nếu Scratch request timeout, editor bị khóa và yêu cầu tải lại để tránh sửa trên trạng thái chưa xác định.

## Kiểm thử

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit tests còn chạy worker **bên trong workerd** (runtime thật của Cloudflare, qua Miniflare) để bắt lỗi chỉ xảy ra trên Workers. Unit/API tests kiểm tra compiler, tool allowlist, agent loop, cancellation, xác nhận thay scripts, protocol và bảo vệ key/origin/host. Browser tests dùng **Scratch GUI/VM thật**, bao gồm broadcast/clone/list/My Blocks thực sự chạy, sửa riêng block/script và giữ nhánh/comment, phân trang project lớn, CRUD dữ liệu/tài nguyên, Pen/Music, chụp sân khấu, file upload/download và roundtrip toàn bộ catalog. Bộ kiểm thử tự động dùng **mock provider** để không tốn quota/API key; tương thích từng gateway/model cần kiểm thử riêng với cấu hình web. Browser tests cần mạng tới Scratch CDN và port 3001 trống.

## Deploy và CI

```bash
npm run deploy   # build + wrangler deploy lên Cloudflare Workers
```

`wrangler.jsonc` khai báo static assets, KV `SHARES` (link chia sẻ) và 3 binding rate limit. Bỏ KV thì nút Chia sẻ tự ẩn. GitHub Actions (`.github/workflows/ci.yml`) chạy unit test (gồm test trong workerd), build và e2e cho mỗi push/PR; job deploy chạy trên `main` khi repository có secret `CLOUDFLARE_API_TOKEN` (token Cloudflare có quyền sửa Workers), nếu chưa có thì bỏ qua.

## Giấy phép và thương hiệu

- Trình soạn Scratch (`@scratch/scratch-gui-standalone`, `scratch-vm`, `scratch-render`) dùng giấy phép **AGPL-3.0-only**. Khi chạy app cho người khác dùng qua mạng, AGPL yêu cầu cung cấp mã nguồn tương ứng: giao diện có link **Mã nguồn** tới repository này và link tới file LICENSE của Scratch GUI. Repository chưa khai báo license cho phần code riêng; hãy chọn license tương thích AGPL trước khi phân phối.
- Scratch, logo và Scratch Cat là thương hiệu của Scratch Foundation; file `TRADEMARK` của upstream cấm dùng để quảng bá sản phẩm phái sinh khi chưa được cho phép. Giao diện ghi rõ app không liên kết với Scratch Foundation; nên xem lại cái tên “Scratch Vibe” nếu phát hành rộng.

## Giới hạn hiện tại

- Project và hội thoại được tự lưu trong IndexedDB của trình duyệt (không đồng bộ giữa máy). File tải cho AI và snapshot của AI vẫn chỉ nằm trong RAM của tab. Vẫn nên **Lưu `.sb3`** cho bản quan trọng.
- Chưa có tài khoản người dùng, đồng bộ cloud hay realtime collaboration. Link chia sẻ ai có link cũng mở được và hết hạn sau 30 ngày.
- Thông báo lỗi từ server/tool hiện chỉ có tiếng Việt, kể cả khi giao diện ở tiếng Anh.
- Không mở rộng sang opcode legacy/ẩn, cloud variable writes, extension URL tùy ý, hardware/camera/network extensions. Pen/Music được hỗ trợ; microphone chỉ do người dùng cấp quyền trên GUI. Không có trình biên tập waveform/audio AI hay chỉnh từng điểm path vector tùy ý; dùng tài nguyên thư viện/file hoặc SVG hình học an toàn. Project chứa block ngoài catalog vẫn có thể đọc, nhưng AI không sinh/chỉnh nội dung opcode ngoài allowlist.
- `npm audit` vẫn báo lỗ hổng, gồm high/critical, chủ yếu trong cây dependencies upstream Scratch standalone (công cụ build như mocha/transifex/request/tar). Đã chạy `npm audit fix` không dùng `--force`. Cảnh báo `zod` (validate mảng rất lớn) được giảm thiểu bằng giới hạn body và số node JSON trước khi validate; bản sửa gốc cần nâng cấp lên Zod 4. `qs` chỉ thuộc server Express local. Bundle Scratch prebuilt không tự được vá khi cập nhật transitive dependency. Cần đánh giá/nâng cấp hoặc build lại upstream trước khi triển khai public; không coi MVP này là production-hardened.
- Scratch là sản phẩm/nhãn hiệu của Scratch Foundation; ứng dụng này không phải sản phẩm chính thức. License và trademark của distribution upstream được giữ trong thư mục vendor sau sync; xem notices đó trước khi phân phối.

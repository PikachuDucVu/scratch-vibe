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

Hiện có **47 function tools**, **140 opcode DSL** và compiler cho định nghĩa My Blocks. Schema JSON gửi provider được sinh trực tiếp từ Zod — cùng giới hạn với runtime.

| Nhóm | Tools |
| --- | --- |
| Đọc project | `get_project`, `get_scripts`, `get_variables`, `get_assets`, `get_procedures`, `get_comments`, `get_runtime` |
| Chỉnh code | `add_scripts`, `replace_scripts`, `replace_script`, `delete_script`, `insert_blocks`, `update_block`, `delete_block`, `define_procedure` |
| Sprite | `add_sprite`, `set_sprite`, `duplicate_sprite`, `delete_sprite` |
| Dữ liệu | `create_variable`, `set_variable`, `rename_variable`, `delete_variable`, `create_list`, `update_list`, `create_broadcast`, `set_monitor` |
| Comment | `set_comment`, `delete_comment` |
| Tài nguyên | `search_library`, `add_asset`, `manage_asset`, `create_costume`, `load_extension` |
| Chạy/kiểm thử | `run_project`, `stop_project`, `test_input`, `wait_project`, `assert_state`, `capture_stage` |
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
- Kiểm tra Host loopback và Origin, không mở CORS tùy ý.
- Tool name, args, opcode, input, field được kiểm tra; không shell/eval hoặc URL mạng tùy ý do model điều khiển.
- Stream provider phải có finish_reason hợp lệ và `[DONE]`; lỗi upstream, SSE sai định dạng hoặc ngắt giữa chừng không được thực thi tool. Có giới hạn byte, thời gian chờ, số tool và ID trùng.
- Compile hoàn chỉnh trước khi chạm VM. Mỗi mutation tool có backup `.sb3`; nếu lỗi, bridge thử khôi phục và báo lỗi. ID có thể đổi sau rollback.
- Trước mỗi lượt agent/demo/import có snapshot cho nút **Hoàn tác**. Undo khôi phục project và làm mới hội thoại vì ID có thể đổi.
- Khóa editor khi agent đang chạy để tránh xung đột kéo thả; nút **Dừng agent** hủy request model và không chạy các tool tiếp theo. Tool VM đang thực hiện được chờ hoàn tất, không bị cắt giữa mutation. Dừng agent **không** đồng nghĩa với `stop_project`.
- Giới hạn 12 lượt model, 36 tool calls mỗi yêu cầu; tối đa 120 model requests/phút, chỉ 1 model request đồng thời trên server local.
- Có giới hạn payload, độ sâu DSL, block count, sprite count và timeout. Nếu Scratch request timeout, editor bị khóa và yêu cầu tải lại để tránh sửa trên trạng thái chưa xác định.

## Kiểm thử

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit/API tests kiểm tra compiler, tool allowlist, agent loop, cancellation, xác nhận thay scripts, protocol và bảo vệ key/origin/host. Browser tests dùng **Scratch GUI/VM thật**, bao gồm broadcast/clone/list/My Blocks thực sự chạy, sửa riêng block/script và giữ nhánh/comment, phân trang project lớn, CRUD dữ liệu/tài nguyên, Pen/Music, chụp sân khấu, file upload/download và roundtrip toàn bộ catalog. Bộ kiểm thử tự động dùng **mock provider** để không tốn quota/API key; tương thích từng gateway/model cần kiểm thử riêng với cấu hình web. Browser tests cần mạng tới Scratch CDN và port 3001 trống.

## Giới hạn hiện tại

- Chỉ giữ project/hội thoại/file AI/snapshot trong RAM. **Lưu `.sb3` trước khi đóng hoặc tải lại trang.** Nút Hoàn tác khôi phục trước lượt gần nhất; snapshot do AI tạo được chọn qua `restore_snapshot`.
- Có streaming token; chưa có database hội thoại, multi-user, authentication hay realtime collaboration.
- Không mở rộng sang opcode legacy/ẩn, cloud variable writes, extension URL tùy ý, hardware/camera/network extensions. Pen/Music được hỗ trợ; microphone chỉ do người dùng cấp quyền trên GUI. Không có trình biên tập waveform/audio AI hay chỉnh từng điểm path vector tùy ý; dùng tài nguyên thư viện/file hoặc SVG hình học an toàn. Project chứa block ngoài catalog vẫn có thể đọc, nhưng AI không sinh/chỉnh nội dung opcode ngoài allowlist.
- `npm audit` vẫn báo lỗ hổng, gồm high/critical, trong cây dependencies upstream Scratch standalone. Đã thử `npm audit fix` không dùng `--force`; các cảnh báo upstream còn tồn tại. Bundle Scratch prebuilt không tự được vá khi cập nhật transitive dependency. Cần đánh giá/nâng cấp hoặc build lại upstream trước khi triển khai public; không coi MVP này là production-hardened.
- Scratch là sản phẩm/nhãn hiệu của Scratch Foundation; ứng dụng này không phải sản phẩm chính thức. License và trademark của distribution upstream được giữ trong thư mục vendor sau sync; xem notices đó trước khi phân phối.

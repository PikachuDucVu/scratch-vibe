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
- Bật AI: điền `OPENAI_API_KEY` vào `.env`, khởi động lại server rồi tải lại trang.

```dotenv
OPENAI_API_KEY=your-key-here
OPENAI_MODEL=gpt-4.1
OPENAI_BASE_URL=https://api.openai.com/v1
# Tùy chọn, chỉ cho model/provider hỗ trợ reasoning_effort:
OPENAI_REASONING_EFFORT=
PORT=3001
APP_ORIGIN=http://127.0.0.1:5173
```

Có thể đổi sang endpoint **OpenAI-compatible Chat Completions** có hỗ trợ function tools, `parallel_tool_calls` và `max_completion_tokens`. Model phải hỗ trợ tool calling. Với model local, HTTP chỉ được phép cho `localhost` / `127.0.0.1`; server vẫn cần key không rỗng theo cấu hình gateway.

Để bật mức suy luận cao, đặt `OPENAI_REASONING_EFFORT=high` (cũng hỗ trợ `low` / `medium`). Server gửi giá trị này qua field `reasoning_effort`, giữ nguyên model ID. Để trống nếu provider/model không hỗ trợ.

**Không** đặt key vào biến `VITE_*`, client code hoặc chat. Request chứa mô tả, tên sprite/biến và block của project sẽ được gửi tới provider đã cấu hình; không dùng dữ liệu nhạy cảm nếu chưa xem chính sách provider.

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

| Tool | Tác dụng |
| --- | --- |
| `get_project` | Đọc target IDs, tên, vị trí, costumes, biến, số scripts/block |
| `get_scripts` | Đọc graph block hiện tại của một target |
| `add_scripts` | Thêm scripts mà không xóa code cũ |
| `replace_scripts` | Thay tất cả scripts của một target; cần người dùng xác nhận trong luồng agent |
| `set_sprite` | Đổi tên, tọa độ, hướng, kích thước, ẩn/hiện |
| `duplicate_sprite` | Nhân bản sprite và trả ID mới |
| `create_variable` | Tạo/cập nhật biến scalar local hoặc global trên stage |
| `run_project` | Bấm cờ xanh |
| `stop_project` | Dừng tất cả scripts |

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
- `fields.VARIABLE` là tên biến đã tạo; compiler tự giải quyết ID theo scope.
- Catalog opcode/input/field cho phép nằm ở `shared/catalog.ts`, đồng thời được đưa vào system prompt.
- Muốn thêm chức năng: khai báo schema/definition trong `shared/tools.ts`, thực thi trong `src/scratch/vm-tools.ts`, bổ sung test; tool phá hủy dữ liệu cần confirmation tương ứng trong agent loop.

## Kiến trúc

```text
Chat React
   │ POST /api/agent (hội thoại + live project summary)
   ▼
Express → provider Chat Completions (key chỉ ở server)
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

- API key không trả xuống trình duyệt; upstream error bodies không được echo.
- Kiểm tra Host loopback và Origin, không mở CORS tùy ý.
- Tool name, args, opcode, input, field được kiểm tra; không shell/eval/network tool do model điều khiển.
- Compile hoàn chỉnh trước khi chạm VM. Mỗi mutation tool có backup `.sb3`; nếu lỗi, bridge thử khôi phục và báo lỗi. ID có thể đổi sau rollback.
- Trước mỗi lượt agent/demo/import có snapshot cho nút **Hoàn tác**. Undo khôi phục project và làm mới hội thoại vì ID có thể đổi.
- Khóa editor khi agent đang chạy để tránh xung đột kéo thả; nút **Dừng agent** hủy request model và không chạy các tool tiếp theo. Tool VM đang thực hiện được chờ hoàn tất, không bị cắt giữa mutation. Dừng agent **không** đồng nghĩa với `stop_project`.
- Giới hạn 12 lượt model, 36 tool calls mỗi yêu cầu; tối đa 30 model requests/phút, chỉ 1 model request đồng thời trên server local.
- Có giới hạn payload, độ sâu DSL, block count, sprite count và timeout. Nếu Scratch request timeout, editor bị khóa và yêu cầu tải lại để tránh sửa trên trạng thái chưa xác định.

## Kiểm thử

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit/API tests kiểm tra compiler, tool allowlist, agent loop, cancellation, xác nhận thay scripts, protocol và bảo vệ key/origin/host. Browser tests dùng **Scratch GUI/VM thật**, kiểm tra block hiển thị, demo, xuất/nhập `.sb3`, undo, rollback, biến/global reporter, sprite properties và duplication. Luồng AI được kiểm tra bằng **mock provider**; chưa kiểm chứng kết nối model thật khi không cấu hình key. Browser tests cần mạng tới Scratch CDN và port 3001 trống.

## Giới hạn hiện tại

- Chỉ giữ project/hội thoại/snapshot trong RAM. **Lưu `.sb3` trước khi đóng hoặc tải lại trang.** Chỉ undo thao tác gần nhất.
- Chưa có streaming token, database hội thoại, multi-user, authentication hay realtime collaboration.
- Agent chỉ hỗ trợ opcode catalog hiện có (motion, looks, events, control, sensing, operators, scalar variables); chưa tự tạo costumes/sounds, list, custom procedures hoặc extensions. Người dùng vẫn có thể thêm chúng bằng GUI nhưng agent chưa chỉnh chúng qua DSL.
- `npm audit` vẫn báo lỗ hổng, gồm high/critical, trong cây dependencies upstream Scratch standalone. Đã thử `npm audit fix` không dùng `--force`; các cảnh báo upstream còn tồn tại. Bundle Scratch prebuilt không tự được vá khi cập nhật transitive dependency. Cần đánh giá/nâng cấp hoặc build lại upstream trước khi triển khai public; không coi MVP này là production-hardened.
- Scratch là sản phẩm/nhãn hiệu của Scratch Foundation; ứng dụng này không phải sản phẩm chính thức. License và trademark của distribution upstream được giữ trong thư mục vendor sau sync; xem notices đó trước khi phân phối.

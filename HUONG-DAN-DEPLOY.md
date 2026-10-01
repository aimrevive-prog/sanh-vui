# 🎰 HƯỚNG DẪN DEPLOY "SẢNH VUI" LÊN RENDER — CHẠY 24/7 MIỄN PHÍ

Làm theo đúng thứ tự, khoảng **15–20 phút** là xong. Không cần biết lập trình!

---

## 📦 BƯỚC 1 — Tạo tài khoản GitHub (nếu chưa có)

1. Vào https://github.com → nhấn **Sign up**
2. Điền email, đặt mật khẩu, đặt tên ngường dùng bất kỳ → xác nhận email
3. Xong! GitHub là nơi lưu code để Render lấy code từ đó về chạy.

---

## 📤 BƯỚC 2 — Đưa code game lên GitHub

1. Đăng nhập GitHub → nhấn dấu **+** (góc trên phải) → **New repository**
2. Đặt tên: `sanh-vui` (hoặc tên gì cũng được) → chọn **Public** hoặc **Private** đều OK
   - ⚠️ KHÔNG tick “Add a README file” (để repo trống)
3. Nhấn **Create repository**
4. Trên trang repo vừa tạo, nhấn link **“uploading an existing file”**
5. Kéo thả (hoặc chọn) **4 file/thư mục này** từ máy bạn:
   - `server.js`
   - `package.json`
   - `.gitignore`
   - thư mục **`public/`** (chứa `index.html` và `style.css`)
   
   > 💡 Để upload cả thư mục: kéo thẳng thư mục `public` vào trang upload, GitHub sẽ giữ nguyên cấu trúc.
   
   > ⛔ **KHÔNG upload file `data.json`** — đó là dữ liệu chạy thật, để server tự tạo.
6. Kéo xuống dưới, nhấn nút xanh **Commit changes**

---

## ☁️ BƯỚC 3 — Deploy lên Render

1. Vào https://render.com → **Get Started** → đăng ký bằng **GitHub** (nhấn “Sign up with GitHub” cho nhanh)
2. Vào Dashboard → nhấn **New +** → chọn **Web Service**
3. Chọn **“Build and deploy from a Git repository”** → **Next**
4. Nhấn **Connect** cạnh repo `sanh-vui` vừa tạo (lần đầu Render sẽ hỏi quyền truy cập GitHub → chọn repo → chấp nhận)
5. Điền form cấu hình:
   - **Name:** `sanh-vui` (sẽ thành địa chỉ web: `sanh-vui.onrender.com`)
   - **Region:** **Singapore** (gần Việt Nam nhất, nhanh nhất!)
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build Command:** để trống (không cần build gì cả)
   - **Start Command:** `node server.js`
   - **Instance Type:** chọn **Free** ✅
6. ⚠️ **QUAN TRỌNG — Đặt mật khẩu admin:**
   - Kéo xuống phần **Environment Variables** → nhấn **Add Environment Variable**
   - **KEY:** `ADMIN_PASS` — **VALUE:** `123456` (hoặc mật khẩu bạn muốn)
   - Có thể thêm (không bắt buộc): `BET_MS` = `25000`, `REVEAL_MS` = `7000` (thờigian ván)
7. Nhấn **Create Web Service** → đợi 2–3 phút (“Deploying…” → **“Live”** màu xanh lá = thành công!)
8. Nhấn vào đường link dạng `https://sanh-vui.onrender.com` ở đầu trang → **GAME CHẠY 24/7 TRÊN INTERNET!** 🎉

---

## ⏰ BƯỚC 4 — Giữ server không bị ngủ (QUAN TRỌNG!)

Render miễn phí sẽ “ngủ đông” sau 15 phút không ai truy cập (mở lại chậm ~30 giây). Cách khắc phục miễn phí:

1. Vào https://cron-job.org → **Sign up** (miễn phí)
2. Tạo cronjob mới:
   - **URL:** `https://sanh-vui.onrender.com/health` (thay bằng link của bạn)
   - Tắt “Requires authentication”
   - **Schedule:** mỗi **5 phút** (chọn “Every 5 minutes”)
3. Save → xong! Server sẽ luôn tỉnh.

> 💡 Mẹo khác: UptimeRobot.com cũng miễn phí, tạo “HTTP(s) monitor” trỏ về `/health`, chu kỳ 5 phút.

---

## 💾 BƯỚC 5 — Sao lưu dữ liệu (bảo vệ xu của ngường chơi)

Trung tâm miễn phí của Render **có thể reset dữ liệu khi server khởi động lại** (deploy lại, bảo trì). Nhưng app đã có sẵn tính năng chống mất:

### Tải file sao lưu (nên làm 1 lần/tuần hoặc trước khi deploy lại):
1. Mở game → nhấn nút **⚙️ Admin** (góc trái bottom bar) → nhập mật khẩu `123456`
2. Kéo xuống mục **💾 Sao lưu dữ liệu** → nhấn **⬇️ Tải file sao lưu**
3. File `sanhvui-backup-ngay-XX.json` được tải về máy → **giữ cẩn thận!**

### Khôi phục khi cần:
1. Vào **Admin** → nhấn **⬆️ Khôi phục từ file sao lưu** → chọn file đã tải
2. Xác nhận → toàn bộ tài khoản + xu + lịch sử quay lại y nguyên ✨

> 🔁 Lần đầu deploy: nếu muốn mang số xu hiện tại từ bản sandbox lên, dùng file `sanhvui-backup-khoi-dau.json` (đã tạo sẵn) để khôi phục.

---

## 🛠️ Cập nhật game sau này

Mỗi lần mình sửa code cho bạn:
1. Upload file mới lên GitHub (ghi đè file cũ) → Commit changes
2. Render **tự phát hiện và deploy lại trong ~2 phút** — không cần làm gì thêm!

---

## ❓ Sự cố thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| Deploy lỗi “failed” | Vào tab **Logs** trên Render xem lỗi; thường là thiếu `package.json` — kiểm tra Bước 2 đã upload đủ file chưa |
| Mở web thấy trắng trơn ~30s | Server đang thức dậy sau giấc ngủ → bình thường, hoặc làm Bước 4 |
| Quên mật khẩu admin | Render → service → **Environment** → sửa `ADMIN_PASS` → Save (server tự restart) |
| WebSocket rớt liên tục | Kiểm tra cronjob ping có đúng link `/health` không |

---

## 🎮 Xong rồi! App của bạn giờ:
- ✅ Chạy 24/7 trên internet, link truy cập từ mọi thiết bị
- ✅ Tự deploy lại mỗi khi cập nhật code
- ✅ Có thể sao lưu/khôi phục xu bất cứ lúc nào
- ✅ 100% miễn phí

*Chúc bạn và bạn bè chơi vui! 🎲🍀*

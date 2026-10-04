# HƯỚNG DẪN TRIỂN KHAI: WEB TĨNH + DISCORD BOT CHẠY 24/7 KHÔNG CẦN BẬT MÁY TÍNH

Chào bạn, đây là tài liệu kiến trúc kỹ thuật và hướng dẫn từng bước để bạn đưa bot Discord Gecko chạy online 24/7 trên Cloud (không phụ thuộc vào máy tính cá nhân), đồng thời host trang web điều khiển/dashboard dưới dạng **Web tĩnh 100%** (GitHub Pages hoặc Cloudflare Pages).

---

## 1. NGUYÊN LÝ HOẠT ĐỘNG (KIẾN TRÚC CLIENT-SERVER)

### Vì sao một Web tĩnh đơn thuần KHÔNG THỂ tự nó chạy Bot phát nhạc Discord?
- **Web tĩnh (GitHub Pages / Cloudflare Pages)** chỉ là nơi chứa file tĩnh (HTML, CSS, JavaScript) được tải về trình duyệt của người dùng.
- Để bot Discord có thể vào room voice và **phát nhạc**:
  1. Bot phải duy trì kết nối WebSocket liên tục 24/7 với **Discord Gateway** để nhận lệnh `/play`.
  2. Bot phải mở kết nối mạng **UDP Voice Socket** tới cụm server Discord Voice.
  3. Bot phải chạy tiến trình **FFmpeg** để giải mã và stream các gói âm thanh **Opus stereo 48kHz (cứ mỗi 20ms một gói tin)** liên tục không ngừng nghỉ.
- Khi bạn tắt máy tính cá nhân hoặc đóng trình duyệt, Web tĩnh sẽ **hoàn toàn ngừng chạy** trên máy bạn. Do đó, **bắt buộc phải có một Cloud Backend (máy chủ đám mây) chạy 24/7**.

### Giải pháp tối ưu:
1. **Cloud Backend 24/7 (Miễn phí/Rẻ)**: Chạy mã nguồn Node.js + FFmpeg của Gecko trên nền tảng đám mây (Render, Railway, Fly.io, Koyeb, hoặc VPS). Backend này giữ bot online 24/7, tự kết nối Discord, tự phát nhạc khi bạn tắt máy tính.
2. **Web Tĩnh (GitHub Pages / Cloudflare Pages)**: Chứa giao diện `index.html`. Web tĩnh này kết nối đến Cloud Backend qua API `/healthz` và `/api/*` để hiển thị trạng thái và điều khiển bot.

---

## 2. BƯỚC 1: TRIỂN KHAI BOT BACKEND LÊN CLOUD 24/7 (MIỄN PHÍ)

Bạn có thể chọn một trong các nền tảng sau để chạy bot 24/7 hoàn toàn không tốn tiền:

### Lựa chọn A: Render.com (Khuyên dùng - Rất dễ)
1. Đăng ký tài khoản miễn phí tại [Render.com](https://render.com).
2. Tạo một **Web Service** mới và liên kết với GitHub repository của dự án này.
3. Cấu hình cài đặt:
   - **Environment**: `Node` (hoặc `Docker` - repo đã có sẵn `Dockerfile`)
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
4. Trong phần **Environment Variables**, thêm các biến:
   - `BOT_TOKEN`: Token Discord Bot của bạn (lấy từ Discord Developer Portal)
   - `CLIENT_ID`: ID của bot Discord
   - `PORT`: `3000`
5. Nhấn **Deploy**. Sau 2-3 phút, Render sẽ cấp cho bạn một URL Backend, ví dụ:
   `https://gecko-bot-xxxx.onrender.com`
   Bot Discord của bạn lúc này đã **TRỰC TUYẾN 24/7** trên Discord, bạn có thể tắt máy tính và vào Discord gõ `/play` để nghe nhạc bình thường!

### Lựa chọn B: Railway.app (Cực nhanh và mượt)
1. Đăng ký tại [Railway.app](https://railway.app).
2. Chọn **New Project** → **Deploy from GitHub repo**.
3. Railway tự động nhận diện `Dockerfile` hoặc `package.json` và build.
4. Thêm biến môi trường `BOT_TOKEN` trong mục **Variables**.
5. Tạo Domain công khai trong mục **Networking** (ví dụ: `https://gecko-production.up.railway.app`).

### Lựa chọn C: VPS Riêng (Oracle Cloud Free Tier / VPS $2-3/tháng)
Nếu bạn có VPS Ubuntu/Debian:
```bash
git clone <repo-url>
cd gecko
npm install
npm run build
pm2 start dist/index.js --name "gecko-bot"
pm2 save
pm2 startup
```

---

## 3. BƯỚC 2: TRIỂN KHAI WEB TĨNH LÊN GITHUB PAGES / CLOUDFLARE PAGES

### Đưa lên GitHub Pages:
1. Trong repository GitHub của bạn, vào **Settings** → **Pages**.
2. Tại mục **Build and deployment**, chọn **Source**: `Deploy from a branch`.
3. Chọn nhánh `main` (hoặc `gh-pages`), thư mục `/ (root)`.
4. Nhấn **Save**. Sau 1 phút, trang web tĩnh của bạn sẽ online tại:
   `https://<ten-user>.github.io/<ten-repo>/`

### Đưa lên Cloudflare Pages:
1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → **Pages**.
2. Kết nối với GitHub repo của bạn.
3. Build command: để trống (hoặc `npm run build`), Output directory: `.` (root).
4. Nhấn **Save and Deploy**. Bạn sẽ nhận được URL: `https://gecko.pages.dev`.

---

## 4. BƯỚC 3: KẾT NỐI WEB TĨNH VỚI CLOUD BACKEND 24/7

Khi mở trang web tĩnh trên GitHub Pages hoặc Cloudflare Pages:

### Cách 1: Sử dụng tham số URL (Thuận tiện nhất khi chia sẻ)
Chỉ cần thêm `?backend=URL_BACKEND_CUA_BAN` vào cuối đường link web tĩnh:
```text
https://username.github.io/gecko/?backend=https://gecko-bot-xxxx.onrender.com
```
Hệ thống sẽ tự động lưu URL này vào `localStorage` của trình duyệt. Lần sau truy cập bạn không cần nhập lại nữa!

### Cách 2: Nhấp trực tiếp trên giao diện
1. Mở trang web tĩnh trên trình duyệt.
2. Tại huy hiệu trạng thái ở Hero Section (`WEB TĨNH (NHẤP ĐỂ KẾT NỐI BACKEND)`), bạn nhấp chuột vào huy hiệu.
3. Một hộp thoại hiện ra, bạn dán đường dẫn Backend của mình vào (ví dụ: `https://gecko-bot-xxxx.onrender.com`).
4. Nhấn **OK**. Trang web sẽ lập tức chuyển sang trạng thái xanh lá **TRỰC TUYẾN** và hiển thị toàn bộ thông số RAM, Uptime, Máy chủ, Hàng đợi của bot!

---

## TỔNG KẾT
- **Máy tính của bạn**: Hoàn toàn có thể tắt nguồn, đi ngủ, ngắt mạng.
- **Discord Bot**: Luôn luôn online 24/7 trên Discord Voice, bạn và bạn bè có thể nghe nhạc bất kỳ lúc nào.
- **Web Dashboard**: Là web tĩnh tải cực nhanh, mở được trên cả điện thoại lẫn máy tính để theo dõi và quản lý bot từ xa.

# Book Cover AI App (Cloudflare)

اپ ثبت کتاب با عکس جلد، OCR و پر کردن خودکار فرم.

## قابلیت‌ها

- گرفتن عکس جلد کتاب از دوربین یا گالری
- استخراج متن با Cloudflare AI
- پر کردن خودکار `عنوان`، `نویسنده`، `ISBN`
- ذخیره اطلاعات در `D1`
- ذخیره تصویر جلد در `R2`
- خروجی `CSV` برای انتقال به سیستم‌های کتابخانه‌ای

## پیش‌نیاز

- Node.js 20+
- حساب Cloudflare
- Wrangler CLI (با `npm install` نصب می‌شود)

## راه‌اندازی

1. نصب وابستگی‌ها:

```bash
npm install
```

2. ورود به کلادفلر:

```bash
npx wrangler login
```

3. ساخت دیتابیس D1:

```bash
npx wrangler d1 create bookdb
```

خروجی این دستور را در `wrangler.toml` قرار دهید:

- `database_id`

4. ساخت باکت R2:

```bash
npx wrangler r2 bucket create book-covers
```

5. اجرای migration:

```bash
npx wrangler d1 execute bookdb --remote --file=./schema.sql
```

6. اجرای محلی:

```bash
npm run dev
```

## فایل‌های مهم

- `src/worker.js`: API و منطق OCR/ذخیره/خروجی
- `public/index.html`: رابط کاربری ثبت کتاب
- `schema.sql`: ساخت جدول `books`
- `wrangler.toml`: تنظیمات Worker + D1 + R2 + AI

## API

- `POST /api/scan` (multipart/form-data با فیلد `image`)
- `POST /api/books` (json)
- `GET /api/books`
- `GET /api/export.csv`
- `GET /covers/:key`

## نکته

مدل استخراج در MVP روی مدل‌های vision مولد Cloudflare قرار گرفته:

- `@cf/meta/llama-3.2-11b-vision-instruct` (اولویت اول)
- `@cf/meta/llama-4-scout-17b-16e-instruct` (پشتیبان)

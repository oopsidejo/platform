# الرفع لايف (مجاني)

## 1) GitHub
ارفع كل الملفات والمجلدات (src, public, test, migrations, reference) فوق القديمة.

## 2) Supabase
1. SQL Editor: شغّل `schema.sql` (إذا ما شغّلته بعد)، ثم شغّل `migrations/v1.3.sql` (آمن حتى لو شغّلته مرتين).
2. Authentication → Users → Add user (إيميلك + كلمة سر + Auto Confirm) ثم أوامر الأدمن والموقع.
3. Storage → New bucket → الاسم `media` → فعّل Public.
4. انسخ من Project Settings:
   - API → Project URL = `SUPABASE_URL`
   - API Keys → anon/publishable = `SUPABASE_ANON_KEY`
   - API Keys → service_role/secret = `SUPABASE_SERVICE_KEY` (سري!)
   - Database → Connect → Session pooler = `DATABASE_URL` (حط كلمة سر القاعدة مكان [YOUR-PASSWORD])

## 3) Render (مجاني)
1. render.com → New → Blueprint → اختر الريبو.
2. عبّي المتغيرات الأربعة من الخطوة 2.
3. بعد ما يخلص: افتح `https://<اسمك>.onrender.com/health` → `{"ok":true}`.
4. المتجر: `https://<اسمك>.onrender.com/` — اللوحة: `https://<اسمك>.onrender.com/admin`

## 4) بعد أول تشغيل
- Supabase → Authentication → URL Configuration → Site URL = `https://<اسمك>.onrender.com/admin` (لروابط دعوة الموظفين ونسيت كلمة السر).
- UptimeRobot (مجاني): HTTP monitor على `/health` كل 5 دقائق حتى ما ينام السيرفر.

## 5) الدومين (لاحقاً)
Render → Settings → Custom Domains → أضف الدومين، وحطه بخانة الدومين بتصميم الموقع باللوحة.

# خطوات الرفع لايف — بالترتيب

## 1) GitHub (5 دقائق)
1. github.com → New repository → اسمه `platform` (Private).
2. ارفع مجلد `api` ومجلد `handoff` كما هما.

## 2) Supabase — قاعدة البيانات (10 دقائق)
1. supabase.com → New project → المنطقة **Frankfurt (eu-central-1)** → احفظ كلمة سر القاعدة.
2. SQL Editor → New query → الصق محتوى `schema.sql` كامل → Run. لازم يطلع Success.
3. Authentication → Users → Add user → إيميلك وكلمة سر (هذا حساب الأدمن).
4. SQL Editor شغّل (بدّل الإيميل):
```sql
insert into staff(user_id,name,role) select id,'وليد','admin' from auth.users where email='YOUR@EMAIL.com';
```
5. أنشئ الموقع الأول:
```sql
insert into sites(slug,name,domain,whatsapp,config) values('mahamiho','محاميحو','mahamiho.com','9627XXXXXXXX',
 '{"freeShip":{"on":true,"min":30},"proof":{"on":true,"min":2},"leads":true,"pixel":"PIXEL_ID"}');
insert into site_countries select id,'jo' from sites where slug='mahamiho';
insert into site_currencies select id,'JOD' from sites where slug='mahamiho';
```
6. Storage → New bucket → `media` → Public.
7. Project Settings → Database → Connection string → **Session pooler** → انسخ الرابط وحط كلمة السر مكان `[YOUR-PASSWORD]`. هذا هو `DATABASE_URL`.
8. Project Settings → Database → Backups: تأكد إنها مفعّلة. Authentication → فعّل MFA للأدمن.

## 3) Render — السيرفر (10 دقائق)
1. render.com → سجّل بـ GitHub → New → **Blueprint** → اختر الريبو (يقرأ `api/render.yaml`).
   - إذا ما ظهر: New → Web Service → Root Directory: `api` → Build: `npm ci` → Start: `npm start`.
2. Environment: حط `DATABASE_URL` و`ALLOWED_ORIGINS` (دومينات المواقع) و`CAPI_TOKEN_MAHAMIHO`.
3. الخطة: **Starter** (المجانية بتنام وبتخسرك طلبات من الإعلانات).
4. افتح `https://<اسم-الخدمة>.onrender.com/health` → لازم يطلع `{"ok":true}`.
5. افحص: `https://<الخدمة>.onrender.com/api/site?site=mahamiho` → لازم يرجع بيانات الموقع.

## 4) الواجهة (شغل الشاب)
- Next.js على Vercel أو Render: الموقع العام يقرأ `GET /api/site` ويرسل الطلب لـ `POST /api/orders`، بنفس شكل `reference/platform6.html`.
- لوحة التحكم: Next.js + `@supabase/supabase-js` بتسجيل دخول الموظف.
- متغيرات الواجهة: `NEXT_PUBLIC_API_URL`، `NEXT_PUBLIC_SUPABASE_URL`، `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## 5) الدومين
- بمزوّد الدومين: `CNAME www → <عنوان الواجهة>` و A/ALIAS للجذر حسب تعليمات Vercel/Render.
- (اختياري) `api.mahamiho.com` → CNAME لخدمة Render، وأضفه بـ Render → Custom Domains.
- أضف الدومين بـ `ALLOWED_ORIGINS` وبجدول `sites.domain`.

## 6) قبل أول إعلان — اختبار
- [ ] طلب حقيقي من الموبايل وصل للوحة والمخزون نقص.
- [ ] طلب برقم ناقص يرفض، وكوبون غلط يرفض.
- [ ] Meta Events Manager → Test Events: وصل Purchase مرة وحدة (مش مكرر).
- [ ] صفحة المنتج تفتح بأقل من 3 ثواني على 4G.

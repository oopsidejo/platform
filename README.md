# platform-api — الباك إند

## التشغيل محلياً
```
cp .env.example .env   # عبّي DATABASE_URL
npm ci && npm start    # http://localhost:3000/health
npm test               # اختبار كامل على Postgres تجريبي (يحتاج ../handoff/schema.sql)
```

## المسارات
| المسار | الوظيفة |
|---|---|
| `GET /health` | فحص السيرفر والقاعدة |
| `GET /api/site?site=<domain أو slug>` | كل بيانات الموقع للواجهة (إعدادات، منتجات، دول، محافظات، دفع، عملات، تقييمات) |
| `POST /api/orders` | إنشاء طلب — `{site,name,phone,country_id,governorate_id,area,address,payment_method,currency,coupon,note,utm,items:[{product_id,qty,options:[{name,label}],upsell}],fbp,fbc,page_url}` |
| `POST /api/leads` | طلب غير مكتمل `{site,product_id,name,phone,utm}` |
| `POST /api/track` | تتبّع `{site,order_no,phone}` |
| `POST /api/reviews` | تقييم (بانتظار الموافقة) |
| `POST /api/subscribe` | اشتراك (يرجع الكود الترحيبي إن وجد) |
| `POST /api/restock` | «نبّهني لما يرجع» |
| `POST /api/coupon` | فحص كوبون للعرض فقط |

لوحة التحكم تتعامل مع Supabase مباشرة بحساب الموظف (RLS يحمي البيانات)، والعمليات الحساسة عبر الدوال: `set_order_status`، `adjust_stock`، `settle_courier`.

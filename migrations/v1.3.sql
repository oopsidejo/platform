-- شغّل هذا فقط إذا كنت شغّلت schema.sql قبل 2026-11-11 الظهر
alter table reviews add column if not exists video text;

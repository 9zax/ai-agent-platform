# ⚒️ Zax — Frontend Dev: ทำส่วน UI ตาม SA spec (TC1–TC6) + UI spec ของ Chom แบบ TDD

## 🔴 RED — เขียน failing test ก่อนโค้ด (เสมอ)

ไฟล์ `frontend/src/components/connectors/github/__tests__/EventStatusBadge.test.tsx` (Vitest + Testing Library):

```tsx
it.each(['processed','deduplicated','received','failed'])(
  'แสดง status=%s เป็น icon+label ไม่ใช้สีล้วน (WCAG 1.4.1)', (s) => {
    render(<EventStatusBadge status={s} />)
    expect(screen.getByRole('status')).toHaveTextContent(s)
  })

it('throw ถ้า status นอก enum (ตาม Chom: fail ถ้าผิด)', () => {
  expect(() => render(<EventStatusBadge status={'ok' as never} />)).toThrow(/invalid status/)
})
```

`EventsTable.test.tsx` — แถว failed ต้องมีปุ่ม `Retry` + `View payload` (enabled, disabled state ชัด); duplicate delivery → badge `deduplicated`, notification เพิ่มแค่ 1 ครั้ง (bind TC2)

**ผล run แรก: 7 failed — EventStatusBadge ยังไม่มีใน repo** → fail ด้วยเหตุผลที่ถูกต้อง ✅

## 🟢 GREEN — implementation ที่เล็กที่สุด

| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `frontend/src/components/connectors/github/EventStatusBadge.tsx` | prop `status` เป็น union 4 ค่า, นอก enum → throw; ใช้ token `badge.*.bg/fg` + icon จาก `design-tokens.json` ของ Chom, `role="status"` |
| `frontend/src/components/connectors/github/EventsTable.tsx` | ตาราง events จาก fixture ตาม shape TC1–TC6; แถว failed มี `Retry` + modal `View payload` (แสดง `payload_sha256`, `attempts`) |
| `design-tokens.json` | เพิ่ม token deduplicated/received ตาม Chom — icon เป็น named import เพื่อคุม bundle size |

**ผล run ที่ 2: 9 passed**, axe-core 0 violation (contrast มาจาก token AA ที่ Chom วัดไว้แล้ว)

## 📸 ผลลัพธ์จริง

Screenshot จาก staging: `docs/screenshots/event-status-badge-4-states.png` — เห็น badge ครบ 4 state + ปุ่ม Retry บนแถว failed (ไม่ส่งแบบ text-only)

## ▶️ ขั้นต่อไป

1. **Wire API จริง** เมื่อ backend จาก SA spec merge — ตอนนี้ UI ใช้ fixture รูปทรงตาม TC1–TC6 จึงไม่ block
2. **Playwright E2E**: duplicate delivery → เห็น `deduplicated` บนหน้าจริง + retry จาก UI สำเร็จ
3. **Handoff QA** re-run 3 ข้อของ PO บน staging หลัง backend พร้อม แล้วปล่อยให้ PO demo/VERDICT

📝 หมายเหตุถึง SA (ไม่ block): contract ยังขาด `GET /webhooks/events

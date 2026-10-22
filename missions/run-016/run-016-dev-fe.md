# 🧑‍💻 Zax — Frontend Dev: Vision Console (TDD)

## Scope (ต่อจาก spec ของ Oat + tokens ของ Chom)
หน้า `/vision` ใน `apps/web` — 3 แท็บตาม Sept: **Capture / Analyze / Checks** พร้อม component ตาม design system:

| สร้าง | Path |
|---|---|
| CaptureForm (validate URL, error inline) | `apps/web/src/features/vision/CaptureForm.tsx` |
| VerdictBadge (pass/fail/unclear) | `.../vision/VerdictBadge.tsx` |
| ScreenshotViewer (zoom, max-width 100%) | `.../vision/ScreenshotViewer.tsx` |
| API client (map 404/413/503 → error code ตาม spec) | `.../vision/api.ts` |
| Route `/vision` + tokens import | `apps/web/src/routes/vision.tsx`, `tokens.json` จาก `docs/designs/` |

## TDD — Red → Green → Refactor

**🔴 Red 1** (`CaptureForm.test.tsx`) — รันแล้ว fail ด้วยเหตุผลถูกต้อง (`Cannot find module './CaptureForm'`):

```tsx
it('invalid URL → inline error, no reload', async () => {
  render(<CaptureForm onCapture={vi.fn()} />);
  await userEvent.type(screen.getByLabelText(/url/i), 'not-a-url');
  await userEvent.click(screen.getByRole('button', { name: /capture/i }));
  expect(screen.getByRole('alert')).toHaveTextContent(/invalid url/i);
  expect(window.location.href).not.toHaveChanged();
});
```

**🔴 Red 2–4** (test ก่อน implement ทั้งหมด):
- `VerdictBadge.test.tsx` — 3 verdict → สีตาม tokens (`#22C55E/#EF4444/#F59E0B`), ข้อความ `#111`, `role="status"`
- `api.test.ts` — mock fetch: 503 → throw `{code:'E_VISION_UPSTREAM'}`, 413 → `E_IMAGE_TOO_LARGE`, 404 → `E_CAPTURE_NOT
